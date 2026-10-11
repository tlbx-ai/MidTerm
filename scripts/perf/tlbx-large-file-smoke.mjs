import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../../docs/marketing/ScreenshotAutomation/node_modules/playwright');
const url = process.env.TLBX_PERF_URL;
const cookie = process.env.TLBX_COOKIE_HEADER;
if (!url || !cookie) throw new Error('Source URL and authenticated cookie required');
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/large-files');
fs.mkdirSync(out, { recursive: true });
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-large-files-'));
const unicode = 'Greek Ω, emoji 😀, umlauts äöü, CRLF boundary\r\n';
const content = unicode.repeat(30000);
fs.writeFileSync(path.join(fixtures, 'unicode.txt'), '\uFEFF' + content, 'utf16le');
fs.writeFileSync(path.join(fixtures, 'medium.md'), content);
const hugePath = path.join(fixtures, 'huge.txt');
const fd = fs.openSync(hugePath, 'w');
const chunk = Buffer.from('bounded preview\n'.repeat(16384));
for (let i = 0; i < 256; i++) fs.writeSync(fd, chunk);
fs.closeSync(fd);
const result = { ok: false, fixtures, cases: [], errors: [], memory: {}, requests: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, browser, context, session, page;
async function api(method, route, data) {
  const response = await context.request.fetch(url + route, { method, data });
  assert.ok(response.ok(), `${route}: ${response.status()} ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

try {
  const profile = path.join(out, 'chrome-profile');
  fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check',
  ], { windowsHide: true, stdio: ['ignore',
    fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'),
    fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) {
    try {
      const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
      break;
    } catch { await sleep(100); }
  }
  if (!browser) throw new Error('Chrome did not start');
  context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const eq = cookie.indexOf('=');
  await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]);
  session = (await api('POST', '/api/sessions', {
    shell: 'Pwsh', cols: 100, rows: 30, workingDirectory: fixtures, launchRequestId: crypto.randomUUID(),
  })).id;
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.errors.push(error.message));
  page.on('request', request => {
    const u = new URL(request.url());
    if (u.pathname === '/api/files/document') result.requests.push(Object.fromEntries(u.searchParams));
  });
  await page.goto(url);
  await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();
  const filesTab = page.locator(`.session-wrapper[data-session-id="${session}"] .session-tab[data-tab="files"]`);
  await filesTab.click();
  await page.waitForSelector('.tree-node');
  const choose = async name => {
    await page.locator('.tree-node').filter({ has: page.locator('.tree-name', { hasText: name }) }).click();
  };
  const preview = page.locator('.file-browser-preview');
  const docUrl = (name, full = false, offset = 0) => '/api/files/document?' + new URLSearchParams({
    path: path.join(fixtures, name), sessionId: session, full: String(full), offset: String(offset),
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    return (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'JSHeapUsedSize').value;
  };
  result.memory.before = await heap();
  await choose('huge.txt');
  await preview.locator('[data-document-action="next"]').waitFor();
  const initial = await api('GET', docUrl('huge.txt'));
  assert.equal(initial.readOnly, true);
  assert.equal(initial.canLoadFull, false);
  assert.equal(initial.version, null);
  assert.ok(initial.content.length <= 524288);
  assert.ok(initial.size >= 64 * 1024 * 1024);
  assert.equal(await preview.locator('[data-document-action="full"]').count(), 0);
  assert.equal(await preview.locator('.preview-editor-btn').isDisabled(), true);
  assert.equal(await preview.locator('textarea').count(), 0);
  assert.match(await preview.locator('.file-document-metadata').innerText(), /64(?:\.0)? M(?:i)?B/);
  result.memory.hugePreview = await heap();
  assert.ok(result.memory.hugePreview - result.memory.before < 24 * 1024 * 1024,
    '64 MiB file must not produce a whole-file browser allocation');
  result.cases.push('64 MiB default preview is bounded, read-only, sized and cannot become editable');
  await preview.locator('[data-document-action="next"]').click();
  await preview.locator('[data-document-action="previous"]').waitFor();
  assert.ok(result.requests.some(r => r.path.endsWith('huge.txt') && Number(r.offset) === initial.nextOffset));
  await preview.locator('[data-document-action="previous"]').click();
  await preview.locator('[data-document-action="previous"]').waitFor({ state: 'hidden' });
  assert.equal(await preview.locator('[data-document-action="previous"]').count(), 0);
  result.cases.push('Files next/previous pages follow server byte cursors and restore the first page');
  await page.screenshot({ path: path.join(out, 'huge-files.png') });

  await choose('unicode.txt');
  await preview.locator('[data-document-action="full"]').waitFor();
  assert.match(await preview.locator('.file-document-metadata').innerText(), /utf-16/i);
  const u0 = await api('GET', docUrl('unicode.txt'));
  const u1 = await api('GET', docUrl('unicode.txt', false, u0.nextOffset));
  assert.equal(u0.content + u1.content, content.replaceAll('\r\n', '\n').slice(0, (u0.content + u1.content).length));
  result.cases.push('UTF-16 BOM, emoji and CRLF survive real HTTP page boundaries without duplicate or lost text');
  const firstText = await preview.locator('.file-viewer-text').innerText();
  await page.route('**/api/files/document**', route => {
    if (new URL(route.request().url()).searchParams.get('full') === 'true')
      return route.fulfill({ status: 503, body: 'Injected transient read failure' });
    return route.continue();
  });
  await preview.locator('[data-document-action="full"]').click();
  await preview.locator('.file-document-load-error:not([hidden])').waitFor();
  assert.equal(await preview.locator('.file-viewer-text').innerText(), firstText);
  assert.equal(await preview.locator('[data-document-action="full"]').isDisabled(), false);
  assert.equal(await preview.locator('.preview-editor-btn').isDisabled(), true);
  result.cases.push('Failed full load retains the preview and keeps a working retry button');
  await page.unroute('**/api/files/document**');
  await preview.locator('[data-document-action="full"]').click();
  await page.waitForFunction(() => !document.querySelector('.file-browser-preview .preview-editor-btn')?.disabled);
  assert.equal(await preview.locator('[data-document-action="full"]').count(), 0);
  await preview.locator('.preview-editor-btn').click();
  assert.equal(await preview.locator('textarea').inputValue(), content.replaceAll('\r\n', '\n'));
  assert.equal(await preview.locator('textarea').evaluate(e => e.readOnly), false);
  await preview.locator('textarea').fill('Saved complete UTF-16 document\n');
  await preview.locator('.preview-save-btn').click();
  await page.waitForFunction(() => document.querySelector('.file-browser-preview .file-save-status')?.dataset.fileSaveState === 'saved');
  const savedBytes = fs.readFileSync(path.join(fixtures, 'unicode.txt'));
  assert.equal(savedBytes.subarray(0, 2).toString('hex'), 'fffe');
  assert.equal(savedBytes.subarray(2).toString('utf16le'), 'Saved complete UTF-16 document\r\n');
  result.cases.push('Only a complete versioned document becomes editable; save preserves UTF-16 BOM and CRLF');

  await page.locator(`.session-wrapper[data-session-id="${session}"] .session-tab[data-tab="terminal"]`).click();
  const openFile = async name => page.evaluate(file => {
    const terminal = window.mmDebug.terminals.get(window.mmDebug.activeId).terminal;
    terminal._core._linkProviderService.linkProviders.at(-2)._handler(new MouseEvent('click'), file);
  }, path.join(fixtures, name));
  await openFile('medium.md');
  const modal = page.locator('#file-viewer-modal');
  await modal.locator('[data-document-action="next"]').waitFor();
  assert.equal(await modal.locator('textarea').evaluate(e => e.readOnly), true);
  await modal.locator('[data-document-action="next"]').click();
  await modal.locator('[data-document-action="previous"]').waitFor();
  await page.locator('#file-viewer-dock-btn').click();
  const dock = page.locator('#file-viewer-dock');
  await dock.locator('[data-document-action="previous"]').waitFor();
  assert.equal(await dock.locator('textarea').evaluate(e => e.readOnly), true);
  await dock.locator('[data-document-action="previous"]').click();
  await dock.locator('[data-document-action="previous"]').waitFor({ state: 'hidden' });
  assert.equal(await dock.locator('[data-document-action="previous"]').count(), 0);
  result.cases.push('Modal pagination remains functional with byte history after moving the same document into the dock');
  await dock.locator('[data-document-action="full"]').click();
  await page.waitForFunction(() => document.querySelector('#file-viewer-dock textarea')?.readOnly === false);
  assert.equal(await dock.locator('textarea').inputValue(), content.replaceAll('\r\n', '\n'));
  result.cases.push('Dock full loading enables editing of the complete document with no partial text loss');
  await page.screenshot({ path: path.join(out, 'complete-dock.png') });
  await page.locator('#dock-undock').click();
  await modal.locator('textarea').waitFor();
  assert.equal(await modal.locator('textarea').evaluate(e => e.readOnly), false);
  await modal.locator('.modal-close').click();
  await openFile('huge.txt');
  await modal.locator('[data-document-action="next"]').waitFor();
  assert.equal(await modal.locator('[data-document-action="full"]').count(), 0);
  await modal.locator('[data-document-action="next"]').click();
  await modal.locator('[data-document-action="previous"]').waitFor();
  await page.screenshot({ path: path.join(out, 'huge-modal.png') });
  result.cases.push('Modal also keeps oversized files read-only while allowing forward and backward navigation');
  assert.deepEqual(result.errors, []);
  result.ok = true;
} catch (error) {
  result.failure = String(error.stack || error);
  if (page) {
    await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    result.pageText = (await page.locator('body').innerText().catch(() => '')).slice(-4000);
  }
  process.exitCode = 1;
} finally {
  if (context && session) {
    try { await api('DELETE', '/api/sessions/' + session); }
    catch (error) { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; }
  }
  await context?.close();
  await browser?.close();
  chrome?.kill();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, cases: result.cases, memory: result.memory, summary: path.join(out, 'summary.json'), failure: result.failure }));
}
