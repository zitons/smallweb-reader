import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

test('reader authentication, publication, feedback and sync persist in real D1', async () => {
  const mf = new Miniflare({
    modules: true, scriptPath: '.test-build/index.js', compatibilityDate: '2026-08-01',
    d1Databases: ['DB'], bindings: {
      AUTH_PASSWORD: 'test-password', SESSION_SECRET: 'test-session-secret-long',
      SYNC_TOKEN: 'test-sync-secret', ALLOWED_ORIGINS: 'https://example.github.io',
    },
  });
  try {
    const db = await mf.getD1Database('DB');
    const sql = await readFile('migrations/0001_reader.sql', 'utf8');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
    const call = (path, { token, origin, body, method } = {}) => mf.dispatchFetch('https://reader.test' + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal((await call('/api/feed')).status, 401);
    assert.equal((await call('/api/auth/login', { origin: 'https://evil.test', body: { password: 'test-password' } })).status, 403);
    assert.equal((await call('/api/auth/login', { body: { password: 'wrong' } })).status, 401);
    const auth = await call('/api/auth/login', { origin: 'https://example.github.io', body: { password: 'test-password' } });
    assert.equal(auth.headers.get('Access-Control-Allow-Origin'), 'https://example.github.io');
    const { token } = await auth.json();
    assert.equal((await call('/internal/snapshot', { token })).status, 401);
    assert.equal((await call('/api/feed', { token: 'test-sync-secret' })).status, 401);
    const article = { url: 'https://blog.test/a', title: 'A real article', content: 'Full source excerpt', summary: 'Source excerpt', source: 'blog.test', published_at: new Date().toISOString(), category: 'Education' };
    const digest = { run_key: '2026-11-20', generated_at: new Date().toISOString(), items: [article], topics: ['Education'], candidate_count: 1 };
    const payload = { articles: [article], digest };
    assert.equal((await call('/internal/publish', { token: 'test-sync-secret', body: payload })).status, 200);
    assert.equal((await call('/internal/publish', { token: 'test-sync-secret', body: payload })).status, 200);
    let feed = await (await call('/api/feed', { token })).json();
    assert.equal(feed.history.length, 1, 'retry must not create a duplicate daily digest');
    const originalId = feed.digest.id;
    const feedback = action => call('/api/feedback', { token, body: { url: article.url, action } });
    assert.equal((await call('/api/feedback', { token, body: { url: 'https://unknown.test/a', action: 'useful' } })).status, 404);
    for (const action of ['save', 'useful', 'useful', 'quality']) assert.equal((await feedback(action)).status, 200);
    const snapshot = await (await call('/internal/snapshot', { token: 'test-sync-secret' })).json();
    assert.equal(snapshot.feedback.length, 1, 'repeated feedback is one preference, not extra votes');
    assert.equal(snapshot.feedback[0].verdict, 'quality');
    assert.equal(snapshot.feedback[0].saved, 1);
    assert.equal(snapshot.feedback[0].is_read, 1);
    assert.equal((await (await call('/api/library', { token })).json()).items.length, 1);
    await feedback('clear'); await feedback('unread');
    feed = await (await call(`/api/feed?digest=${originalId}`, { token })).json();
    assert.equal(feed.digest.items[0].feedback.verdict, null);
    assert.equal(feed.digest.items[0].feedback.is_read, 0);
    await feedback('unsave');
    assert.equal((await (await call('/api/library', { token })).json()).items.length, 0);
    assert.equal((await call('/api/feed', { token: token.slice(0, -2) + 'xx' })).status, 401);
    for (let i = 0; i < 11; i++) await call('/api/auth/login', { body: { password: 'wrong' } });
    assert.equal((await call('/api/auth/login', { body: { password: 'test-password' } })).status, 429);
  } finally { await mf.dispose(); }
});
