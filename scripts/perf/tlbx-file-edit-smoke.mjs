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
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/edit-smoke');
fs.mkdirSync(out, { recursive: true });
// A non-Git directory is deliberate: ignored repository artifacts are currently
// filtered out by the tree API, which is independently covered by task 18.
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-file-edit-'));
fs.writeFileSync(path.join(fixtures, 'A.md'), '# A\n');
fs.writeFileSync(path.join(fixtures, 'B.md'), '# B\n');
const longText = Array.from({ length: 300 }, (_, i) => `line ${i + 1} ${'abcdefghij'.repeat(20)}`).join('\n');
fs.writeFileSync(path.join(fixtures, 'C.md'), longText);
const result = { ok: false, fixtures, cases: [], errors: [], failedRequests: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, browser, context, session, otherSession, page;

async function api(method, route, data) {
  const response = await context.request.fetch(url + route, { method, data });
  if (!response.ok()) throw new Error(`${route}: ${response.status()} ${await response.text()}`);
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
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => result.errors.push(error.message));
  page.on('response', response => {
    if (response.status() >= 400) result.failedRequests.push({ url: response.url(), status: response.status() });
  });
  await page.goto(url);
  await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();
  await page.locator(`.session-wrapper[data-session-id="${session}"] .session-tab[data-tab="files"]`).click();
  await page.waitForSelector('.tree-node');
  const choose = async name => {
    await page.locator('.tree-node').filter({ has: page.locator('.tree-name', { hasText: new RegExp('^' + name.replace('.', '\\.') + '$') }) }).click();
  };
  const editor = page.locator('.file-browser-preview textarea');
  const selected = page.locator('.tree-node.selected .tree-name');
  const dialog = page.locator('.file-unsaved-overlay');

  await choose('A.md');
  await editor.fill('# unsaved A\n');
  await choose('B.md');
  await dialog.waitFor();
  assert.equal(await selected.innerText(), 'A.md');
  await page.screenshot({ path: path.join(out, 'cancel-dialog.png') });
  await dialog.locator('[data-file-decision="cancel"]').click();
  assert.equal(await editor.inputValue(), '# unsaved A\n');
  assert.equal(fs.readFileSync(path.join(fixtures, 'A.md'), 'utf8'), '# A\n');
  result.cases.push('Cancel preserves document, selection and disk');

  await choose('B.md');
  await dialog.locator('[data-file-decision="save"]').click();
  await page.waitForFunction(() => document.querySelector('.preview-toolbar-name')?.textContent === 'B.md');
  assert.equal(fs.readFileSync(path.join(fixtures, 'A.md'), 'utf8'), '# unsaved A\n');
  assert.equal(await selected.innerText(), 'B.md');
  result.cases.push('Save writes actual file before navigating');

  await editor.fill('# discarded B\n');
  await choose('A.md');
  await dialog.locator('[data-file-decision="discard"]').click();
  await page.waitForFunction(() => document.querySelector('.preview-toolbar-name')?.textContent === 'A.md');
  assert.equal(fs.readFileSync(path.join(fixtures, 'B.md'), 'utf8'), '# B\n');
  result.cases.push('Discard leaves disk unchanged and navigates');

  await editor.fill('# permission failure draft\n');
  await page.route('**/api/files/save**', route => route.fulfill({ status: 403, body: 'Denied by test fixture' }));
  await choose('B.md');
  await dialog.locator('[data-file-decision="save"]').click();
  await dialog.locator('.file-unsaved-error:not([hidden])').waitFor();
  assert.equal(await selected.innerText(), 'A.md');
  assert.equal(await editor.inputValue(), '# permission failure draft\n');
  assert.equal(fs.readFileSync(path.join(fixtures, 'A.md'), 'utf8'), '# unsaved A\n');
  await page.screenshot({ path: path.join(out, 'save-error.png') });
  await dialog.locator('[data-file-decision="cancel"]').click();
  await page.unroute('**/api/files/save**');
  result.cases.push('Failed save displays error and preserves draft without navigation');

  await choose('B.md');
  await dialog.locator('[data-file-decision="discard"]').click();
  await page.waitForFunction(() => document.querySelector('.preview-toolbar-name')?.textContent === 'B.md');
  await page.locator(`.session-wrapper[data-session-id="${session}"] .session-tab[data-tab="terminal"]`).click();
  const openFile = async name => {
    await page.evaluate(file => {
      const terminal = window.mmDebug.terminals.get(window.mmDebug.activeId).terminal;
      // Use the actual file-link activation registered by the application.
      terminal._core._linkProviderService.linkProviders.at(-2)._handler(new MouseEvent('click'), file);
    }, path.join(fixtures, name));
  };
  await openFile('A.md');
  const modal = page.locator('#file-viewer-modal');
  const modalEditor = modal.locator('textarea');
  await modalEditor.fill('# modal unsaved\n');
  await openFile('B.md');
  await dialog.waitFor();
  await dialog.locator('[data-file-decision="cancel"]').click();
  assert.equal(await modalEditor.inputValue(), '# modal unsaved\n');
  assert.equal(await modal.locator('.file-viewer-title').innerText(), 'A.md');
  result.cases.push('Modal cancel preserves document and content');
  await modal.locator('.modal-close').click();
  await dialog.locator('[data-file-decision="save"]').click();
  await modal.waitFor({ state: 'hidden' });
  assert.equal(fs.readFileSync(path.join(fixtures, 'A.md'), 'utf8'), '# modal unsaved\n');
  result.cases.push('Modal close waits for successful save on disk');

  let documentReads = 0;
  page.on('request', request => {
    const requestUrl = new URL(request.url());
    if (requestUrl.pathname === '/api/files/view' && requestUrl.searchParams.get('path')?.endsWith('C.md')) documentReads++;
  });
  await openFile('C.md');
  await modalEditor.fill(longText + '\nUNSAVED_DOCK_DRAFT');
  const expectedPosition = await modalEditor.evaluate(e => {
    window.fileEditProbe = e;
    e.setSelectionRange(84, 91);
    e.scrollTop = 700;
    e.scrollLeft = 150;
    return { top: e.scrollTop, left: e.scrollLeft, start: e.selectionStart, end: e.selectionEnd };
  });
  await page.locator('#file-viewer-dock-btn').click();
  const dockEditor = page.locator('#file-viewer-dock textarea');
  await dockEditor.waitFor();
  await sleep(100);
  assert.equal(await dockEditor.inputValue(), longText + '\nUNSAVED_DOCK_DRAFT');
  const dockPosition = await dockEditor.evaluate(e => ({ same: window.fileEditProbe === e, top: e.scrollTop, left: e.scrollLeft, start: e.selectionStart, end: e.selectionEnd }));
  assert.equal(dockPosition.same, true);
  assert.deepEqual({ top: dockPosition.top, left: dockPosition.left, start: dockPosition.start, end: dockPosition.end }, expectedPosition);
  assert.equal(await page.locator('#dock-save').isVisible(), true);
  await page.screenshot({ path: path.join(out, 'docked-draft.png') });
  await page.locator('#dock-undock').click();
  await modalEditor.waitFor();
  await sleep(100);
  assert.equal(await modalEditor.evaluate(e => window.fileEditProbe === e), true);
  assert.equal(await modalEditor.inputValue(), longText + '\nUNSAVED_DOCK_DRAFT');
  assert.equal(documentReads, 1);
  result.cases.push('Dock and undock preserve the same editor, draft, caret and scroll without refetch');

  await page.locator('#file-viewer-maximize').click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.locator('#file-viewer-dock-btn').click();
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.equal(await dockEditor.inputValue(), longText + '\nUNSAVED_DOCK_DRAFT');
  result.cases.push('Fullscreen to dock retains the dirty document');
  await page.goBack();
  await dialog.locator('[data-file-decision="cancel"]').click();
  assert.equal(await dockEditor.inputValue(), longText + '\nUNSAVED_DOCK_DRAFT');
  assert.equal(documentReads, 1);
  result.cases.push('Browser Back in the dock asks before closing and Cancel retains the draft');
  await page.locator('#dock-refresh').click();
  await dialog.locator('[data-file-decision="cancel"]').click();
  assert.equal(await dockEditor.inputValue(), longText + '\nUNSAVED_DOCK_DRAFT');
  assert.equal(documentReads, 1);
  result.cases.push('Cancel refresh preserves draft without requesting a replacement');
  await page.route('**/api/files/save**', route => route.fulfill({ status: 403, body: 'Denied by refresh fixture' }));
  await page.locator('#dock-refresh').click();
  await dialog.locator('[data-file-decision="save"]').click();
  await dialog.locator('.file-unsaved-error:not([hidden])').waitFor();
  assert.equal(await dockEditor.inputValue(), longText + '\nUNSAVED_DOCK_DRAFT');
  assert.equal(documentReads, 1);
  await dialog.locator('[data-file-decision="cancel"]').click();
  await page.unroute('**/api/files/save**');
  result.cases.push('Failed save blocks refresh and retains original editor');
  await page.locator('#dock-refresh').click();
  await dialog.locator('[data-file-decision="discard"]').click();
  await page.waitForFunction(text => document.querySelector('#file-viewer-dock textarea')?.value === text, longText);
  assert.equal(documentReads, 2);
  assert.equal(fs.readFileSync(path.join(fixtures, 'C.md'), 'utf8'), longText);
  result.cases.push('Explicit discard refresh loads disk without saving the draft');
  await dockEditor.fill('# saved before refresh\n');
  await page.locator('#dock-refresh').click();
  const replacementRead = page.waitForResponse(response => {
    const requestUrl = new URL(response.url());
    return requestUrl.pathname === '/api/files/view' && requestUrl.searchParams.get('path')?.endsWith('C.md');
  });
  await dialog.locator('[data-file-decision="save"]').click();
  assert.equal((await replacementRead).ok(), true);
  await page.waitForFunction(() => document.querySelector('#file-viewer-dock textarea')?.value === '# saved before refresh\n');
  assert.equal(fs.readFileSync(path.join(fixtures, 'C.md'), 'utf8'), '# saved before refresh\n');
  assert.equal(documentReads, 3);
  result.cases.push('Save refresh writes the draft before loading the replacement');
  await page.locator('#dock-close').click();

  await page.locator(`.session-wrapper[data-session-id="${session}"] .session-tab[data-tab="files"]`).click();
  await choose('A.md');
  await editor.fill('# do not close this draft\n');
  const row = page.locator(`.session-item[data-session-id="${session}"]`);
  await row.hover();
  await sleep(250);
  await row.locator('.session-close').click();
  await dialog.locator('[data-file-decision="cancel"]').click();
  assert.equal(await editor.inputValue(), '# do not close this draft\n');
  assert.equal((await api('GET', '/api/sessions')).sessions.some(s => s.id === session), true);
  result.cases.push('Session close is cancelled before terminal or file teardown');

  otherSession = (await api('POST', '/api/sessions', {
    shell: 'Pwsh', cols: 100, rows: 30, workingDirectory: fixtures, launchRequestId: crypto.randomUUID(),
  })).id;
  const otherRow = page.locator(`.session-item[data-session-id="${otherSession}"]`);
  await otherRow.locator('.session-title').click();
  await dialog.locator('[data-file-decision="cancel"]').click();
  assert.equal(await page.evaluate(() => window.mmDebug.activeId), session);
  assert.equal(await editor.inputValue(), '# do not close this draft\n');
  result.cases.push('Session switch cancellation retains active session and draft');
  await otherRow.locator('.session-title').click();
  await dialog.locator('[data-file-decision="discard"]').click();
  await page.waitForFunction(id => window.mmDebug.activeId === id, otherSession);
  await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();
  await page.waitForFunction(id => window.mmDebug.activeId === id, session);
  assert.equal(await editor.inputValue(), '# modal unsaved\n');
  result.cases.push('Discarded session draft is removed from both state and editor');

  await choose('B.md');
  await page.waitForFunction(() => document.querySelector('.preview-toolbar-name')?.textContent === 'B.md');

  await editor.fill('# retained across tabs and reload\n');
  const tabBar = page.locator(`.session-wrapper[data-session-id="${session}"]`);
  await tabBar.locator('.session-tab[data-tab="terminal"]').click();
  await tabBar.locator('.session-tab[data-tab="files"]').click();
  assert.equal(await editor.inputValue(), '# retained across tabs and reload\n');
  result.cases.push('Tab switching retains the unsaved editor');
  let unloadDialogType;
  page.once('dialog', async d => {
    unloadDialogType = d.type();
    await d.dismiss();
  });
  await page.reload({ timeout: 3000 }).catch(error => {
    if (unloadDialogType !== 'beforeunload') throw error;
  });
  assert.equal(unloadDialogType, 'beforeunload');
  assert.equal(await editor.inputValue(), '# retained across tabs and reload\n');
  result.cases.push('Browser reload cancellation preserves the unsaved document');
  await choose('A.md');
  await dialog.locator('[data-file-decision="discard"]').click();
  await page.waitForFunction(() => document.querySelector('.preview-toolbar-name')?.textContent === 'A.md');

  assert.deepEqual(result.errors, []);
  result.ok = true;
} catch (error) {
  result.failure = String(error.stack || error);
  if (page) {
    await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    result.pageText = (await page.locator('body').innerText().catch(() => '')).slice(-5000);
    result.sessionIds = { session, otherSession };
    result.runtime = await page.evaluate(() => ({
      activeId: window.mmDebug.activeId,
      rows: [...document.querySelectorAll('.session-item')].map(e => ({ id: e.dataset.sessionId, current: e.getAttribute('aria-current'), className: e.className })),
      previews: [...document.querySelectorAll('.file-browser-preview textarea')].map(e => ({ session: e.closest('.session-wrapper')?.dataset.sessionId, value: e.value })),
    })).catch(() => null);
  }
  process.exitCode = 1;
} finally {
  if (context) {
    try { for (const id of [session, otherSession].filter(Boolean)) await api('DELETE', '/api/sessions/' + id); }
    catch (error) { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; }
  }
  await context?.close();
  await browser?.close();
  chrome?.kill();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, cases: result.cases, summary: path.join(out, 'summary.json'), failure: result.failure }));
}
