import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// Use real article data; feedback writes stay inside this browser fixture.
const api = process.env.READER_API_URL || 'https://smallweb-reader-api.zitons.workers.dev';
const auth = { token: 'browser-fixture-session', expires_in: 43200 };
let fixture;
if (process.env.READER_UI_FIXTURE) fixture = JSON.parse(await readFile(process.env.READER_UI_FIXTURE, 'utf8'));
else {
 const authResponse = await fetch(api + '/api/auth/login', {
   method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'SmallWebReader/0.1' },
   body: JSON.stringify({ password: process.env.READER_PASSWORD }),
 });
 assert.equal(authResponse.status, 200);
 const session = await authResponse.json();
 const response = await fetch(api + '/api/feed', { headers: { Authorization: 'Bearer ' + session.token, 'User-Agent': 'SmallWebReader/0.1' } });
 assert.equal(response.status, 200);
 fixture = await response.json();
}
const articles = fixture.digest.items;
const states = new Map(articles.map(a => [a.url, { url: a.url, verdict: null, saved: 0, is_read: 0 }]));
let expireNextFeed = false;
let settings = JSON.parse(await readFile(new URL('../../cloud/preferences.json', import.meta.url), 'utf8'));
let settingsConfigured = false;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/feed' && expireNextFeed) {
      expireNextFeed = false;
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Session expired' }) });
    }
    let data;
    if (path === '/api/auth/login') data = auth;
    else if (path === '/api/settings') {
      if (route.request().method() === 'POST') { settings = { ...settings, ...route.request().postDataJSON() }; settingsConfigured = true; }
      data = { settings, configured: settingsConfigured, updated_at: settingsConfigured ? new Date().toISOString() : null };
    }
    else if (path === '/api/feed') data = { ...fixture, digest: { ...fixture.digest, items: articles.map(a => ({ ...a, feedback: states.get(a.url) })) } };
    else if (path === '/api/library') data = { items: articles.filter(a => states.get(a.url).saved).map(a => ({ ...a, feedback: states.get(a.url) })) };
    else if (path === '/api/feedback') {
      const { url, action } = route.request().postDataJSON();
      const state = states.get(url);
      assert.ok(state, 'feedback must reference a real article');
      if (['useful', 'topic', 'quality', 'known'].includes(action)) { state.verdict = action; state.is_read = 1; }
      else if (action === 'clear') state.verdict = null;
      else if (action === 'save' || action === 'unsave') state.saved = Number(action === 'save');
      else if (action === 'read' || action === 'unread') state.is_read = Number(action === 'read');
      else assert.fail('unexpected action: ' + action);
      data = { feedback: state };
    } else return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto(process.env.READER_WEB_URL || 'http://127.0.0.1:4173/smallweb-reader/');
  await page.getByLabel('阅读密码').fill(process.env.READER_PASSWORD);
  await page.getByRole('button', { name: '进入阅读', exact: true }).click();
  await page.getByRole('heading', { name: '每日精选', exact: true }).waitFor();
  await page.locator('article').first().waitFor();
  assert.equal(await page.locator('article').count(), articles.length);
  assert.ok(await page.locator('article').evaluateAll(rows => rows.filter(e => e.getBoundingClientRect().bottom <= innerHeight).length) >= 3, 'desktop should show several complete articles');
  assert.ok(await page.locator('.reader-app .btn').count(), 'must render Primer buttons');
  const first = page.locator('article').first();
  await first.getByRole('button', { name: '收藏', exact: true }).click();
  await first.getByRole('button', { name: '已收藏', exact: true }).waitFor();
  await page.reload();
  await page.locator('article').first().getByRole('button', { name: '已收藏', exact: true }).waitFor();
  await page.getByRole('button', { name: '收藏', exact: true }).first().click();
  await page.getByRole('heading', { name: '我的收藏' }).waitFor();
  await page.locator('article').first().waitFor();
  assert.equal(await page.locator('article').count(), 1);
  await page.locator('article').first().getByRole('button', { name: '已收藏', exact: true }).click();
  await page.getByText('还没有收藏。读到想保留的文章时，点一下收藏。').waitFor();
  await page.getByRole('button', { name: '精选', exact: true }).click();
  await first.waitFor();
  await first.getByRole('button', { name: '有收获', exact: true }).click();
  await first.getByText('已标记有收获', { exact: true }).waitFor();
  await first.getByRole('button', { name: '撤销评价', exact: true }).click();
  await first.getByRole('button', { name: '少推荐这类', exact: true }).click();
  await first.getByRole('button', { name: '已经了解', exact: true }).click();
  await first.getByText('已标记了解过', { exact: true }).waitFor();
  await first.getByRole('button', { name: '撤销评价', exact: true }).click();
  await first.getByRole('button', { name: '设为未读', exact: true }).click();
  await page.getByLabel('隐藏已读').check();
  assert.equal(await page.locator('article').count(), articles.length);
  await page.getByLabel('隐藏已读').uncheck();
  await page.locator('.profile-note summary').click();
  await page.locator('.profile-note[open] p').waitFor();
  await page.locator('.profile-note summary').click();
  await page.getByLabel('筛选文章').fill('Rationalists');
  assert.equal(await page.locator('article').count(), 1);
  await page.getByLabel('筛选文章').fill('');
  const excerpt = first.locator('.excerpt');
  await first.getByRole('button', { name: '展开摘录', exact: true }).click();
  assert.ok(await excerpt.evaluate(e => e.classList.contains('expanded')));
  await first.getByRole('button', { name: '收起摘录', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
  await page.getByLabel('阅读密度', { exact: true }).selectOption('comfortable');
  await page.getByLabel('默认隐藏已读', { exact: true }).check();
  await page.getByRole('textbox', { name: '兴趣 1 名称', exact: true }).fill('语言学习（设置测试）');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByText('已保存。阅读设置已生效，兴趣偏好将在下次每日更新时使用。', { exact: true }).waitFor();
  await page.reload();
  await page.locator('.reader-app.density-comfortable').waitFor();
  assert.equal(await page.getByLabel('隐藏已读', { exact: true }).isChecked(), true);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await page.getByLabel('阅读密度', { exact: true }).inputValue(), 'comfortable');
  assert.equal(await page.getByRole('textbox', { name: '兴趣 1 名称', exact: true }).inputValue(), '语言学习（设置测试）');
  await page.screenshot({ path: '../data/cloud/settings-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '../data/cloud/settings-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByLabel('阅读密度', { exact: true }).selectOption('compact');
  await page.getByLabel('默认隐藏已读', { exact: true }).uncheck();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByText('已保存。阅读设置已生效，兴趣偏好将在下次每日更新时使用。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回阅读', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('article button:disabled'));
  await page.getByRole('combobox').selectOption('latest');
  await page.evaluate(() => window.scrollTo(0, 0));
  if (await page.getByRole('button', { name: '切换浅色', exact: true }).isVisible()) await page.getByRole('button', { name: '切换浅色', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '../data/cloud/primer-desktop-light.png', fullPage: true, animations: 'disabled' });
  await page.screenshot({ path: '../data/cloud/primer-desktop-viewport.png' });
  await page.getByRole('button', { name: '切换深色', exact: true }).click();
  await page.screenshot({ path: '../data/cloud/primer-desktop-dark.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: '切换浅色', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '切换浅色', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '../data/cloud/primer-mobile.png', fullPage: true, animations: 'disabled' });
  await page.screenshot({ path: '../data/cloud/primer-mobile-viewport.png' });
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'layout overflow at ' + width);
  }
  expireNextFeed = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByLabel('阅读密码').waitFor();
  assert.equal(await page.getByRole('button', { name: '进入阅读', exact: true }).isEnabled(), true);
  await page.getByLabel('阅读密码').fill(process.env.READER_PASSWORD);
  await page.getByRole('button', { name: '进入阅读', exact: true }).click();
  await page.locator('article').first().waitFor();
  assert.deepEqual(errors, []);
  console.log('Primer reader passed: real articles, login, save/reload/unsave, feedback/undo, read controls, theme persistence, four viewport sizes, zero JS errors. Feedback writes were mocked.');
} finally { await browser.close(); }
