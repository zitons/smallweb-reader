interface Env {
  DB: D1Database;
  AUTH_PASSWORD: string;
  SESSION_SECRET: string;
  SYNC_TOKEN: string;
  ALLOWED_ORIGINS: string;
}

type Json = Record<string, unknown>;
const encoder = new TextEncoder();
const actions = new Set(['useful', 'topic', 'quality', 'known', 'clear', 'read', 'unread', 'save', 'unsave']);

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

async function body(request: Request): Promise<Json> {
  if (Number(request.headers.get('Content-Length') || 0) > 2_000_000) throw new Error('body_too_large');
  const text = await request.text();
  if (encoder.encode(text).length > 2_000_000) throw new Error('body_too_large');
  const data: unknown = JSON.parse(text);
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('invalid_body');
  return data as Json;
}

function bearer(request: Request): string {
  return request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
}

async function equalSecret(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', encoder.encode(s))));
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}

function encode64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decode64(text: string): Uint8Array {
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function session(secret: string): Promise<string> {
  const payload = encode64(encoder.encode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 43_200, nonce: crypto.randomUUID() })));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(payload));
  return `${payload}.${encode64(new Uint8Array(signature))}`;
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  try {
    if (!env.SESSION_SECRET) return false;
    const parts = bearer(request).split('.');
    if (parts.length !== 2) return false;
    const [payload, signature] = parts;
    const valid = await crypto.subtle.verify('HMAC', await signingKey(env.SESSION_SECRET), decode64(signature), encoder.encode(payload));
    const data = JSON.parse(new TextDecoder().decode(decode64(payload)));
    return valid && typeof data.exp === 'number' && data.exp > Date.now() / 1000;
  } catch { return false; }
}

function validUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
}

async function login(request: Request, env: Env): Promise<Response> {
  if (!env.AUTH_PASSWORD || !env.SESSION_SECRET) return json({ error: 'Login has not been configured.' }, 503);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const hash = encode64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(ip))));
  const now = Math.floor(Date.now() / 1000);
  const bucket = `${hash}:${Math.floor(now / 600)}`;
  const counter = await env.DB.prepare(
    'INSERT INTO login_attempts(bucket, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts',
  ).bind(bucket, now + 1200).first<{ attempts: number }>();
  if ((counter?.attempts || 0) > 10) return json({ error: 'Too many attempts. Try again in 10 minutes.' }, 429);
  if (counter?.attempts === 1) await env.DB.prepare('DELETE FROM login_attempts WHERE expires_at < ?').bind(now).run();
  const data = await body(request);
  if (typeof data.password !== 'string' || !await equalSecret(data.password, env.AUTH_PASSWORD)) return json({ error: 'Incorrect password.' }, 401);
  return json({ token: await session(env.SESSION_SECRET), expires_in: 43_200 });
}

async function feed(url: URL, env: Env): Promise<Response> {
  const id = url.searchParams.get('digest');
  const row = id && id !== 'latest'
    ? await env.DB.prepare('SELECT * FROM digests WHERE id = ?').bind(Number(id)).first<Json>()
    : await env.DB.prepare('SELECT * FROM digests ORDER BY generated_at DESC, id DESC LIMIT 1').first<Json>();
  const history = await env.DB.prepare('SELECT id, run_key, generated_at FROM digests ORDER BY generated_at DESC, id DESC LIMIT 60').all();
  if (!row) return json({ digest: null, history: history.results });
  const payload = JSON.parse(String(row.payload_json));
  const states = await env.DB.prepare('SELECT * FROM feedback').all<Json>();
  const byUrl = new Map(states.results.map(x => [x.url, x]));
  payload.items = payload.items.map((item: Json) => ({ ...item, feedback: byUrl.get(item.url) || null }));
  return json({ digest: { ...payload, id: row.id }, history: history.results });
}

async function feedback(request: Request, env: Env): Promise<Response> {
  const data = await body(request);
  if (!validUrl(data.url) || typeof data.action !== 'string' || !actions.has(data.action)) return json({ error: 'Invalid article or feedback action.' }, 422);
  const article = await env.DB.prepare('SELECT url FROM articles WHERE url = ?').bind(data.url).first();
  if (!article) return json({ error: 'Article not found.' }, 404);
  let column: string, value: string | number | null;
  if (['useful', 'topic', 'quality', 'known', 'clear'].includes(data.action)) {
    column = 'verdict'; value = data.action === 'clear' ? null : data.action;
  } else if (['save', 'unsave'].includes(data.action)) {
    column = 'saved'; value = data.action === 'save' ? 1 : 0;
  } else {
    column = 'is_read'; value = data.action === 'read' ? 1 : 0;
  }
  const now = new Date().toISOString();
  const readAlso = ['topic', 'quality', 'known', 'useful'].includes(data.action);
  const sql = `INSERT INTO feedback(url, ${column}, updated_at${readAlso ? ', is_read' : ''}) VALUES (?, ?, ?${readAlso ? ', 1' : ''}) ON CONFLICT(url) DO UPDATE SET ${column}=excluded.${column}, updated_at=excluded.updated_at${readAlso ? ', is_read=1' : ''}`;
  await env.DB.batch([
    env.DB.prepare(sql).bind(data.url, value, now),
    env.DB.prepare('INSERT INTO feedback_events(url, action, created_at) VALUES (?, ?, ?)').bind(data.url, data.action, now),
  ]);
  return json({ feedback: await env.DB.prepare('SELECT * FROM feedback WHERE url = ?').bind(data.url).first() });
}

