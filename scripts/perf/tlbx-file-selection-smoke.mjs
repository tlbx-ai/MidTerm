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
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/file-selection');
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
  const node = name => tree.locator('.tree-node').filter({ has: page.locator('.tree-name', { hasText: new RegExp('^' + name.replace('.', '\\.') + '$') }) });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const toolbar = tree.locator('.file-selection-toolbar');
  const selected = async root => root.locator('[aria-selected="true"]').evaluateAll(rows => rows.map(row => row.dataset.path));
  await node('a.md').click(); await preview.locator('.file-document-mode[data-mode="edit"]').click(); const editor = preview.locator('textarea'); await editor.fill('# Selection draft\n');
  await node('b.md').click({ modifiers: ['Control'] });
  await node('d.md').click({ modifiers: ['Shift'] });
  assert.deepEqual(await selected(tree), ['b.md', 'c.md', 'd.md'].map(n => path.join(fixtures, n)));
  assert.equal(await editor.inputValue(), '# Selection draft\n');
  assert.equal(await page.locator('.file-unsaved-overlay').count(), 0);
  assert.equal(await toolbar.locator('[data-selection-action="open"]').isDisabled(), true);
  result.cases.push('Modifier and range selection leave the active draft intact and disable ambiguous Open');
  await node('c.md').click({ modifiers: ['Meta'] });
  await toolbar.locator('[data-selection-action="copyPaths"]').click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.deepEqual(copied.split(/\r?\n/).sort(), ['b.md', 'd.md'].map(n => path.join(fixtures, n)).sort());
  result.cases.push('Copy paths uses exactly the toggled selection, including no active-preview file');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new DOMException('Test denied clipboard permission', 'NotAllowedError'); } } }));
  await toolbar.locator('[data-selection-action="copyPaths"]').click();
  await toolbar.getByText('Could not copy paths').waitFor();
  assert.equal((await selected(tree)).length, 2);
  await page.evaluate(() => { delete navigator.clipboard; });
  result.cases.push('Clipboard denial is visible and keeps the selected files intact');
  const downloads = []; page.on('download', download => downloads.push(download));
  await toolbar.locator('[data-selection-action="download"]').click();
  for (let i = 0; i < 60 && downloads.length < 2; i++) await sleep(100);
  assert.equal(downloads.length, 2);
  assert.deepEqual(downloads.map(d => d.suggestedFilename()).sort(), ['b.md', 'd.md']);
  for (const d of downloads) { const dest = path.join(out, d.suggestedFilename()); await d.saveAs(dest); assert.equal(fs.readFileSync(dest, 'utf8'), '# Original ' + d.suggestedFilename() + '\n'); }
  result.cases.push('Multi-download returns the actual bytes of precisely the selected files');
  await node('b.md').focus(); await node('b.md').press('Control+a');
  assert.equal((await selected(tree)).length, await tree.locator('.tree-node').count());
  assert.equal(await toolbar.locator('[data-selection-action="download"]').isDisabled(), true);
  await node('b.md').press('Home'); assert.equal(await tree.locator('.tree-node').first().evaluate(e => e === document.activeElement), true); await page.keyboard.press('ArrowDown'); assert.equal(await tree.locator('.tree-node').nth(1).evaluate(e => e === document.activeElement), true); await node('a.md').focus(); await page.keyboard.press(' '); await page.keyboard.press('Shift+ArrowDown');
  assert.deepEqual(await selected(tree), ['a.md','b.md'].map(n => path.join(fixtures, n)));
  assert.equal(await editor.inputValue(), '# Selection draft\n');
  result.cases.push('Ctrl+A, Home, arrows and Shift+arrow select visible rows without terminal input or preview navigation');
  await node('b.md').press(' '); await node('b.md').press('Enter');
  const dialog = page.locator('.file-unsaved-overlay'); await dialog.waitFor(); await dialog.locator('[data-file-decision="cancel"]').click();
  assert.equal(await editor.inputValue(), '# Selection draft\n');
  await toolbar.locator('[data-selection-action="open"]').click(); await dialog.waitFor(); await dialog.locator('[data-file-decision="save"]').click();
  await preview.locator('.file-document-mode[data-mode="edit"]').click();
  await page.waitForFunction(() => document.querySelector('.file-browser-preview textarea')?.value === '# Original b.md\n');
  assert.equal(fs.readFileSync(path.join(fixtures, 'a.md'), 'utf8'), '# Selection draft\n');
  result.cases.push('Explicit Enter/Open respects Cancel and writes the previous draft before changing the preview');
  await node('c.md').locator('input').click();
  const treeSelection = await selected(tree);
  await wrapper.locator('[data-browser-navigation="refresh"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-browser-navigation="refresh"]')?.disabled);
  assert.deepEqual(await selected(tree), treeSelection);
  otherSession = (await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 90, rows: 30, workingDirectory: other, launchRequestId: crypto.randomUUID() })).id;
  await page.locator(`.session-item[data-session-id="${otherSession}"] .session-title`).click();
  await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();
  assert.deepEqual(await selected(tree), treeSelection);
  result.cases.push('Tree refresh and session return preserve the exact multi-selection');
  await page.screenshot({ path: path.join(out, 'tree-selection.png') });
  // Open the same real directory in the modal through a terminal file link.
  await terminal.click();
  await page.evaluate(target => window.mmDebug.terminals.get(window.mmDebug.activeId).terminal._core._linkProviderService.linkProviders.at(-2)._handler(new MouseEvent('click'), target), fixtures);
  const modal = page.locator('#file-viewer-modal'), list = modal.locator('.file-list');
  const item = name => list.locator('.file-list-item').filter({ has: page.locator('.file-name', { hasText: new RegExp('^' + name.replace('.', '\\.') + '$') }) });
  await item('a.md').click(); assert.equal(await modal.locator('.file-viewer-title').innerText(), path.basename(fixtures));
  await item('c.md').click({ modifiers: ['Shift'] });
  assert.deepEqual(await selected(list), ['a.md','b.md','c.md'].map(n => path.join(fixtures, n)));
  await item('b.md').click({ modifiers: ['Control'] });
  await modal.locator('[data-selection-action="copyPaths"]').click();
  assert.deepEqual((await page.evaluate(() => navigator.clipboard.readText())).split(/\r?\n/).sort(), ['a.md','c.md'].map(n => path.join(fixtures, n)).sort());
  result.cases.push('Directory single click selects only; Shift/Ctrl and clipboard follow the same exact selection model');
  await item('Ünicode space.md').dblclick(); await modal.locator('.file-document-mode[data-mode="edit"]').click(); await modal.locator('textarea').waitFor();
  assert.equal(await modal.locator('textarea').inputValue(), '# Original Ünicode space.md\n');
  await modal.locator('[data-file-navigation="back"]').click(); await item('Ünicode space.md').waitFor();
  assert.deepEqual(await selected(list), [path.join(fixtures, 'Ünicode space.md')]);
  result.cases.push('Double click opens Unicode/space paths and Back restores the selected directory row');
  await item('a.md').click(); await item('c.md').locator('input').click();
  await modal.locator('#file-viewer-dock-btn').click(); const dock = page.locator('#file-viewer-dock');
  assert.deepEqual(await selected(dock), ['a.md','c.md'].map(n => path.join(fixtures, n)));
  result.cases.push('Checkbox selection remains separate from opening and survives the modal/dock transfer');
  await page.screenshot({ path: path.join(out, 'directory-selection-dock.png') });
  const dockRow = name => dock.locator('.file-list-item').filter({ has: page.locator('.file-name', { hasText: new RegExp('^' + name.replace('.', '\\.') + '$') }) });
  fs.unlinkSync(path.join(fixtures, 'c.md'));
  await dock.locator('#dock-refresh').click(); await dockRow('a.md').waitFor();
  assert.deepEqual(await selected(dock), [path.join(fixtures, 'a.md')]);
  await dock.locator('[data-selection-action="copyPaths"]').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), path.join(fixtures, 'a.md'));
  fs.writeFileSync(path.join(fixtures, 'c.md'), '# Original c.md\n');
  await dock.locator('#dock-refresh').click(); await dockRow('c.md').waitFor();
  result.cases.push('External deletion removes the missing file from restored multi-selection and clipboard actions');
  await dockRow('b.md').click(); await dockRow('d.md').click({ modifiers: ['Control'] });
  await dock.locator('#dock-refresh').click(); await dockRow('d.md').waitFor();
  await dockRow('c.md').click({ modifiers: ['Shift'] });
  assert.deepEqual(await selected(dock), ['c.md','d.md'].map(n => path.join(fixtures, n)));
  result.cases.push('Directory refresh preserves the last range anchor rather than resetting it to the first selected file');
  await dock.locator('#dock-close').click();
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator('#btn-mobile-strip-files').isVisible()) await page.locator('#btn-mobile-strip-files').tap();
  else { await page.locator('#btn-mobile-actions-menu').tap(); await page.locator('#btn-mobile-tab-files').tap(); }
  if (await wrapper.locator('.file-browser-back').isVisible()) await wrapper.locator('.file-browser-back').tap();
  await tree.waitFor();
  await node('b.md').locator('input').tap(); // Toggle the previous b/c selection to just c.
  await node('a.md').locator('input').tap();
  assert.deepEqual((await selected(tree)).sort(), ['a.md','c.md'].map(n => path.join(fixtures, n)).sort());
  assert.equal(await preview.isVisible(), false);
  await node('c.md').locator('input').tap();
  await toolbar.locator('[data-selection-action="open"]').tap();
  await preview.locator('.file-document-mode[data-mode="edit"]').tap();
  await editor.waitFor(); assert.equal(await editor.inputValue(), '# Selection draft\n');
  await wrapper.locator('.file-browser-back').tap();
  await node('d.md').locator('input').tap();
  assert.equal((await selected(tree)).length, 2);
  await page.screenshot({ path: path.join(out, 'touch-selection-390.png') });
  result.cases.push('390px touch toggles selection without hidden previews and explicitly opens the sole selected file');
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
