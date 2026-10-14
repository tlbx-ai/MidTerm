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
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/file-refresh');
fs.mkdirSync(out, { recursive: true });
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-file-refresh-'));
const nested = path.join(fixtures, 'nested'); fs.mkdirSync(nested);
fs.writeFileSync(path.join(nested, 'keep.md'), '# Keep\n'); fs.writeFileSync(path.join(nested, 'size.txt'), 'a');
for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(fixtures, `file-${String(i).padStart(3, '0')}.txt`), 'root');
const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-refresh-other-'));
const result = { ok: false, fixtures, other, cases: [], errors: [], treeRequests: 0, eventStreams: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, browser, context, session, otherSession, page;
async function api(method, route, data) {
  const response = await context.request.fetch(url + route, { method, data });
  assert.ok(response.ok(), `${route}: ${response.status()} ${await response.text()}`);
  const raw = await response.text(); return raw ? JSON.parse(raw) : null;
}
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check',
  ], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) {
    try { const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break;
    } catch { await sleep(100); }
  }
  if (!browser) throw new Error('Chrome did not start');
  context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const eq = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]);
  let ready = false;
  for (let i = 0; i < 40; i++) { try { ready = (await context.request.get(url + '/api/version', { timeout: 2000 })).ok(); } catch {}
    if (ready) break; await sleep(1000); }
  if (!ready) throw new Error('Source did not become ready');
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 90, rows: 30, workingDirectory: fixtures, launchRequestId: crypto.randomUUID() })).id;
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => result.errors.push(error.message));
  page.on('request', request => { const u = new URL(request.url()); if (u.pathname === '/api/files/tree' && u.searchParams.get('sessionId') === session) result.treeRequests++;
    if (u.pathname === '/api/files/events' && u.searchParams.get('sessionId') === session) result.eventStreams++; });
  await page.route('**/api/files/events**', route => route.abort()); // Exercise manual refresh without the automatic watcher.
  await page.goto(url); await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();
  const wrapper = page.locator(`.session-wrapper[data-session-id="${session}"]`), files = wrapper.locator('.session-tab[data-tab="files"]'), terminal = wrapper.locator('.session-tab[data-tab="terminal"]');
  await files.click(); const tree = wrapper.locator('.file-browser-tree'), preview = wrapper.locator('.file-browser-preview');
  const node = name => tree.locator('.tree-node').filter({ has: page.locator('.tree-name', { hasText: new RegExp('^' + name.replace('.', '\\.') + '$') }) });
  const refresh = wrapper.locator('[data-browser-navigation="refresh"]');
  await node('nested').waitFor(); await node('nested').click(); await node('keep.md').click();
  await preview.locator('.file-document-mode[data-mode="edit"]').click();
  const editor = preview.locator('textarea'); await editor.fill('# Unsaved refresh draft\n');
  await node('keep.md').evaluate(e => { e.tabIndex = 0; e.focus({ preventScroll: true }); window.keptTreeRow = e; });
  await node('file-030.txt').evaluate(e => { window.keptRootRow = e; });
  await tree.evaluate(e => { e.scrollTop = 200; }); const beforeScroll = await tree.evaluate(e => e.scrollTop);
  fs.writeFileSync(path.join(nested, 'created.txt'), 'created'); fs.writeFileSync(path.join(nested, 'size.txt'), 'changed content length');
  await refresh.click(); await node('created.txt').waitFor();
  await page.waitForFunction(() => document.querySelector('.tree-node[data-path$="size.txt"] .tree-size')?.textContent === '22 B');
  assert.equal(await node('keep.md').evaluate(e => e === window.keptTreeRow), true);
  assert.equal(await node('file-030.txt').evaluate(e => e === window.keptRootRow), true);
  assert.equal(await tree.evaluate(e => e.scrollTop), beforeScroll);
  assert.equal(await editor.inputValue(), '# Unsaved refresh draft\n');
  assert.equal(await page.locator('.file-unsaved-overlay').count(), 0);
  result.cases.push('Manual refresh discovers actual child changes and fresh sizes while preserving row identity, selection, scroll and dirty editor');
  await node('keep.md').evaluate(e => e.focus({ preventScroll: true }));
  fs.writeFileSync(path.join(nested, 'second.txt'), 'second'); await refresh.click(); await node('second.txt').waitFor();
  // Refresh button was clicked, then focus the selected row during a refresh to prove reconciliation does not steal it.
  await node('keep.md').evaluate(e => e.focus({ preventScroll: true }));
  await refresh.evaluate(e => e.click()); await refresh.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[data-browser-navigation="refresh"]')?.disabled);
  assert.equal(await node('keep.md').evaluate(e => e === document.activeElement), true);
  result.cases.push('A refresh with existing row focus retains that focused DOM node');
  await node('nested').click(); fs.writeFileSync(path.join(nested, 'reopened.txt'), 'fresh reopen'); await node('nested').click(); await node('reopened.txt').waitFor();
  result.cases.push('Reopening a collapsed directory reloads its actual contents');
  await page.unroute('**/api/files/events**'); await terminal.click(); await files.click();
  await sleep(1500); const idleRequests = result.treeRequests; await sleep(1500);
  assert.equal(result.treeRequests, idleRequests);
  fs.writeFileSync(path.join(nested, 'automatic.txt'), 'watch event'); await node('automatic.txt').waitFor();
  result.cases.push('A real filesystem event updates an open subtree, with no periodic requests while idle');
  const beforeBurst = result.treeRequests;
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(nested, `burst-${i}.txt`), 'burst');
  await node('burst-19.txt').waitFor(); await sleep(700);
  assert.ok(result.treeRequests - beforeBurst <= 6, `Event burst caused ${result.treeRequests - beforeBurst} requests`);
  fs.renameSync(path.join(nested, 'automatic.txt'), path.join(nested, 'renamed.txt')); await node('renamed.txt').waitFor(); await node('automatic.txt').waitFor({ state: 'hidden' });
  fs.unlinkSync(path.join(nested, 'renamed.txt')); await node('renamed.txt').waitFor({ state: 'hidden' });
  assert.equal(await editor.inputValue(), '# Unsaved refresh draft\n');
  result.cases.push('Create bursts are coalesced; external rename/delete updates the subtree without disturbing the draft');
  await preview.locator('.preview-save-btn').click(); await page.waitForFunction(() => document.querySelector('.file-browser-preview .file-save-status')?.dataset.fileSaveState === 'saved');
  otherSession = (await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 90, rows: 30, workingDirectory: other, launchRequestId: crypto.randomUUID() })).id;
  await page.locator(`.session-item[data-session-id="${otherSession}"] .session-title`).click(); await sleep(250);
  const inactiveRequests = result.treeRequests; fs.writeFileSync(path.join(nested, 'inactive.txt'), 'inactive event'); await sleep(1000);
  assert.equal(result.treeRequests, inactiveRequests);
  await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click(); await node('inactive.txt').waitFor();
  result.cases.push('Inactive sessions stop watching; reactivation refreshes the retained expanded tree');
  await page.screenshot({ path: path.join(out, 'refreshed-tree.png') });
  assert.deepEqual(result.errors, []); result.ok = true;
} catch (error) {
  result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>');
  if (page) { await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    result.pageText = (await page.locator('body').innerText().catch(() => '')).slice(-2500); }
  process.exitCode = 1;
} finally {
  if (context && session) { try { for (const id of [session, otherSession].filter(Boolean)) await api('DELETE', '/api/sessions/' + id); }
    catch (error) { result.cleanupFailure = String(error).replaceAll(cookie, '<redacted-session-cookie>'); result.ok = false; process.exitCode = 1; } }
  await context?.close(); await browser?.close(); chrome?.kill();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, cases: result.cases, treeRequests: result.treeRequests, eventStreams: result.eventStreams, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