async function publish(request: Request, env: Env): Promise<Response> {
  const data = await body(request);
  const digest = data.digest as Json | undefined;
  const articles = data.articles as Json[] | undefined;
  if (!digest || !Array.isArray(digest.items) || !Array.isArray(articles) || articles.length > 300 || digest.items.length > 50
      || typeof digest.run_key !== 'string' || digest.run_key.length > 80 || !Number.isFinite(Date.parse(String(digest.generated_at)))) {
    return json({ error: 'Invalid digest.' }, 422);
  }
  const urls = new Set(articles.map(a => a.url));
  if (articles.some(a => !validUrl(a.url) || typeof a.title !== 'string' || typeof a.content !== 'string' || a.content.length > 24000)
      || (digest.items as Json[]).some(i => !validUrl(i.url) || !urls.has(i.url))) return json({ error: 'Invalid articles.' }, 422);
  const now = new Date().toISOString();
  const statements = articles.map(a => env.DB.prepare(
    'INSERT INTO articles(url, item_json, content, published_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET item_json=excluded.item_json, content=excluded.content, published_at=excluded.published_at, updated_at=excluded.updated_at',
  ).bind(a.url, JSON.stringify({ ...a, content: undefined }), a.content, String(a.published_at || ''), now));
  for (let i = 0; i < statements.length; i += 40) await env.DB.batch(statements.slice(i, i + 40));
  await env.DB.prepare(
    'INSERT INTO digests(run_key, generated_at, payload_json) VALUES (?, ?, ?) ON CONFLICT(run_key) DO UPDATE SET generated_at=excluded.generated_at, payload_json=excluded.payload_json',
  ).bind(digest.run_key, digest.generated_at, JSON.stringify(digest)).run();
  return json({ ok: true, articles: articles.length, items: digest.items.length });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  if (path === '/health' && request.method === 'GET') return json({ status: 'ok' });
  if (path === '/api/auth/login' && request.method === 'POST') return login(request, env);
  if (path.startsWith('/internal/')) {
    if (!await equalSecret(bearer(request), env.SYNC_TOKEN)) return json({ error: 'Unauthorized.' }, 401);
    if (path === '/internal/publish' && request.method === 'POST') return publish(request, env);
    if (path === '/internal/snapshot' && request.method === 'GET') {
      const articles = await env.DB.prepare('SELECT * FROM articles ORDER BY updated_at DESC LIMIT 300').all<Json>();
      const states = await env.DB.prepare('SELECT * FROM feedback').all();
      return json({ articles: articles.results.map(r => ({ ...JSON.parse(String(r.item_json)), content: r.content })), feedback: states.results });
    }
    return json({ error: 'Not found.' }, 404);
  }
  if (!await authorized(request, env)) return json({ error: 'Please log in.' }, 401);
  if (path === '/api/auth/check' && request.method === 'GET') return json({ authenticated: true });
  if (path === '/api/feed' && request.method === 'GET') return feed(url, env);
  if (path === '/api/feedback' && request.method === 'POST') return feedback(request, env);
  if (path === '/api/library' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT a.item_json, f.* FROM feedback f JOIN articles a ON a.url=f.url WHERE f.saved=1 ORDER BY f.updated_at DESC LIMIT 500').all<Json>();
    return json({ items: rows.results.map(r => ({ ...JSON.parse(String(r.item_json)), feedback: { ...r, item_json: undefined } })) });
  }
  return json({ error: 'Not found.' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
    if (origin && !allowed.includes(origin)) return json({ error: 'Origin not allowed.' }, 403);
    let response: Response;
    if (request.method === 'OPTIONS') response = new Response(null, { status: 204 });
    else {
      try { response = await route(request, env); }
      catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message === 'body_too_large') response = json({ error: 'Request is too large.' }, 413);
        else if (error instanceof SyntaxError || message === 'invalid_body') response = json({ error: 'Invalid JSON body.' }, 400);
        else { console.error('Reader API error', message); response = json({ error: 'The request could not be completed.' }, 500); }
      }
    }
    if (origin) {
      response.headers.set('Access-Control-Allow-Origin', origin);
      response.headers.set('Vary', 'Origin');
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.headers.set('Access-Control-Max-Age', '600');
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
