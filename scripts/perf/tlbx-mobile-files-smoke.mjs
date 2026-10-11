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
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/mobile-files');
fs.mkdirSync(out, { recursive: true });
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-mobile-files-'));
const initial = Array.from({ length: 300 }, (_, i) => `Line ${i} ${'wide content '.repeat(15)}`).join('\n');
fs.writeFileSync(path.join(fixtures, 'A.md'), initial);
fs.writeFileSync(path.join(fixtures, 'B.txt'), 'Plain text preview\n');
fs.copyFileSync(new URL('../../src/Ai.Tlbx.MidTerm/src/static/img/logo.png', import.meta.url), path.join(fixtures, 'C.png'));
fs.writeFileSync(path.join(fixtures, 'D.bin'), Buffer.from([0, 255, 0, 1, 0, 2, 0, 3]));
const wave = Buffer.alloc(44 + 16000);
wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
wave.write('data', 36); wave.writeUInt32LE(16000, 40);
fs.writeFileSync(path.join(fixtures, 'E.wav'), wave);
for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(fixtures, `filler-${String(i).padStart(3, '0')}.txt`), 'filler');
const result = { ok: false, fixtures, cases: [], errors: [], geometry: [], locales: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, browser, context, session, page;
async function api(method, route, data) {
  const response = await context.request.fetch(url + route, { method, data });
  assert.ok(response.ok(), `${route}: ${response.status()}`);
  const raw = await response.text();
  return raw ? JSON.parse(raw) : null;
}
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check',
  ], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) {
    try {
      const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break;
    } catch { await sleep(100); }
  }
  if (!browser) throw new Error('Chrome did not start');
  for (const width of [390, 768]) {
    fs.writeFileSync(path.join(fixtures, 'A.md'), initial);
    context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, hasTouch: true, isMobile: true });
    const eq = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]);
    session = (await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 80, rows: 24, workingDirectory: fixtures, launchRequestId: crypto.randomUUID() })).id;
    page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => result.errors.push(error.message));
    page.on('response', response => {
      if (response.url().includes('/locales/')) {
        void response.text().then(raw => result.locales.push({ url: response.url(), status: response.status(), size: raw.length,
          back: JSON.parse(raw)['fileBrowser.backToFiles'] })).catch(error => result.locales.push({ status: response.status(), error: String(error) }));
      }
    });
    await page.goto(url);
    // Selecting a session through the real sidebar precedes switching to the mobile Files pill.
    if (!(await page.locator(`.session-item[data-session-id="${session}"] .session-title`).isVisible()))
      await page.locator('#btn-hamburger').tap();
    await page.locator(`.session-item[data-session-id="${session}"] .session-title`).tap();
    if (await page.locator('#btn-mobile-strip-files').isVisible()) {
      await page.locator('#btn-mobile-strip-files').tap();
    } else {
      await page.locator('#btn-mobile-actions-menu').tap();
      await page.locator('#btn-mobile-tab-files').tap();
    }
    const root = page.locator(`.session-wrapper[data-session-id="${session}"] .file-browser`);
    const tree = root.locator('.file-browser-tree'), preview = root.locator('.file-browser-preview');
    const back = root.locator('.file-browser-back');
    const choose = async name => tree.locator('.tree-node').filter({ has: page.locator('.tree-name', { hasText: new RegExp('^' + name.replace('.', '\\.') + '$') }) }).tap();
    await tree.locator('.tree-node').first().waitFor();
    assert.equal(await preview.isVisible(), false);
    await choose('A.md');
    const editor = preview.locator('textarea'); await editor.waitFor();
    assert.equal(await tree.isVisible(), false);
    assert.equal(await back.isVisible(), true);
    const rect = await preview.boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1 && rect.height > 300);
    result.geometry.push({ width, preview: rect });
    await editor.fill(initial + '\nMOBILE_DRAFT_' + width);
    const position = await editor.evaluate(e => { e.setSelectionRange(70, 75); e.scrollTop = 500; e.scrollLeft = 30;
      window.mobileEditorProbe = e; return { top: e.scrollTop, left: e.scrollLeft, start: e.selectionStart, end: e.selectionEnd }; });
    await back.tap(); await tree.waitFor();
    assert.equal(await tree.locator('.tree-node.selected .tree-name').innerText(), 'A.md');
    await choose('A.md'); await editor.waitFor(); await sleep(80);
    assert.equal(await page.locator('.file-unsaved-overlay').count(), 0);
    assert.equal(await editor.inputValue(), initial + '\nMOBILE_DRAFT_' + width);
    const restored = await editor.evaluate(e => ({ same: e === window.mobileEditorProbe, top: e.scrollTop, left: e.scrollLeft, start: e.selectionStart, end: e.selectionEnd }));
    assert.equal(restored.same, true); delete restored.same;
    assert.deepEqual(restored, position);
    result.cases.push(`${width}px touch: file detail is visible and Back/reopen preserves draft, DOM, caret and scroll`);
    await back.tap(); await choose('B.txt');
    const dialog = page.locator('.file-unsaved-overlay'); await dialog.waitFor();
    await dialog.locator('[data-file-decision="cancel"]').tap();
    assert.equal(await tree.isVisible(), true);
    assert.equal(await tree.locator('.tree-node.selected .tree-name').innerText(), 'A.md');
    await choose('A.md'); await editor.waitFor();
    await preview.locator('.preview-save-btn').tap();
    await page.waitForFunction(() => document.querySelector('.file-browser-preview .file-save-status')?.dataset.fileSaveState === 'saved');
    assert.equal(fs.readFileSync(path.join(fixtures, 'A.md'), 'utf8'), initial + '\nMOBILE_DRAFT_' + width);
    result.cases.push(`${width}px touch: changing file asks before losing the draft; Cancel and real Save work`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await tree.waitFor(); assert.equal(await preview.isVisible(), true);
    assert.equal(await editor.evaluate(e => e === window.mobileEditorProbe), true);
    await page.setViewportSize({ width, height: 900 });
    await sleep(400);
    result.geometry.push(await page.evaluate(() => ({ width: innerWidth, clientWidth: document.documentElement.clientWidth,
      sidebarOpen: document.querySelector('.terminal-page').classList.contains('sidebar-open') })));
    await back.waitFor(); assert.equal(await editor.isVisible(), true);
    assert.equal(await editor.inputValue(), initial + '\nMOBILE_DRAFT_' + width);
    result.cases.push(`${width}px to desktop and back preserves the selected editor`);
    const noticeRect = await preview.locator('.file-document-notice').boundingBox();
    const editorRect = await editor.boundingBox();
    assert.ok(noticeRect.y >= 84 && noticeRect.y + noticeRect.height <= editorRect.y);
    assert.ok(editorRect.y + editorRect.height <= 900);
    await page.screenshot({ path: path.join(out, `text-${width}.png`) });
    await back.tap();
    await tree.evaluate(e => { e.scrollTop = 300; });
    await choose('filler-020.txt');
    await preview.locator('.preview-toolbar-name', { hasText: 'filler-020.txt' }).waitFor();
    await back.tap();
    const scroll = await tree.evaluate(e => e.scrollTop);
    assert.ok(scroll > 0);
    result.cases.push(`${width}px touch: returning from a scrolled tree retains its position`);
    await choose('C.png');
    await preview.locator('img').waitFor();
    await page.waitForFunction(() => document.querySelector('.file-browser-preview img')?.naturalWidth > 0);
    const imageRect = await preview.locator('img').boundingBox(); assert.ok(imageRect.x >= 0 && imageRect.x < width);
    await page.screenshot({ path: path.join(out, `image-${width}.png`) });
    const downloadButton = preview.locator('.preview-toolbar-actions button').filter({ has: page.locator('.icon-download') });
    // Download action is identified by the existing localized title if the SVG has no CSS icon class.
    const downloadAction = (await downloadButton.count()) ? downloadButton : preview.locator('.preview-toolbar-actions button[title="Download"]');
    const [download] = await Promise.all([page.waitForEvent('download'), downloadAction.tap()]);
    const target = path.join(out, `download-${width}.png`); await download.saveAs(target);
    assert.deepEqual(fs.readFileSync(target), fs.readFileSync(path.join(fixtures, 'C.png')));
    result.cases.push(`${width}px touch: rendered image and real original-file download are reachable`);
    await back.tap(); await choose('D.bin');
    await preview.locator('.file-viewer-text').waitFor();
    assert.ok((await preview.locator('.file-viewer-text').innerText()).includes('FF'));
    result.cases.push(`${width}px touch: binary detail renders instead of disappearing`);
    await back.tap(); await choose('E.wav');
    await preview.locator('audio').waitFor();
    await page.waitForFunction(() => document.querySelector('.file-browser-preview audio')?.duration === 1);
    assert.equal(await preview.locator('audio').evaluate(e => e.controls), true);
    const audioRect = await preview.locator('audio').boundingBox();
    assert.ok(audioRect.height >= 54 && audioRect.y + audioRect.height <= 900 && audioRect.x + audioRect.width <= width);
    await page.screenshot({ path: path.join(out, `audio-${width}.png`) });
    result.cases.push(`${width}px touch: real WAV media metadata and native audio controls remain visible`);
    await api('DELETE', '/api/sessions/' + session); session = null;
    await context.close(); context = null;
  }
  assert.deepEqual(result.errors, []); result.ok = true;
} catch (error) {
  result.failure = String(error.stack || error);
  if (page) {
    await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    result.pageText = (await page.locator('body').innerText().catch(() => '')).slice(-2500);
  }
  process.exitCode = 1;
} finally {
  if (context && session) {
    try { await api('DELETE', '/api/sessions/' + session); }
    catch (error) { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; }
  }
  await context?.close(); await browser?.close(); chrome?.kill();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, cases: result.cases, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
