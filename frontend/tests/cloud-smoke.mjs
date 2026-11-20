import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(process.env.READER_WEB_URL || 'http://127.0.0.1:4173/smallweb-reader/');
  await page.getByLabel('阅读密码').fill(process.env.READER_PASSWORD);
  await page.getByRole('button', { name: '进入阅读', exact: true }).click();
  await page.getByRole('heading', { name: '每日精选', exact: true }).waitFor();
  await page.locator('article').first().waitFor();
  const count = await page.locator('article').count();
  assert.ok(count > 0 && count <= 10);
  const article = page.locator('article').first();
  await article.getByRole('button', { name: '收藏', exact: true }).click();
  await article.getByRole('button', { name: '已收藏', exact: true }).waitFor();
  await page.reload();
  await page.locator('article').first().getByRole('button', { name: '已收藏', exact: true }).waitFor();
  await page.getByRole('button', { name: '收藏', exact: true }).first().click();
  await page.getByRole('heading', { name: '我的收藏', exact: true }).waitFor();
  await page.locator('article').first().getByRole('button', { name: '已收藏', exact: true }).click();
  await page.getByText('还没有收藏。读到想保留的文章时，点一下收藏。').waitFor();
  await page.getByRole('button', { name: '精选', exact: true }).click();
  await page.locator('article').first().waitFor();
  const first = page.locator('article').first();
  await first.getByRole('button', { name: '少推荐这类', exact: true }).click();
  await first.getByRole('button', { name: '已经了解', exact: true }).click();
  await first.getByText('已标记了解过', { exact: true }).waitFor();
  await first.getByRole('button', { name: '撤销评价', exact: true }).click();
  await first.getByRole('button', { name: '设为未读', exact: true }).click();
  await first.getByRole('button', { name: '标记已读', exact: true }).waitFor();
  await page.screenshot({ path: '../data/cloud/preview-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '../data/cloud/preview-mobile.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile layout must not overflow');
  assert.deepEqual(errors, []);
  console.log(`Cloud reader smoke passed: ${count} articles, login, persisted save, undo feedback, mobile layout.`);
} finally { await browser.close(); }
