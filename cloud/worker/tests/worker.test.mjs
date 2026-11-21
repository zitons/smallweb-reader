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
    for (const migration of ['0001_reader.sql', '0002_settings.sql', '0003_article_archive.sql']) {
      const sql = await readFile('migrations/' + migration, 'utf8');
      for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
    }
    const call = (path, { token, origin, body, method } = {}) => mf.dispatchFetch('https://reader.test' + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal((await call('/api/feed')).status, 401);
    assert.equal((await call('/api/articles')).status, 401);
    assert.equal((await call('/api/settings')).status, 401);
    assert.equal((await call('/api/settings', { body: { theme: 'light' } })).status, 401);
    assert.equal((await call('/api/auth/login', { origin: 'https://evil.test', body: { password: 'test-password' } })).status, 403);
    assert.equal((await call('/api/auth/login', { body: { password: 'wrong' } })).status, 401);
    const auth = await call('/api/auth/login', { origin: 'https://example.github.io', body: { password: 'test-password' } });
    assert.equal(auth.headers.get('Access-Control-Allow-Origin'), 'https://example.github.io');
    const { token } = await auth.json();
    assert.equal((await call('/internal/snapshot', { token })).status, 401);
    assert.equal((await call('/api/feed', { token: 'test-sync-secret' })).status, 401);
    assert.equal((await call('/api/settings', { token: 'test-sync-secret' })).status, 401);
    assert.equal((await call('/api/articles', { token: 'test-sync-secret' })).status, 401);
    assert.equal((await call('/internal/ingest', { token, body: { articles: [] } })).status, 401);
    const defaults = await (await call('/api/settings', { token })).json();
    assert.equal(defaults.configured, false);
    assert.equal(defaults.settings.theme, 'dark');
    assert.equal(defaults.settings.topics.length, 8);
    const topics = [{ name: ' Language learning ', description: ' Comprehensible input and second language acquisition. ' }];
    assert.equal((await call('/api/settings', { token, body: { density: 'comfortable', hide_read: true, topics } })).status, 200);
    assert.equal((await call('/api/settings', { token, body: { theme: 'light' } })).status, 200);
    const settings = await (await call('/api/settings', { token })).json();
    assert.equal(settings.configured, true);
    assert.equal(settings.settings.density, 'comfortable', 'partial theme update must preserve other settings');
    assert.equal(settings.settings.hide_read, true);
    assert.equal(settings.settings.topics[0].name, 'Language learning');
    const synced = await (await call('/internal/snapshot', { token: 'test-sync-secret' })).json();
    assert.deepEqual(synced.settings.topics, settings.settings.topics);
    for (const invalid of [{ topics: [] }, { topics: [topics[0], topics[0]] }, { topics: [{ name: 'A', description: 'short' }] }, { theme: ['dark'] }, { hide_read: 'false' }, { density: 'huge' }, { api_key: 'unsupported' }]) {
      assert.equal((await call('/api/settings', { token, body: invalid })).status, 422);
    }
    assert.deepEqual((await (await call('/api/settings', { token })).json()).settings, settings.settings, 'invalid writes leave preferences unchanged');
    const article = { url: 'https://blog.test/a', title: 'A real article', content: 'Full source excerpt', summary: 'Source excerpt', source: 'blog.test', published_at: new Date().toISOString(), category: 'Education' };
    const digest = { run_key: '2026-11-20', generated_at: new Date().toISOString(), items: [article], topics: ['Education'], candidate_count: 1 };
    const payload = { articles: [article], digest };
    assert.equal((await call('/internal/publish', { token: 'test-sync-secret', body: payload })).status, 200);
    assert.equal((await call('/internal/publish', { token: 'test-sync-secret', body: payload })).status, 200);
    const archiveOnly = Array.from({ length: 65 }, (_, i) => ({ ...article, url: `https://archive.test/${String(i).padStart(3, '0')}`, title: `Archive-only ${i}`, published_at: i === 64 ? '2020-01-01T00:00:00+00:00' : article.published_at }));
    assert.equal((await call('/internal/ingest', { token: 'test-sync-secret', body: { articles: archiveOnly } })).status, 200);
    assert.equal((await call('/internal/ingest', { token: 'test-sync-secret', body: { articles: archiveOnly } })).status, 200);
    let cursor = null;
    const archivedUrls = [];
    do {
      const page = await (await call('/api/articles?limit=10' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { token })).json();
      assert.equal(page.total, 66);
      assert.equal(page.counts.all, 66);
      archivedUrls.push(...page.items.map(a => a.url));
      cursor = page.next_cursor;
    } while (cursor);
    assert.equal(new Set(archivedUrls).size, 66, 'stable cursors must visit every article even when dates tie');
    assert.equal(archivedUrls.length, 66);
    const oldArticle = await (await call('/api/articles?q=Archive-only%2064', { token })).json();
    assert.equal(oldArticle.total, 1, 'search must include old articles outside daily selections and recent pools');
    assert.equal(oldArticle.items[0].url, archiveOnly[64].url);
    for (const path of ['/api/articles?limit=101', '/api/articles?cursor=invalid', '/api/articles?scope=unknown']) assert.equal((await call(path, { token })).status, 422);
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
    assert.equal(snapshot.profile_articles.length, 0, 'quality feedback must not train the interest profile');
    assert.equal((await (await call('/api/library', { token })).json()).items.length, 1);
    await feedback('useful');
    await db.prepare('UPDATE articles SET updated_at=? WHERE url=?').bind('2020-01-01', article.url).run();
    const filler = Array.from({ length: 301 }, (_, i) => db.prepare('INSERT INTO articles(url,item_json,content,published_at,updated_at) VALUES(?,?,?,?,?)').bind(
      `https://new.test/${i}`, JSON.stringify({ ...article, url: `https://new.test/${i}` }), 'New content', '2026-11-20', '2099-01-01'));
    for (let i = 0; i < filler.length; i += 40) await db.batch(filler.slice(i, i + 40));
    const aged = await (await call('/internal/snapshot', { token: 'test-sync-secret' })).json();
    assert.equal(aged.articles.some(a => a.url === article.url), false);
    assert.equal(aged.profile_articles[0].url, article.url);
    assert.equal(aged.profile_articles[0].content, article.content);
    await feedback('clear'); await feedback('unread');
    assert.equal((await (await call('/internal/snapshot', { token: 'test-sync-secret' })).json()).profile_articles.length, 0, 'undo removes a profile sample');
    feed = await (await call(`/api/feed?digest=${originalId}`, { token })).json();
    assert.equal(feed.digest.items[0].feedback.verdict, null);
    assert.equal(feed.digest.items[0].feedback.is_read, 0);
    await feedback('unsave');
    assert.equal((await (await call('/api/library', { token })).json()).items.length, 0);
    const archiveFeedback = action => call('/api/feedback', { token, body: { url: archiveOnly[64].url, action } });
    assert.equal((await archiveFeedback('useful')).status, 200, 'an unselected old article can train interests');
    assert.equal((await (await call('/api/articles?q=Archive-only%2064&unread=1', { token })).json()).total, 0);
    await archiveFeedback('save');
    const savedArchive = await (await call('/api/articles?scope=saved', { token })).json();
    assert.equal(savedArchive.total, 1);
    assert.equal(savedArchive.items[0].url, archiveOnly[64].url);
    assert.equal((await call('/api/feed', { token: token.slice(0, -2) + 'xx' })).status, 401);
    for (let i = 0; i < 11; i++) await call('/api/auth/login', { body: { password: 'wrong' } });
    assert.equal((await call('/api/auth/login', { body: { password: 'test-password' } })).status, 429);
  } finally { await mf.dispose(); }
});
