import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('../../docs/marketing/ScreenshotAutomation/node_modules/playwright');
const url = process.env.TLBX_PERF_URL, cookie = process.env.TLBX_COOKIE_HEADER;
if (!url || !cookie) throw new Error('Authenticated source URL required');
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/file-modes');
fs.mkdirSync(out, { recursive: true });
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-file-modes-'));
const keyboardAcceptance = process.env.TLBX_TEST_KEYBOARD === '1';
if (keyboardAcceptance) { fs.mkdirSync(path.join(fixtures, 'nested')); fs.writeFileSync(path.join(fixtures, 'nested', 'child.txt'), 'Child\n'); }
const original = '# Rendered heading\n\n**Bold** and [Safe](https://example.com)\n\n| Name | Value |\n| --- | --- |\n| One | 1 |\n\n```ts\nconst x = 1;\n```\n\n<script>window.fileModeUnsafe = true</script>\n[Unsafe](javascript:alert(1))\n';
fs.writeFileSync(path.join(fixtures, 'note.md'), original);
fs.writeFileSync(path.join(fixtures, 'code.ts'), 'const value = 42;\n// code\n');
fs.writeFileSync(path.join(fixtures, 'plain.txt'), '<script>plain text</script>\n');
const readOnly = path.join(fixtures, 'readonly.txt'); fs.writeFileSync(readOnly, 'Read only\n'); fs.chmodSync(readOnly, 0o444);
const result = { ok: false, fixtures, cases: [], errors: [], writes: 0 };
let terminalInputFrames = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, browser, context, page, session;
async function api(method, route, data) {
  const response = await context.request.fetch(url + route, { method, data });
  assert.ok(response.ok(), `${route}: ${response.status()}`);
  const raw = await response.text(); return raw ? JSON.parse(raw) : null;
}
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check'], {
    windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')],
  });
  for (let i = 0; i < 100; i++) {
    try { const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break; }
    catch { await sleep(100); }
  }
  if (!browser) throw new Error('Chrome did not start');
  context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 }, hasTouch: true });
  const eq = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]);
  let assetsReady = false;
  for (let i = 0; i < 40; i++) {
    try { const response = await context.request.get(url + '/locales/en.json'); assetsReady = response.ok() && JSON.parse((await response.text()).replace(/^\uFEFF/, ''))['fileViewer.modePreview'] === 'Preview'; } catch {}
    if (assetsReady) break; await sleep(250);
  }
  if (!assetsReady) throw new Error('Source static asset synchronization did not finish');
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 90, rows: 30, workingDirectory: fixtures, launchRequestId: crypto.randomUUID() })).id;
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('websocket', socket => socket.on('framesent', frame => {
    if (Buffer.isBuffer(frame.payload) && frame.payload[0] === 0x14) terminalInputFrames++;
  }));
  page.on('pageerror', error => result.errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/files/save' && request.method() === 'PUT') result.writes++; });
  await page.goto(url); await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();
  const wrapper = page.locator(`.session-wrapper[data-session-id="${session}"]`);
  await wrapper.locator('.session-tab[data-tab="files"]').click();
  const tree = wrapper.locator('.file-browser-tree'), preview = wrapper.locator('.file-browser-preview');
  const row = name => tree.locator('.tree-node').filter({ has: page.locator('.tree-name', { hasText: new RegExp('^' + name.replace('.', '\\.') + '$') }) });
  const mode = (root, value) => root.locator(`.file-document-mode[data-mode="${value}"]`);
  if (keyboardAcceptance) {
    await row('nested').waitFor(); await sleep(300);
    const inputsBefore = terminalInputFrames;
    await row('nested').focus(); await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight'); await row('child.txt').waitFor();
    assert.equal(await row('nested').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('ArrowRight');
    assert.equal(await row('child.txt').evaluate(el => el === document.activeElement && el.tabIndex === 0), true);
    assert.equal(await row('child.txt').getAttribute('aria-level'), '2');
    const treeCdp = await context.newCDPSession(page), treeAx = await treeCdp.send('Accessibility.getFullAXTree');
    const nestedAx = treeAx.nodes.find(n => n.role?.value === 'treeitem' && n.name?.value === 'nested');
    let ancestor = treeAx.nodes.find(n => n.role?.value === 'treeitem' && n.name?.value === 'child.txt');
    let ownsChild = false;
    for (let i = 0; ancestor && i < 20; i++) { if (ancestor.nodeId === nestedAx?.nodeId) { ownsChild = true; break; } ancestor = treeAx.nodes.find(n => n.nodeId === ancestor.parentId); }
    assert.equal(ownsChild, true); await treeCdp.detach();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await row('nested').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await row('nested').getAttribute('aria-expanded'), 'false');
    await page.keyboard.press('Home'); await page.keyboard.type('note');
    assert.equal(await row('note.md').evaluate(el => el === document.activeElement && el.tabIndex === 0), true);
    await page.keyboard.press('Enter'); await preview.locator('.file-document-markdown').waitFor();
    assert.equal(await preview.evaluate(el => el === document.activeElement), true);
    assert.equal(terminalInputFrames, inputsBefore);
    const cdp = await context.newCDPSession(page);
    const ax = await cdp.send('Accessibility.getFullAXTree');
    assert.ok(ax.nodes.some(n => n.role?.value === 'tree'));
    assert.ok(ax.nodes.some(n => n.role?.value === 'treeitem' && n.name?.value === 'nested'));
    await cdp.detach();
    result.cases.push('Tree Space/Right/Left/Home/type-to-select/Enter preserve roving focus, expose AX tree semantics and send zero terminal-input frames');
  }
  await row('note.md').click(); await preview.locator('.file-document-markdown h1').waitFor();
  assert.equal(await preview.locator('.file-document-markdown h1').innerText(), 'Rendered heading');
  assert.equal(await preview.locator('.file-document-markdown table').count(), 1);
  assert.equal(await preview.locator('.file-document-markdown script').count(), 0);
  assert.equal(await preview.locator('.file-document-markdown a[href^="javascript"]').count(), 0);
  assert.equal(await page.evaluate(() => window.fileModeUnsafe === true), false);
  assert.equal(await preview.locator('textarea').count(), 0);
  await mode(preview, 'source').click(); assert.equal(await preview.locator('.file-document-source pre.file-viewer-text').innerText(), original);
  await mode(preview, 'edit').click(); const editor = preview.locator('textarea');
  const draft = '# Draft heading\n\n' + Array.from({ length: 250 }, (_, i) => `Draft line ${i}\n`).join('');
  await editor.fill(draft);
  const position = await editor.evaluate(el => { window.fileModeEditor = el; el.setSelectionRange(12, 24); el.scrollTop = 420; return { start: el.selectionStart, end: el.selectionEnd, top: el.scrollTop }; });
  for (let i = 0; i < 5; i++) {
    await mode(preview, 'preview').click();
    assert.equal(await preview.locator('.file-document-markdown h1').innerText(), 'Draft heading');
    await mode(preview, 'source').click(); assert.equal(await preview.locator('.file-document-source pre.file-viewer-text').innerText(), draft);
    await mode(preview, 'edit').click();
    assert.deepEqual(await editor.evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd, top: el.scrollTop })), position);
    assert.equal(await editor.evaluate(el => el === window.fileModeEditor), true);
  }
  assert.equal(fs.readFileSync(path.join(fixtures, 'note.md'), 'utf8'), original); assert.equal(result.writes, 0);
  await mode(preview, 'preview').click(); await preview.locator('.file-document-markdown').focus(); await page.keyboard.press('Control+s');
  await preview.getByText('Saved', { exact: true }).waitFor();
  assert.equal(fs.readFileSync(path.join(fixtures, 'note.md'), 'utf8'), draft); assert.equal(result.writes, 1);
  await page.screenshot({ path: path.join(out, 'markdown-draft-preview.png') });
  result.cases.push('Markdown/table/source safe rendering; explicit edit; repeated mode changes preserve draft, editor identity, cursor and scroll without writes');
  for (const name of ['code.ts', 'plain.txt', 'readonly.txt']) {
    await row(name).click(); await preview.locator('.file-document-view').waitFor();
    assert.equal(await mode(preview, 'preview').getAttribute('aria-pressed'), 'true');
    assert.equal(await preview.locator('textarea').count(), 0);
    assert.equal(await preview.locator('.file-document-source pre.file-viewer-text').innerText(), fs.readFileSync(path.join(fixtures, name), 'utf8'));
    if (name === 'code.ts') assert.ok((await preview.locator('.hl-keyword').count()) > 0);
    if (name === 'readonly.txt') { assert.equal(await mode(preview, 'edit').isDisabled(), true); await preview.getByText('Read-only', { exact: true }).first().waitFor(); }
  }
  result.cases.push('Code/text default to the same preview, syntax colors preserve exact text, readonly documents cannot enter Edit');
  await wrapper.locator('.session-tab[data-tab="terminal"]').click();
  if (keyboardAcceptance) { await sleep(100); await page.evaluate(() => { window.keyboardViewerOrigin = document.activeElement; }); }
  await page.evaluate(target => window.mmDebug.terminals.get(window.mmDebug.activeId).terminal._core._linkProviderService.linkProviders.at(-2)._handler(new MouseEvent('click'), target), path.join(fixtures, 'note.md'));
  const modal = page.locator('#file-viewer-modal'); await modal.locator('.file-document-markdown h1').waitFor();
  if (keyboardAcceptance) {
    assert.equal(await modal.locator('[role="dialog"]').getAttribute('aria-modal'), 'true');
    for (let i = 0; i < 60; i++) { await page.keyboard.press(i < 30 ? 'Tab' : 'Shift+Tab'); assert.equal(await modal.evaluate(el => el.contains(document.activeElement)), true); }
    await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement === window.keyboardViewerOrigin), true);
    await page.evaluate(target => window.mmDebug.terminals.get(window.mmDebug.activeId).terminal._core._linkProviderService.linkProviders.at(-2)._handler(new MouseEvent('click'), target), fixtures);
    await modal.locator('.file-list-item').first().waitFor();
    await modal.locator('.file-list-item').first().focus(); await page.keyboard.type('plain');
    assert.equal(await modal.locator('.file-list-item[aria-selected="true"] .file-name').innerText(), 'plain.txt');
    await page.keyboard.press('Enter'); await modal.locator('.file-document-source').waitFor();
    await modal.locator('[data-file-navigation="back"]').focus(); await page.keyboard.press('Enter');
    await modal.locator('.file-list-item[aria-selected="true"]').waitFor();
    await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' });
    await page.evaluate(target => window.mmDebug.terminals.get(window.mmDebug.activeId).terminal._core._linkProviderService.linkProviders.at(-2)._handler(new MouseEvent('click'), target), path.join(fixtures, 'note.md'));
    await modal.locator('.file-document-markdown').waitFor();
    result.cases.push('Modal ARIA dialog traps Tab, Escape restores origin focus; directory list supports keyboard type/open/back');
  }
  await mode(modal, 'edit').click(); await modal.locator('textarea').fill('# Modal draft\n');
  await modal.locator('textarea').evaluate(el => { window.modalModeEditor = el; el.setSelectionRange(2, 7); });
  await modal.locator('#file-viewer-dock-btn').click(); const dock = page.locator('#file-viewer-dock');
  assert.equal(await dock.locator('textarea').inputValue(), '# Modal draft\n');
  assert.equal(await dock.locator('textarea').evaluate(el => el === window.modalModeEditor), true);
  await mode(dock, 'preview').click(); assert.equal(await dock.locator('.file-document-markdown h1').innerText(), 'Modal draft');
  await dock.locator('#dock-undock').click();
  assert.equal(await mode(modal, 'preview').getAttribute('aria-pressed'), 'true');
  await mode(modal, 'edit').click(); assert.deepEqual(await modal.locator('textarea').evaluate(el => [el.selectionStart, el.selectionEnd]), [2, 7]);
  await page.keyboard.press('Control+s'); await modal.getByText('Saved', { exact: true }).waitFor();
  assert.equal(fs.readFileSync(path.join(fixtures, 'note.md'), 'utf8'), '# Modal draft\n');
  await page.setViewportSize({ width: 390, height: 844 }); await mode(modal, 'preview').tap();
  assert.equal(await modal.locator('.file-document-modes').evaluate(el => el.getBoundingClientRect().right <= innerWidth), true);
  await page.screenshot({ path: path.join(out, 'modal-preview-390.png') });
  result.cases.push('Modal/dock share preview/source/edit and retain the exact draft/editor/selection through docking and mobile mode changes');
  await modal.locator('.modal-close').click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const name of ['plain.txt', 'code.ts', 'readonly.txt']) {
    await page.evaluate(target => window.mmDebug.terminals.get(window.mmDebug.activeId).terminal._core._linkProviderService.linkProviders.at(-2)._handler(new MouseEvent('click'), target), path.join(fixtures, name));
    await modal.locator('.file-document-source').waitFor();
    assert.equal(await mode(modal, 'preview').getAttribute('aria-pressed'), 'true');
    assert.equal(await modal.locator('.file-document-source pre.file-viewer-text').innerText(), fs.readFileSync(path.join(fixtures, name), 'utf8'));
    if (name === 'readonly.txt') {
      assert.equal(await mode(modal, 'edit').isDisabled(), true);
      await modal.locator('#file-viewer-dock-btn').click();
      assert.equal(await mode(dock, 'edit').isDisabled(), true);
      assert.equal(await dock.locator('textarea').count(), 0);
      await dock.locator('#dock-close').click();
    } else await modal.locator('.modal-close').click();
  }
  assert.equal(result.writes, 2);
  result.cases.push('Modal/dock readonly and plain/code preview match Files and perform no implicit writes');
  if (keyboardAcceptance) {
    await page.evaluate(target => window.mmDebug.terminals.get(window.mmDebug.activeId).terminal._core._linkProviderService.linkProviders.at(-2)._handler(new MouseEvent('click'), target), path.join(fixtures, 'note.md'));
    await mode(modal, 'edit').focus(); await page.keyboard.press('Enter');
    await modal.locator('textarea').fill('# Keyboard save decision\n');
    await page.route('**/api/files/save**', async route => { await sleep(500); await route.continue(); });
    await page.evaluate(target => window.mmDebug.terminals.get(window.mmDebug.activeId).terminal._core._linkProviderService.linkProviders.at(-2)._handler(new MouseEvent('click'), target), path.join(fixtures, 'code.ts'));
    const decision = page.locator('.file-unsaved-overlay'); await decision.waitFor();
    await decision.locator('[data-file-decision="save"]').focus();
    const beforeBusyInput = terminalInputFrames;
    await page.keyboard.press('Enter');
    for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); assert.equal(await decision.evaluate(el => el.contains(document.activeElement)), true); }
    await decision.waitFor({ state: 'hidden' }); await modal.locator('.file-document-source').waitFor();
    assert.equal(fs.readFileSync(path.join(fixtures, 'note.md'), 'utf8'), '# Keyboard save decision\n');
    assert.equal(terminalInputFrames, beforeBusyInput);
    await page.unroute('**/api/files/save**');
    await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' });
    result.cases.push('Keyboard save decision holds focus during delayed Save and does not send Enter/Tab to the terminal');
  }
  assert.deepEqual(result.errors, []); result.ok = true;
} catch (error) {
  result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>');
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); process.exitCode = 1;
} finally {
  fs.chmodSync(readOnly, 0o666);
  if (context && session) try { await api('DELETE', '/api/sessions/' + session); } catch (error) { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; }
  await context?.close(); await browser?.close(); chrome?.kill();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, cases: result.cases, writes: result.writes, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
