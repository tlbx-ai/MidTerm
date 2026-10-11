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
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/directory-navigation');
fs.mkdirSync(out, { recursive: true });
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-directory-navigation-'));
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-directory-isolated-'));
const isolatedFile = path.join(isolated, 'isolated.md'); fs.writeFileSync(isolatedFile, '# Isolated\n');
const child = path.join(fixtures, 'child'), nested = path.join(child, 'nested'), gone = path.join(fixtures, 'gone');
fs.mkdirSync(nested, { recursive: true }); fs.mkdirSync(gone);
for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(child, `file-${String(i).padStart(3, '0')}.md`), '# Original\n');
const result = { ok: false, fixtures, isolated, cases: [], errors: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, browser, context, session, page;
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
  for (let attempt = 0; attempt < 40; attempt++) {
    try { ready = (await context.request.get(url + '/api/version', { timeout: 2000 })).ok(); } catch { /* Source build may still be starting. */ }
    if (ready) break;
    await sleep(1000);
  }
  if (!ready) throw new Error('The source instance did not become reachable within the startup wait.');
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 80, rows: 30, workingDirectory: fixtures, launchRequestId: crypto.randomUUID() })).id;
  page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => result.errors.push(error.message));
  await page.goto(url);
  await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();
  const openPath = async target => page.evaluate(file => {
    const terminal = window.mmDebug.terminals.get(window.mmDebug.activeId).terminal;
    terminal._core._linkProviderService.linkProviders.at(-2)._handler(new MouseEvent('click'), file);
  }, target);
  const modal = page.locator('#file-viewer-modal'), body = modal.locator('.file-viewer-body');
  const back = modal.locator('[data-file-navigation="back"]'), forward = modal.locator('[data-file-navigation="forward"]'), up = modal.locator('[data-file-navigation="up"]');
  const title = modal.locator('.file-viewer-title');
  const waitTitle = async text => {
    await page.waitForFunction(name => document.querySelector('#file-viewer-modal .file-viewer-title')?.textContent === name, text);
    await body.locator('.file-list, textarea, .file-viewer-error').first().waitFor();
  };
  const choose = async name => modal.locator('.file-list-item').filter({ has: page.locator('.file-name', { hasText: new RegExp('^' + name.replace('.', '\\.') + '$') }) }).click();
  await openPath(child); await waitTitle('child');
  assert.equal(await back.isDisabled(), true); assert.equal(await up.isEnabled(), true);
  await modal.locator('.file-list-parent').click(); await waitTitle(path.basename(fixtures));
  assert.equal(await up.isDisabled(), true);
  assert.equal(await modal.locator('.file-list-parent').count(), 0);
  result.cases.push('A directly opened subdirectory has a real parent; the authorized root stops Up');
  await back.click(); await waitTitle('child');
  assert.equal(await forward.isEnabled(), true);
  await choose('nested'); await waitTitle('nested');
  assert.equal(await forward.isDisabled(), true);
  await up.click(); await waitTitle('child');
  await back.click(); await waitTitle('nested');
  await forward.click(); await waitTitle('child');
  result.cases.push('Back/Forward follow visits while Up follows hierarchy; a new visit drops the forward branch');
  await choose('file-060.md'); await waitTitle('file-060.md');
  const editor = modal.locator('textarea'); await editor.fill('# Navigation draft\n');
  await back.click();
  const dialog = page.locator('.file-unsaved-overlay'); await dialog.waitFor();
  await dialog.locator('[data-file-decision="cancel"]').click();
  assert.equal(await title.innerText(), 'file-060.md'); assert.equal(await editor.inputValue(), '# Navigation draft\n');
  await back.click(); await dialog.locator('[data-file-decision="save"]').click(); await waitTitle('child');
  assert.equal(fs.readFileSync(path.join(child, 'file-060.md'), 'utf8'), '# Navigation draft\n');
  assert.equal(await modal.locator('.file-list-item.selected .file-name').innerText(), 'file-060.md');
  assert.ok(await body.evaluate(e => e.scrollTop > 300));
  await page.screenshot({ path: path.join(out, 'restored-directory.png') });
  result.cases.push('Back from a dirty file guards the draft, writes before leaving and restores directory selection/scroll');
  await forward.click(); await waitTitle('file-060.md');
  assert.equal(await editor.inputValue(), '# Navigation draft\n');
  await up.click(); await waitTitle('child');
  result.cases.push('Forward reopens the actual saved document; Up from a file returns to its actual directory');
  await openPath(gone); await waitTitle('gone');
  await up.click(); await waitTitle(path.basename(fixtures));
  fs.rmdirSync(gone); // An empty, freshly created fixture; no recursive deletion.
  await back.click(); await waitTitle('gone');
  await body.locator('.file-viewer-error').waitFor();
  assert.equal(await forward.isEnabled(), true);
  await forward.click(); await waitTitle(path.basename(fixtures));
  result.cases.push('A deleted historical directory yields an error while retaining a usable forward return');
  const blocked = await context.request.get(url + '/api/files/navigation?' + new URLSearchParams({ path: path.dirname(fixtures), sessionId: session }));
  assert.equal(blocked.status(), 403);
  result.cases.push('Actual HTTP navigation denies the parent outside the session boundary');
  await api('POST', '/api/files/register', { sessionId: session, paths: [isolatedFile] });
  await openPath(isolatedFile); await waitTitle('isolated.md');
  assert.equal(await up.isDisabled(), true);
  const isolatedNavigation = await api('GET', '/api/files/navigation?' + new URLSearchParams({ path: isolatedFile, sessionId: session }));
  assert.equal(isolatedNavigation.parentPath, null);
  await back.click(); await waitTitle(path.basename(fixtures));
  result.cases.push('An explicitly registered external file has working history but cannot expose its unregistered parent');

  let sawOldNavigation;
  const oldNavigation = new Promise(resolve => { sawOldNavigation = resolve; });
  let releaseOldNavigation;
  const releaseOld = new Promise(resolve => { releaseOldNavigation = resolve; });
  await page.route('**/api/files/navigation**', async route => {
    if (new URL(route.request().url()).searchParams.get('path') === nested) {
      const response = await route.fetch(); sawOldNavigation(); await releaseOld;
      await route.fulfill({ response }).catch(() => {});
    } else await route.continue();
  });
  await openPath(nested); await oldNavigation;
  await openPath(fixtures); await waitTitle(path.basename(fixtures));
  releaseOldNavigation(); await sleep(150);
  assert.equal(await up.isDisabled(), true); assert.equal(await title.innerText(), path.basename(fixtures));
  await page.unroute('**/api/files/navigation**');
  result.cases.push('A late hierarchy response cannot enable Up or replace a newer root view');
  await openPath(child); await waitTitle('child');
  await page.goBack(); await waitTitle(path.basename(fixtures));
  assert.equal(await modal.isVisible(), true);
  result.cases.push('Browser Back follows the current viewer history before closing the viewer');
  assert.deepEqual(result.errors, []); result.ok = true;
} catch (error) {
  result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>');
  if (page) { await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    result.pageText = (await page.locator('body').innerText().catch(() => '')).slice(-2500); }
  process.exitCode = 1;
} finally {
  if (context && session) { try { await api('DELETE', '/api/sessions/' + session); }
    catch (error) { result.cleanupFailure = String(error).replaceAll(cookie, '<redacted-session-cookie>'); result.ok = false; process.exitCode = 1; } }
  await context?.close(); await browser?.close(); chrome?.kill();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, cases: result.cases, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
