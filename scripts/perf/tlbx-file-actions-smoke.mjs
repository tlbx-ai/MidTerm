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
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/file-actions');
fs.mkdirSync(out, { recursive: true });
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-file-selection-'));
const nested = path.join(fixtures, 'nested'); fs.mkdirSync(nested);
for (const name of ['a.md', 'b.md', 'c.md', 'd.md', 'Ünicode space.md']) fs.writeFileSync(path.join(fixtures, name), '# Original ' + name + '\n');
const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-selection-other-'));
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
    try { const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break;
    } catch { await sleep(100); }
  }
  if (!browser) throw new Error('Chrome did not start');
  context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 }, hasTouch: true });
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
  const node = name => tree.locator('.tree-node').filter({ has: page.locator('.tree-name', { hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) });
  const actions = tree.locator('.file-actions-menu');
  const invoke = async action => { await actions.locator('summary').click(); await actions.locator('[data-file-action="' + action + '"]').click(); };
  const dialog = page.locator('.file-operation-overlay');
  const apply = async value => { if (value !== undefined) await dialog.locator('input').fill(value); await dialog.locator('[data-operation-choice="apply"]').click(); };
  const completed = () => tree.locator('.file-operation-status').filter({ hasText: 'Operation completed' }).waitFor();
  await invoke('createFile'); await apply('new 🎸.md'); await node('new 🎸.md').waitFor(); await completed();
  assert.equal(fs.readFileSync(path.join(fixtures, 'new 🎸.md'), 'utf8'), '');
  result.cases.push('New file UI creates an actual empty Unicode file');
  await invoke('createFolder'); await apply('created folder'); await node('created folder').waitFor(); assert.ok(fs.statSync(path.join(fixtures, 'created folder')).isDirectory());
  result.cases.push('New folder UI creates a real directory');
  await node('a.md').click(); await preview.locator('.file-document-mode[data-mode="edit"]').click(); const editor = preview.locator('textarea'); await editor.fill('# Draft before rename\n');
  await invoke('rename'); await apply('renamed.md'); const unsaved = page.locator('.file-unsaved-overlay'); await unsaved.waitFor();
  await unsaved.locator('[data-file-decision="cancel"]').click(); assert.ok(fs.existsSync(path.join(fixtures, 'a.md'))); assert.equal(await editor.inputValue(), '# Draft before rename\n');
  await invoke('rename'); await apply('renamed.md'); await unsaved.waitFor(); await unsaved.locator('[data-file-decision="save"]').click();
  await node('renamed.md').waitFor(); await node('a.md').waitFor({ state: 'hidden' });
  assert.equal(fs.readFileSync(path.join(fixtures, 'renamed.md'), 'utf8'), '# Draft before rename\n');
  await page.waitForFunction(() => document.querySelector('.file-browser-preview')?.dataset.selectedPath?.endsWith('renamed.md'));
  result.cases.push('Rename Cancel preserves the draft; Save commits actual bytes before renaming and rebases the preview');
  await invoke('duplicate'); await node('renamed (2).md').waitFor(); assert.equal(fs.readFileSync(path.join(fixtures, 'renamed (2).md'), 'utf8'), '# Draft before rename\n');
  result.cases.push('Duplicate action produces the actual copied bytes');
  await node('b.md').click({ modifiers: ['Control'] }); await node('c.md').click({ modifiers: ['Control'] });
  await invoke('copy'); await node('created folder').dblclick(); await page.waitForFunction(() => document.querySelector('.file-browser-address-form input')?.value.endsWith('created folder')); await actions.locator('[data-file-action="paste"]:enabled').waitFor({ state: 'attached' }); await invoke('paste');
  await node('b.md').waitFor(); await node('c.md').waitFor(); assert.equal(fs.readFileSync(path.join(fixtures, 'created folder', 'b.md'), 'utf8'), '# Original b.md\n');
  result.cases.push('Multi-selection Copy/Paste writes the exact selected files into the navigated directory');
  await invoke('paste'); await dialog.waitFor(); await dialog.locator('[data-operation-choice="keepBoth"]').click(); await node('b (2).md').waitFor(); await node('c (2).md').waitFor();
  result.cases.push('Copy collision exposes Keep both and creates distinct files');
  await node('b.md').click(); await invoke('delete'); await dialog.locator('[data-operation-choice="delete"]').click(); await node('b.md').waitFor({ state: 'hidden' }); assert.ok(!fs.existsSync(path.join(fixtures, 'created folder', 'b.md')));
  await invoke('undo'); await node('b.md').waitFor(); assert.equal(fs.readFileSync(path.join(fixtures, 'created folder', 'b.md'), 'utf8'), '# Original b.md\n');
  result.cases.push('Delete confirmation removes the real file and Undo restores its bytes');
  await node('c.md').click({ button: 'right' }); const menu = page.locator('.file-context-menu'); await menu.waitFor();
  await menu.locator('[data-file-action="rename"]').click(); await apply('context-renamed.md'); await node('context-renamed.md').waitFor(); assert.ok(fs.existsSync(path.join(fixtures, 'created folder', 'context-renamed.md')));
  result.cases.push('Actual right-click context menu renames the selected entry');
  await node('context-renamed.md').focus(); await page.keyboard.press('Control+x'); await wrapper.locator('[data-browser-navigation="up"]').click(); await page.waitForFunction(root => document.querySelector('.file-browser-address-form input')?.value === root, fixtures); await node('created folder').waitFor();
  await node('created folder').focus(); await page.keyboard.press('Control+v'); await node('context-renamed.md').waitFor(); assert.ok(!fs.existsSync(path.join(fixtures, 'created folder', 'context-renamed.md')));
  result.cases.push('Keyboard Cut/Paste moves the file on disk');
  await node('context-renamed.md').click(); await invoke('delete'); await dialog.locator('[data-operation-choice="delete"]').click(); await node('context-renamed.md').waitFor({ state: 'hidden' });
  await invoke('recovery'); await dialog.locator('select').waitFor(); await dialog.locator('select').selectOption({ label: (await dialog.locator('select option').allTextContents()).find(text => text.includes('context-renamed.md')) });
  await dialog.locator('[data-operation-choice="restore"]').click(); await node('context-renamed.md').waitFor();
  result.cases.push('Recovery uses a named-entry chooser and restores actual data without exposed internal IDs');
  await node('d.md').click(); await preview.locator('.file-document-mode[data-mode="edit"]').click(); await editor.fill('# Guarded operation draft\n');
  await page.route('**/api/files/save**', route => route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ code: 'disk_full', message: 'Disk full' }) }));
  await invoke('rename'); await apply('must-not-rename.md'); await unsaved.waitFor(); await unsaved.locator('[data-file-decision="save"]').click();
  await unsaved.locator('.file-unsaved-error:not([hidden])').waitFor(); assert.ok(fs.existsSync(path.join(fixtures, 'd.md'))); assert.ok(!fs.existsSync(path.join(fixtures, 'must-not-rename.md')));
  await unsaved.locator('[data-file-decision="cancel"]').click(); await page.unroute('**/api/files/save**');
  assert.equal(await editor.inputValue(), '# Guarded operation draft\n');
  result.cases.push('A failed save prevents filesystem rename and retains the actual draft');
  await preview.locator('.preview-save-btn').click(); await page.waitForFunction(() => document.querySelector('.file-browser-preview .file-save-status')?.dataset.fileSaveState === 'saved');
  // No mutation is sent to disk for this malformed-response case.
  await page.route('**/api/files/operations?**', async route => { const data = route.request().postDataJSON(); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationId: data.requestId.replaceAll('-', ''), action: data.action, complete: true, items: [] }) }); });
  await invoke('createFile'); await apply('unconfirmed.md'); await tree.locator('.file-operation-status', { hasText: 'could not be confirmed' }).waitFor();
  assert.ok(!fs.existsSync(path.join(fixtures, 'unconfirmed.md'))); await page.unroute('**/api/files/operations?**');
  result.cases.push('Malformed acknowledgement is reported as unknown rather than completed');
  await invoke('createFile'); await apply('a new late.md'); await node('a new late.md').waitFor();
  // A command already published by the server is reconciled through its immutable receipt after transport loss.
  await page.route('**/api/files/operations?**', async route => { await route.fetch(); await route.abort('connectionreset'); });
  await node('a new late.md').click(); await invoke('duplicate'); await tree.locator('.file-operation-status', { hasText: 'Operation completed' }).waitFor();
  assert.equal(fs.readdirSync(fixtures).filter(name => name.startsWith('a new late')).length, 2);
  await page.unroute('**/api/files/operations?**');
  result.cases.push('Lost post-commit acknowledgement reads a receipt and does not duplicate the mutation');
  await page.setViewportSize({ width: 390, height: 844 });
  if (await wrapper.locator('.file-browser-back').isVisible()) await wrapper.locator('.file-browser-back').tap();
  await actions.locator('summary').tap(); await actions.locator('[data-file-action="createFolder"]').tap(); await dialog.locator('input').fill('touch folder'); await dialog.locator('[data-operation-choice="apply"]').tap();
  await node('touch folder').waitFor(); assert.ok(fs.statSync(path.join(fixtures, 'touch folder')).isDirectory());
  await page.screenshot({ path: path.join(out, 'file-actions-touch.png') });
  result.cases.push('390px real touch interactions create a real folder through reachable actions and form controls');
  await page.setViewportSize({ width: 1440, height: 1000 }); await terminal.click();
  await page.evaluate(target => window.mmDebug.terminals.get(window.mmDebug.activeId).terminal._core._linkProviderService.linkProviders.at(-2)._handler(new MouseEvent('click'), target), fixtures);
  const modal = page.locator('#file-viewer-modal'); await modal.locator('.file-list').waitFor();
  const modalAction = async action => { await modal.locator('.file-actions-menu summary').click(); await modal.locator('[data-file-action="' + action + '"]').click(); };
  const listItem = name => modal.locator('.file-list-item').filter({ has: page.locator('.file-name', { hasText: name }) });
  await modalAction('createFile'); await apply('modal-created.txt'); await listItem('modal-created.txt').waitFor(); assert.ok(fs.existsSync(path.join(fixtures, 'modal-created.txt')));
  await listItem('modal-created.txt').click(); await modalAction('rename'); await apply('modal-renamed.txt'); await listItem('modal-renamed.txt').waitFor();
  assert.equal(await modal.locator('.file-list-item.selected .file-name').innerText(), 'modal-renamed.txt');
  result.cases.push('Directory modal creates and renames real files while retaining its selected row');
  await modal.locator('#file-viewer-dock-btn').click(); const dock = page.locator('#file-viewer-dock'); await dock.locator('.file-list').waitFor();
  await dock.locator('.file-actions-menu summary').click(); await dock.locator('[data-file-action="delete"]').click(); await dialog.locator('[data-operation-choice="delete"]').click();
  await dock.locator('.file-list-item').filter({ has: page.locator('.file-name', { hasText: 'modal-renamed.txt' }) }).waitFor({ state: 'hidden' });
  await dock.locator('.file-actions-menu summary').click(); await dock.locator('[data-file-action="undo"]').click();
  await dock.locator('.file-list-item.selected .file-name', { hasText: 'modal-renamed.txt' }).waitFor(); assert.ok(fs.existsSync(path.join(fixtures, 'modal-renamed.txt')));
  result.cases.push('Docked directory Delete/Undo preserves the presentation and restores real bytes');
  await dock.locator('.file-actions-menu summary').click(); await dock.locator('[data-file-action="delete"]').click(); await dialog.locator('[data-operation-choice="delete"]').click();
  await dock.locator('.file-list-item').filter({ has: page.locator('.file-name', { hasText: 'modal-renamed.txt' }) }).waitFor({ state: 'hidden' });
  fs.writeFileSync(path.join(fixtures, 'modal-renamed.txt'), 'new external file');
  await dock.locator('.file-actions-menu summary').click(); await dock.locator('[data-file-action="undo"]').click(); await dialog.waitFor(); await dialog.locator('[data-operation-choice="cancel"]').click();
  assert.equal(fs.readFileSync(path.join(fixtures, 'modal-renamed.txt'), 'utf8'), 'new external file');
  assert.equal(await dock.locator('[data-file-action="undo"]').isEnabled(), true);
  await dock.locator('.file-actions-menu summary').click(); await dock.locator('[data-file-action="undo"]').click(); await dialog.locator('[data-operation-choice="keepBoth"]').click();
  await dock.locator('.file-list-item.selected .file-name', { hasText: 'modal-renamed (2).txt' }).waitFor();
  assert.equal(fs.readFileSync(path.join(fixtures, 'modal-renamed.txt'), 'utf8'), 'new external file'); assert.equal(fs.readFileSync(path.join(fixtures, 'modal-renamed (2).txt'), 'utf8'), '');
  result.cases.push('Undo collision Cancel retains the undo action; Keep both preserves the newer external file');

  await page.screenshot({ path: path.join(out, 'directory-actions-dock.png') });

  await page.screenshot({ path: path.join(out, 'file-actions-desktop.png') });
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
