import defaults from '../../preferences.json';

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

async function archive(url: URL, env: Env): Promise<Response> {
  const query = (url.searchParams.get('q') || '').trim();
  const scope = url.searchParams.get('scope') || 'all';
  const unread = url.searchParams.get('unread') || '0';
  const limit = Number(url.searchParams.get('limit') || 30);
  if (query.length > 200 || !['all', 'saved'].includes(scope) || !['0', '1'].includes(unread)
    || !Number.isInteger(limit) || limit < 1 || limit > 100) return json({ error: 'Invalid article filters.' }, 422);
  const where: string[] = [], values: (string | number)[] = [];
  if (scope === 'saved') where.push('COALESCE(f.saved,0)=1');
  if (unread === '1') where.push('COALESCE(f.is_read,0)=0');
  if (query) {
    where.push("instr(lower(COALESCE(json_extract(a.item_json,'$.title'),'') || ' ' || COALESCE(json_extract(a.item_json,'$.source'),'') || ' ' || a.content),lower(?))>0");
    values.push(query);
  }
  const join = ' FROM articles a LEFT JOIN feedback f ON f.url=a.url';
  const filters = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = await env.DB.prepare('SELECT COUNT(*) AS n' + join + filters).bind(...values).first<{ n: number }>();
  const cursor = url.searchParams.get('cursor');
  if (cursor) {
    try {
      if (cursor.length > 8192) throw new Error();
      const data = JSON.parse(new TextDecoder().decode(decode64(cursor)));
      if (typeof data.date !== 'string' || data.date.length > 80 || !validUrl(data.url)) throw new Error();
      where.push('(a.published_at < ? OR (a.published_at = ? AND a.url < ?))');
      values.push(data.date, data.date, data.url);
    } catch { return json({ error: 'Invalid page cursor.' }, 422); }
  }
  const result = await env.DB.prepare('SELECT a.url,a.item_json,a.published_at,f.verdict,f.is_read,f.saved,f.updated_at AS feedback_updated_at' + join
    + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY a.published_at DESC,a.url DESC LIMIT ?').bind(...values, limit + 1).all<Json>();
  const page = result.results.slice(0, limit), last = page.at(-1);
  const counts = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM articles) AS all_count,(SELECT COUNT(*) FROM feedback WHERE saved=1) AS saved_count').first<{ all_count: number; saved_count: number }>();
  return json({ items: page.map(r => ({ ...JSON.parse(String(r.item_json)), feedback: r.feedback_updated_at ? { url: r.url, verdict: r.verdict, is_read: r.is_read, saved: r.saved, updated_at: r.feedback_updated_at } : null })),
    total: total?.n || 0, counts: { all: counts?.all_count || 0, saved: counts?.saved_count || 0 },
    next_cursor: result.results.length > limit && last ? encode64(encoder.encode(JSON.stringify({ date: last.published_at, url: last.url }))) : null });
}

function validArticles(articles: unknown, limit: number): articles is Json[] {
  return Array.isArray(articles) && articles.length <= limit && articles.every(a => a && validUrl(a.url) && typeof a.title === 'string' && typeof a.content === 'string' && a.content.length <= 24000 && typeof a.published_at === 'string');
}
async function upsertArticles(articles: Json[], env: Env) {
  const now = new Date().toISOString();
  const statements = articles.map(a => env.DB.prepare(
    'INSERT INTO articles(url,item_json,content,published_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET item_json=excluded.item_json,content=excluded.content,published_at=excluded.published_at,updated_at=excluded.updated_at',
  ).bind(a.url, JSON.stringify({ ...a, content: undefined }), a.content, a.published_at, now));
  for (let i = 0; i < statements.length; i += 40) await env.DB.batch(statements.slice(i, i + 40));
}
async function ingest(request: Request, env: Env): Promise<Response> {
  const data = await body(request);
  if (!validArticles(data.articles, 200)) return json({ error: 'Invalid articles.' }, 422);
  await upsertArticles(data.articles, env);
  return json({ ok: true, articles: data.articles.length });
}

async function publish(request: Request, env: Env): Promise<Response> {
  const data = await body(request);
  const digest = data.digest as Json | undefined;
  const articles = data.articles;
  if (!digest || !Array.isArray(digest.items) || !validArticles(articles, 300) || digest.items.length > 50
      || typeof digest.run_key !== 'string' || digest.run_key.length > 80 || !Number.isFinite(Date.parse(String(digest.generated_at)))) {
    return json({ error: 'Invalid digest.' }, 422);
  }
  const urls = new Set(articles.map(a => a.url));
  if (articles.some(a => !validUrl(a.url) || typeof a.title !== 'string' || typeof a.content !== 'string' || a.content.length > 24000)
      || (digest.items as Json[]).some(i => !validUrl(i.url) || !urls.has(i.url))) return json({ error: 'Invalid articles.' }, 422);
  await upsertArticles(articles, env);
  await env.DB.prepare(
    'INSERT INTO digests(run_key, generated_at, payload_json) VALUES (?, ?, ?) ON CONFLICT(run_key) DO UPDATE SET generated_at=excluded.generated_at, payload_json=excluded.payload_json',
  ).bind(digest.run_key, digest.generated_at, JSON.stringify(digest)).run();
  return json({ ok: true, articles: articles.length, items: digest.items.length });
}

