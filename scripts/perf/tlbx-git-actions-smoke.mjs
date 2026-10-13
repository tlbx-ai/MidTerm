import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('../../docs/marketing/ScreenshotAutomation/node_modules/playwright');
const url = process.env.TLBX_PERF_URL, cookie = process.env.TLBX_COOKIE_HEADER;
const onlyTouch = process.env.TLBX_GIT_ACTIONS_TOUCH_ONLY === '1';
if (!url || !cookie) throw new Error('Authenticated source URL required');
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/git-actions'); fs.mkdirSync(out, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-git-actions-'));
fs.writeFileSync(path.join(fixture, '.gitignore'), '.tlbx/\n'); fs.writeFileSync(path.join(fixture, 'file.txt'), 'Original\n');
const git = args => execFileSync('git', ['-C', fixture, '-c', 'core.hooksPath=' + path.join(fixture, 'no-hooks'), ...args], { windowsHide: true, stdio: 'pipe' });
git(['init', '--quiet']); git(['config', 'user.name', 'Actions acceptance']); git(['config', 'user.email', 'actions@tlbx.invalid']); git(['add', '.']); git(['commit', '--quiet', '-m', 'Baseline']); fs.appendFileSync(path.join(fixture, 'file.txt'), 'Changed\n');
const result = { ok: false, fixture, cases: [], geometry: [], errors: [], pastes: [], inputFrames: [], agentRequests: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); let chrome, browser, context, page, session, savedSettings;
async function api(method, route, data) { const response = await context.request.fetch(url + route, { method, data }); assert.ok(response.ok(), `${route}: ${response.status()}`); const text = await response.text(); return text ? JSON.parse(text.replace(/^\uFEFF/, '')) : null; }
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check'], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) { try { const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break; } catch { await sleep(100); } }
  assert.ok(browser, 'Chrome started');
  async function newPage(touch, viewport) {
    await context?.close(); context = await browser.newContext({ ignoreHTTPSErrors: true, viewport, hasTouch: touch });
    const eq = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]); await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => result.errors.push(error.message));
    page.on('websocket', socket => socket.on('framesent', frame => { if (Buffer.isBuffer(frame.payload) && frame.payload[0] === 0x14) result.inputFrames.push(frame.payload.subarray(5).toString('utf8')); }));
    page.on('request', request => { const pathname = new URL(request.url()).pathname; if (pathname.endsWith('/input/paste') && request.method() === 'POST') result.pastes.push(request.postDataJSON()); if (/appserver|agent.*turn/.test(pathname) && request.method() === 'POST') result.agentRequests.push(pathname); });
  }
  await newPage(false, { width: 1440, height: 1000 }); savedSettings = await api('GET', '/api/settings');
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 90, rows: 30, workingDirectory: fixture, launchRequestId: crypto.randomUUID() })).id;
  async function openGit(touch) {
    await page.goto(url); const title = page.locator(`.session-item[data-session-id="${session}"] .session-title`); await title.waitFor({ state: 'attached' });
    if (touch) { await page.locator('#btn-hamburger').tap(); await title.tap(); await page.locator('#btn-mobile-actions-menu').tap(); await page.locator('#btn-mobile-git').tap(); }
    else { await title.click(); await page.locator(`.session-wrapper[data-session-id="${session}"] .git-indicator`).click(); }
    const dock = page.locator('#git-dock'); await dock.waitFor(); await dock.locator('.git-tree-file[data-path="file.txt"]').click(); await dock.locator('.git-command-section > summary').click(); await dock.locator('.git-command-row [data-action="copy-command"]').first().waitFor(); return dock;
  }
  if (!onlyTouch) {
  for (const language of ['en', 'de', 'bn']) {
    await api('PATCH', '/api/settings', { language }); const dock = await openGit(false); const grip = dock.locator('.git-dock-resize-grip'); await grip.press('Home');
    const geometry = await dock.locator('.git-action-button').evaluateAll(buttons => buttons.filter(button => button.getClientRects().length).map(button => { const r = button.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(button); const text = range.getBoundingClientRect(); return { text: button.textContent, compact: button.classList.contains('git-diff-hunk-action'), width: r.width, height: r.height, x: r.x, right: r.right, textLeft: text.x, textRight: text.right, panelRight: button.closest('#git-dock').getBoundingClientRect().right }; }));
    for (const button of geometry) { assert.ok(button.height >= (button.compact ? 23.9 : 35.9) && button.width >= (button.compact ? 23.9 : 26), JSON.stringify(button)); assert.ok(button.textLeft >= button.x - 1 && button.textRight <= button.right + 1 && button.right <= button.panelRight + 1, JSON.stringify(button)); }
    result.geometry.push({ language, touch: false, geometry });
    const copy = dock.locator('[data-action="copy-command"]').first(); await copy.focus(); await copy.press('Enter'); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await copy.getAttribute('data-command'));
    await page.screenshot({ path: path.join(out, language + '-desktop.png'), animations: 'disabled' }); await dock.locator('#git-dock-close').click();
  }
  result.cases.push('English/German/Bengali text actions fit a real 250px dock, preserve readable labels and execute keyboard Copy with exact clipboard contents');
  await api('PATCH', '/api/settings', { language: 'en' }); const dock = await openGit(false), row = dock.locator('.git-command-row').first(), copy = row.locator('[data-action="copy-command"]'), status = row.locator('.git-action-status');
  await page.evaluate(() => { window.originalGitClipboardWrite = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = async text => { await new Promise(resolve => { window.releaseGitClipboard = resolve; }); return window.originalGitClipboardWrite(text); }; });
  await copy.click(); await page.waitForFunction(() => document.querySelector('#git-dock [data-action="copy-command"]').getAttribute('aria-busy') === 'true'); assert.equal(await copy.isDisabled(), true); assert.ok((await status.innerText()).includes('Copying'));
  await page.screenshot({ path: path.join(out, 'copy-busy.png'), animations: 'disabled' }); await page.evaluate(() => window.releaseGitClipboard()); await page.waitForFunction(() => !document.querySelector('#git-dock [data-action="copy-command"]').disabled); assert.equal(await status.innerText(), 'Copied');
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new DOMException('Acceptance permission denial', 'NotAllowedError'); }; });
  await copy.click(); await status.locator('xpath=.').filter({ hasText: 'Could not copy' }).waitFor(); assert.equal(await status.getAttribute('role'), 'alert'); assert.equal(await copy.isDisabled(), false);
  assert.equal(await status.evaluate(el => el.getBoundingClientRect().right <= el.closest('#git-dock').getBoundingClientRect().right && el.closest('.git-panel-inspector').scrollWidth <= el.closest('.git-panel-inspector').clientWidth + 1), true);
  await page.screenshot({ path: path.join(out, 'copy-error.png'), animations: 'disabled' }); await page.evaluate(() => { navigator.clipboard.writeText = window.originalGitClipboardWrite; }); await copy.click(); await page.waitForFunction(() => document.querySelector('#git-dock .git-action-status').textContent === 'Copied');
  result.cases.push('Clipboard busy/permission error/retry remain visible, prevent double activation and retain a usable focused control');
  let releasePaste; const held = new Promise(resolve => { releasePaste = resolve; });
  await page.route('**/input/paste', async route => { await held; await route.continue(); });
  const insert = row.locator('[data-action="insert-command"]'), command = await insert.getAttribute('data-command'); await insert.click(); assert.equal(await insert.isDisabled(), true); assert.ok((await status.innerText()).includes('Inserting')); releasePaste();
  await page.waitForFunction(() => document.querySelector('#git-dock .git-action-status').textContent === 'Inserted without running'); await page.unroute('**/input/paste');
  assert.equal(result.pastes.at(-1).text, command); assert.equal(result.pastes.at(-1).historySource, 'git-panel-insert'); assert.ok(!result.pastes.at(-1).text.endsWith('\n') && !result.pastes.at(-1).text.endsWith('\r'));
  await page.route('**/input/paste', route => route.fulfill({ status: 503, body: 'Acceptance unavailable terminal' })); await insert.click(); await status.filter({ hasText: 'Could not insert' }).waitFor(); assert.equal(await insert.isDisabled(), false); await page.unroute('**/input/paste');
  assert.equal(result.inputFrames.some(frame => frame === '\r' || frame === '\n'), false); assert.deepEqual(result.agentRequests, []); await dock.locator('#git-dock-close').click();
  result.cases.push('Terminal insertion has real acknowledged busy/success/error states and sends the exact snippet without a separate Enter or provider turn');
  }
  await newPage(true, { width: 390, height: 844 });
  for (const language of ['en', 'de', 'bn']) {
    await api('PATCH', '/api/settings', { language }); const mobile = await openGit(true);
    const geometry = await mobile.locator('.git-action-button, .git-inspector-back, .git-diff-wrap, .git-path-details, .git-dock-actions button').evaluateAll(buttons => buttons.filter(button => button.getClientRects().length).map(button => { const r = button.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(button); const text = range.getBoundingClientRect(); return { text: button.textContent, width: r.width, height: r.height, x: r.x, right: r.right, textLeft: text.x, textRight: text.right }; }));
    for (const button of geometry) { assert.ok(button.height >= 43.9); assert.ok(button.textLeft >= button.x - 1 && button.textRight <= button.right + 1 && button.right <= 391, JSON.stringify(button)); }
    result.geometry.push({ language, touch: true, geometry }); await mobile.locator('[data-action="copy-command"]').first().tap(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await mobile.locator('[data-action="copy-command"]').first().getAttribute('data-command'));
    await page.screenshot({ path: path.join(out, language + '-touch-390.png'), animations: 'disabled' }); await mobile.locator('#git-dock-close').tap();
  }
  result.cases.push('The actual mobile actions menu opens Git; 390px coarse-pointer buttons remain at least44px and localized labels stay within nonoverlapping controls');
  assert.deepEqual(result.errors, []); result.ok = true;
} catch (error) { result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>'); result.mobileControls = await page?.evaluate(() => ['#mobile-topbar','#topbar-actions','#btn-mobile-actions-menu','#btn-command-search-compact'].map(selector => { const el = document.querySelector(selector), s = getComputedStyle(el), r = el.getBoundingClientRect(); return { selector, x:r.x, right:r.right, width:r.width, paddingRight:s.paddingRight, position:s.position, display:s.display }; })).catch(() => []); await page?.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled' }).catch(() => {}); process.exitCode = 1; }
finally {
  if (context && savedSettings) await api('PATCH', '/api/settings', { language: savedSettings.language }).catch(error => { result.restoreFailure = String(error); result.ok = false; process.exitCode = 1; });
  if (context && session) await api('DELETE', '/api/sessions/' + session).catch(error => { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; });
  await context?.close(); await browser?.close(); chrome?.kill(); fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ok: result.ok, cases: result.cases, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
