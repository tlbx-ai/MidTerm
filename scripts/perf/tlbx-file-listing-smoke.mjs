import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('../../docs/marketing/ScreenshotAutomation/node_modules/playwright');
const url = process.env.TLBX_PERF_URL, cookie = process.env.TLBX_COOKIE_HEADER;
if (!url || !cookie) throw new Error('Source URL and authenticated cookie required');
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/file-listing');
fs.mkdirSync(out, { recursive: true });
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-file-listing-'));
fs.mkdirSync(path.join(fixtures, 'nested'));
fs.mkdirSync(path.join(fixtures, 'large'));
fs.writeFileSync(path.join(fixtures, 'nested', 'child.txt'), 'child\n');
for (const [name, size, date] of [
  ['file10.txt', 10, '2025-01-01'], ['file2.txt', 2, '2025-02-01'],
  ['Öffentlicher Plan.PDF', 100, '2026-01-01'], ['empty.txt', 0, '2025-03-01'],
]) {
  const target = path.join(fixtures, name);
  fs.writeFileSync(target, 'x'.repeat(size));
  fs.utimesSync(target, new Date(date), new Date(date));
}
for (let i = 1; i <= 600; i++) fs.writeFileSync(path.join(fixtures, 'large', `item${i}.txt`), String(i));
const result = { ok: false, fixtures, cases: [], errors: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, browser, context, page, session;
async function api(method, route, data) {
  const response = await context.request.fetch(url + route, { method, data });
  assert.ok(response.ok(), `${route}: ${response.status()}`);
  const raw = await response.text(); return raw ? JSON.parse(raw) : null;
}
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check',
  ], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) {
    try {
      const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break;
    } catch { await sleep(100); }
  }
  if (!browser) throw new Error('Chrome did not start');
  context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 }, hasTouch: true });
  const eq = cookie.indexOf('=');
  await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]);
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 90, rows: 30, workingDirectory: fixtures, launchRequestId: crypto.randomUUID() })).id;
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.errors.push(error.message));
  await page.goto(url);
  await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();
  const wrapper = page.locator(`.session-wrapper[data-session-id="${session}"]`);
  await wrapper.locator('.session-tab[data-tab="files"]').click();
  const tree = wrapper.locator('.file-browser-tree');
  const row = name => tree.locator('.tree-node').filter({ has: page.locator('.tree-name', { hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) });
  const names = () => tree.locator('.tree-name').evaluateAll(nodes => nodes.filter(n => !n.closest('.tree-children[hidden]')).map(n => n.textContent).filter(name => name !== '.tlbx'));
  const chosen = root => root.locator('[aria-selected="true"]').evaluateAll(nodes => nodes.filter(n => !n.closest('.tree-children[hidden]')).map(n => n.dataset.path.split(/[\\/]/).at(-1)));
  await row('file2.txt').waitFor();
  assert.deepEqual(await names(), ['large', 'nested', 'empty.txt', 'file2.txt', 'file10.txt', 'Öffentlicher Plan.PDF']);
  await row('nested').click(); await row('child.txt').waitFor();
  await row('file2.txt').locator('input').click();
  await tree.locator('[data-mode="details"]').click();
  assert.deepEqual(await chosen(tree), ['nested', 'file2.txt']);
  await row('file2.txt').click();
  assert.equal(await wrapper.locator('.file-browser-preview textarea').count(), 0);
  await tree.locator('[data-mode="icons"]').click();
  assert.deepEqual(await chosen(tree), ['file2.txt']);
  await tree.locator('[data-mode="tree"]').click();
  await row('child.txt').waitFor();
  result.cases.push('Natural names, folders first, view-switch selection and retained tree expansion');
  await tree.locator('[data-mode="details"]').click();
  const filter = tree.locator('.file-listing-filter'), sort = tree.locator('.file-listing-sort');
  await filter.fill('pdf');
  assert.deepEqual(await names(), ['Öffentlicher Plan.PDF']);
  await filter.fill('missing');
  await tree.getByText('No loaded entries match this filter.').waitFor();
  assert.equal(await tree.locator('[data-selection-action="open"]').isDisabled(), true);
  await filter.fill('');
  assert.deepEqual(await chosen(tree), ['file2.txt']);
  await sort.selectOption('modified'); await tree.locator('.file-listing-direction').click();
  assert.deepEqual((await names()).slice(2), ['Öffentlicher Plan.PDF', 'empty.txt', 'file2.txt', 'file10.txt']);
  assert.ok((await row('Öffentlicher Plan.PDF').locator('.tree-modified').innerText()).includes('2026'));
  await sort.selectOption('size');
  assert.deepEqual((await names()).slice(2), ['Öffentlicher Plan.PDF', 'file10.txt', 'file2.txt', 'empty.txt']);
  await tree.locator('.file-listing-direction').click();
  assert.deepEqual((await names()).slice(2), ['empty.txt', 'file2.txt', 'file10.txt', 'Öffentlicher Plan.PDF']);
  await sort.selectOption('type');
  assert.equal(await sort.inputValue(), 'type');
  await page.screenshot({ path: path.join(out, 'details-1440.png') });
  assert.equal(await tree.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  result.cases.push('Local PDF/empty filters preserve selection; date, size, type and zero-byte metadata');
  await tree.locator('[data-mode="icons"]').click();
  await page.reload();
  await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();
  await wrapper.locator('.session-tab[data-tab="files"]').click();
  await tree.locator('.file-listing-icons').waitFor();
  assert.equal(await sort.inputValue(), 'type');
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator('#btn-mobile-strip-files').isVisible()) await page.locator('#btn-mobile-strip-files').tap();
  else { await page.locator('#btn-mobile-actions-menu').tap(); await page.locator('#btn-mobile-tab-files').tap(); }
  if (await wrapper.locator('.file-browser-back').isVisible()) await wrapper.locator('.file-browser-back').tap();
  await row('file2.txt').tap();
  assert.deepEqual(await chosen(tree), ['file2.txt']);
  assert.equal(await filter.evaluate(el => el.getBoundingClientRect().right <= innerWidth), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(out, 'icons-390.png') });
  result.cases.push('Context preferences survive reload; icon selection and controls fit a 390px touch viewport');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await wrapper.locator('.session-tab[data-tab="terminal"]').click();
  await page.evaluate(target => window.mmDebug.terminals.get(window.mmDebug.activeId).terminal._core._linkProviderService.linkProviders.at(-2)._handler(new MouseEvent('click'), target), fixtures);
  const modal = page.locator('#file-viewer-modal'), listRow = name => modal.locator('.file-list-item').filter({ has: page.locator('.file-name', { hasText: name }) });
  await listRow('file2.txt').click();
  await modal.locator('[data-mode="icons"]').click();
  assert.deepEqual(await chosen(modal), ['file2.txt']);
  await modal.locator('.file-listing-filter').fill('pdf');
  assert.equal(await modal.locator('.file-list-item').count(), 1);
  await modal.locator('.file-listing-filter').fill('');
  assert.deepEqual(await chosen(modal), ['file2.txt']);
  await listRow('large').dblclick();
  await modal.locator('.file-list-item').nth(599).waitFor();
  const start = Date.now();
  await modal.locator('.file-listing-filter').fill('item59');
  assert.equal(await modal.locator('.file-list-item').count(), 11);
  result.largeFilterMs = Date.now() - start;
  assert.ok(result.largeFilterMs < 3000);
  await modal.locator('.file-listing-filter').fill('');
  await modal.locator('[data-mode="details"]').click();
  const ordered = await modal.locator('.file-name').allTextContents();
  assert.equal(ordered[1], 'item2.txt'); assert.equal(ordered[599], 'item600.txt');
  await modal.locator('#file-viewer-dock-btn').click();
  const dock = page.locator('#file-viewer-dock');
  await dock.locator('.file-listing-details').waitFor();
  assert.equal(await dock.locator('.file-list-item').count(), 600);
  await dock.locator('.file-listing-filter').fill('item600');
  assert.equal(await dock.locator('.file-list-item').count(), 1);
  await page.screenshot({ path: path.join(out, 'directory-dock.png') });
  result.cases.push('Modal/dock share modes, metadata and local filtering; 600 real files retain natural sorting');
  assert.deepEqual(result.errors, []); result.ok = true;
} catch (error) {
  result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>');
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (context && session) try { await api('DELETE', '/api/sessions/' + session); } catch (error) { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; }
  await context?.close(); await browser?.close(); chrome?.kill();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, cases: result.cases, largeFilterMs: result.largeFilterMs, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