async function readSettings(env: Env) {
  const row = await env.DB.prepare('SELECT settings_json, updated_at FROM reader_settings WHERE id=1').first<{ settings_json: string; updated_at: string }>();
  return { settings: row ? JSON.parse(row.settings_json) as typeof defaults : defaults, configured: Boolean(row), updated_at: row?.updated_at || null };
}

async function saveSettings(request: Request, env: Env): Promise<Response> {
  const patch = await body(request);
  const allowed = new Set(['theme', 'density', 'hide_read', 'topics']);
  if (!Object.keys(patch).length || Object.keys(patch).some(k => !allowed.has(k))) return json({ error: 'Unsupported setting.' }, 422);
  if (patch.theme !== undefined && (typeof patch.theme !== 'string' || !['light', 'dark'].includes(patch.theme))) return json({ error: 'Invalid theme.' }, 422);
  if (patch.density !== undefined && (typeof patch.density !== 'string' || !['compact', 'comfortable'].includes(patch.density))) return json({ error: 'Invalid density.' }, 422);
  if (patch.hide_read !== undefined && typeof patch.hide_read !== 'boolean') return json({ error: 'Invalid read preference.' }, 422);
  if (patch.topics !== undefined) {
    if (!Array.isArray(patch.topics) || patch.topics.length < 1 || patch.topics.length > 20) return json({ error: 'Choose 1 to 20 interests.' }, 422);
    const names = new Set<string>();
    const topics = [];
    for (const value of patch.topics) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return json({ error: 'Invalid interest.' }, 422);
      const topic = value as Json;
      if (typeof topic.name !== 'string' || typeof topic.description !== 'string') return json({ error: 'Interest name and description are required.' }, 422);
      const name = topic.name.trim(), description = topic.description.trim();
      if (!name || name.length > 40 || description.length < 10 || description.length > 2000 || names.has(name.toLowerCase())) return json({ error: 'Interests need unique names (1–40 characters) and descriptions (10–2000 characters).' }, 422);
      names.add(name.toLowerCase()); topics.push({ name, description });
    }
    patch.topics = topics;
  }
  // JSON merge runs in SQLite so concurrent partial updates preserve other keys.
  const initial = JSON.stringify({ ...defaults, ...patch });
  await env.DB.prepare('INSERT INTO reader_settings(id,settings_json,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET settings_json=json_patch(reader_settings.settings_json,?), updated_at=excluded.updated_at')
    .bind(initial, new Date().toISOString(), JSON.stringify(patch)).run();
  return json(await readSettings(env));
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  if (path === '/health' && request.method === 'GET') return json({ status: 'ok' });
  if (path === '/api/auth/login' && request.method === 'POST') return login(request, env);
  if (path.startsWith('/internal/')) {
    if (!await equalSecret(bearer(request), env.SYNC_TOKEN)) return json({ error: 'Unauthorized.' }, 401);
    if (path === '/internal/publish' && request.method === 'POST') return publish(request, env);
    if (path === '/internal/ingest' && request.method === 'POST') return ingest(request, env);
    if (path === '/internal/snapshot' && request.method === 'GET') {
      const articles = await env.DB.prepare('SELECT * FROM articles ORDER BY updated_at DESC LIMIT 300').all<Json>();
      const states = await env.DB.prepare('SELECT * FROM feedback').all();
      const profile = await env.DB.prepare("SELECT a.* FROM articles a JOIN feedback f ON a.url=f.url WHERE f.verdict IN ('useful', 'topic') ORDER BY f.updated_at DESC, a.url LIMIT 300").all<Json>();
      const unpack = (r: Json) => ({ ...JSON.parse(String(r.item_json)), content: r.content });
      const preferences = await readSettings(env);
      return json({ articles: articles.results.map(unpack), profile_articles: profile.results.map(unpack), feedback: states.results, settings: preferences.configured ? preferences.settings : null });
    }
    return json({ error: 'Not found.' }, 404);
  }
  if (!await authorized(request, env)) return json({ error: 'Please log in.' }, 401);
  if (path === '/api/auth/check' && request.method === 'GET') return json({ authenticated: true });
  if (path === '/api/settings' && request.method === 'GET') return json(await readSettings(env));
  if (path === '/api/settings' && request.method === 'POST') return saveSettings(request, env);
  if (path === '/api/feed' && request.method === 'GET') return feed(url, env);
  if (path === '/api/articles' && request.method === 'GET') return archive(url, env);
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
