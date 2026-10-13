import assert from 'node:assert/strict';
import { revealControl } from './ui-controls.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('../../docs/marketing/ScreenshotAutomation/node_modules/playwright');
const url = process.env.TLBX_PERF_URL, cookie = process.env.TLBX_COOKIE_HEADER;
if (!url || !cookie) throw new Error('Authenticated source URL required');
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/git-terminal-boundary'); fs.mkdirSync(out, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-git-boundary-'));
const git = args => execFileSync('git', ['-C', fixture, ...args], { windowsHide: true, stdio: 'pipe' }).toString('utf8');
fs.writeFileSync(path.join(fixture, 'file.txt'), 'Baseline\n'); fs.writeFileSync(path.join(fixture, '.gitignore'), '.tlbx/\n*.marker\napp.cjs\n');
git(['init', '--quiet']); git(['config', 'user.name', 'Boundary acceptance']); git(['config', 'user.email', 'boundary@tlbx.invalid']); git(['config', 'commit.gpgSign', 'false']); git(['add', '.']); git(['commit', '--quiet', '-m', 'Baseline']);
fs.writeFileSync(path.join(fixture, 'file.txt'), 'Reviewed change\n');
fs.writeFileSync(path.join(fixture, 'app.cjs'), "const fs=require('node:fs');if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdin.on('data',data=>fs.appendFileSync('input.marker',data));process.stdin.resume();fs.writeFileSync('ready.marker','ready');process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[HAPPLICATION_READY\\r\\n\\x1b[3;1HBusy TUI prompt > ');setInterval(()=>{},1000);\n");
const result = { ok: false, fixture, cases: [], errors: [], pasteRequests: [], turnRequests: [], shellGuards: [], inputFrames: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); let chrome, browser, context, page; const sessions = [];
async function api(method, route, data) { const r = await context.request.fetch(url + route, { method, data }); assert.ok(r.ok(), `${route}: ${r.status()}`); const text = await r.text(); return text ? JSON.parse(text.replace(/^\uFEFF/, '')) : null; }
async function openSession(session) {
  const title = page.locator(`.session-item[data-session-id="${session}"] .session-title`);
  await title.waitFor(); const titleBox = await title.boundingBox(); assert.ok(titleBox);
  await title.click({ position: { x: 4, y: titleBox.height / 2 } });
  const root = await page.evaluate(value => CSS.escape(value), fixture);
  await page.locator(`.session-wrapper[data-session-id="${session}"] .git-indicator[data-repo-root=${root}]`).click();
  const dock = page.locator('#git-dock'); await dock.locator('.git-dock-resize-grip').press('End'); await dock.locator('.git-tree-file[data-path="file.txt"]').click(); await dock.locator('.git-command-section > summary').click(); await dock.locator('.git-command-text').first().waitFor(); return dock;
}
async function stageAndUnstage(dock) {
  for (const action of ['stage-file', 'unstage-file']) {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/git/operations' && r.request().method() === 'POST');
    await dock.locator(`[data-action="${action}"][data-path="file.txt"]`).click(); assert.equal((await (await response).json()).state, 'completed');
    await dock.locator(`[data-action="${action === 'stage-file' ? 'unstage-file' : 'stage-file'}"][data-path="file.txt"]`).waitFor();
    assert.equal(git(['diff', '--cached', '--name-only']).trim(), action === 'stage-file' ? 'file.txt' : '');
  }
}
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check'], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) { try { const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break; } catch { await sleep(100); } }
  assert.ok(browser); context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } }); const eq = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]); await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const shell = (await api('POST', '/api/sessions', { shell: 'Pwsh', workingDirectory: fixture, launchRequestId: crypto.randomUUID() })).id; sessions.push(shell);
  page = await context.newPage(); page.setDefaultTimeout(25000); page.on('pageerror', error => result.errors.push(error.message)); page.on('request', request => { const pathname = new URL(request.url()).pathname; if (pathname.endsWith('/input/paste')) result.pasteRequests.push(request.postDataJSON()); if (pathname.endsWith('/agent-control/turn') || pathname.endsWith('/input/submit')) result.turnRequests.push(pathname); });
  page.on('websocket', socket => socket.on('framesent', frame => { if (Buffer.isBuffer(frame.payload) && frame.payload[0] === 0x14) result.inputFrames++; })); await page.goto(url);
  let dock = await openSession(shell); await page.waitForFunction(() => document.querySelector('#git-dock [data-action="insert-command"]')?.disabled === false); await stageAndUnstage(dock);
  await dock.locator('.git-tree-file[data-path="file.txt"]').click(); const insert = dock.locator('[data-action="insert-command"]').first(); const insertedCommand = await insert.getAttribute('data-command'); await revealControl(insert); await insert.click();
  await dock.locator('.git-action-status').first().filter({ hasText: 'Inserted without running' }).waitFor(); assert.equal(result.pasteRequests.length, 1); assert.equal(result.pasteRequests[0].text, insertedCommand); assert.ok(!/[\r\n]/.test(result.pasteRequests[0].text));
  await dock.locator('#git-dock-close').click(); await api('DELETE', '/api/sessions/' + shell); sessions.splice(sessions.indexOf(shell), 1);
  result.cases.push('Direct stage/unstage works at a real PowerShell prompt without terminal input');
  const app = (await api('POST', '/api/sessions', { shell: 'Pwsh', workingDirectory: fixture, launchCommand: `node '${path.join(fixture, 'app.cjs').replaceAll("'", "''")}'`, launchRequestId: crypto.randomUUID() })).id; sessions.push(app);
  for (let i = 0; i < 100 && !fs.existsSync(path.join(fixture, 'ready.marker')); i++) await sleep(100); assert.ok(fs.existsSync(path.join(fixture, 'ready.marker')));
  for (let i = 0; i < 100; i++) { const current = (await api('GET', '/api/sessions')).sessions.find(session => session.id === app); if (current.foregroundName?.replace(/\.exe$/i, '').toLowerCase() === 'node') break; assert.ok(i < 99, 'Application is the reported foreground process'); await sleep(100); }
  dock = await openSession(app); await page.waitForFunction(() => document.querySelector('#git-dock [data-action="insert-command"]')?.disabled === true); const copy = dock.locator('[data-action="copy-command"]').first(); await revealControl(copy); await copy.click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await copy.getAttribute('data-command'));
  await dock.locator('[data-action="insert-command"]').first().evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const blockedApp = await context.request.post(url + `/api/sessions/${app}/input/paste`, { data: { text: 'git status', bracketedPaste: false, historySource: 'git-panel-insert' } }); assert.equal(blockedApp.status(), 409); result.shellGuards.push({ surface: 'application', status: blockedApp.status() });
  await stageAndUnstage(dock); assert.ok(!fs.existsSync(path.join(fixture, 'input.marker'))); await page.screenshot({ path: path.join(out, 'busy-application.png'), animations: 'disabled' }); await dock.locator('#git-dock-close').click(); await api('DELETE', '/api/sessions/' + app); sessions.splice(sessions.indexOf(app), 1);
  result.cases.push('An actual foreground application receives zero bytes; Insert is disabled and guarded even for a forced click, Copy and backend staging still work');
  const boot = await api('POST', '/api/workers/bootstrap', { name: 'Git controller boundary acceptance', workingDirectory: 'Q:\\repos\\Jpa', profile: 'codex', agentControlled: true, injectGuidance: false, appServerControlOnly: true });
  const controller = boot.session?.id ?? boot.sessionId ?? boot.id; assert.ok(controller, 'Real controller session created'); sessions.push(controller); await api('POST', '/api/git/repos', { sessionId: controller, path: fixture, role: 'target', label: 'Boundary fixture' });
  dock = await openSession(controller); assert.equal(await dock.locator('[data-action="insert-command"]').first().isDisabled(), true);
  const blockedController = await context.request.post(url + `/api/sessions/${controller}/input/paste`, { data: { text: 'git status', bracketedPaste: false, historySource: 'git-panel-insert' } }); assert.equal(blockedController.status(), 409); result.shellGuards.push({ surface: 'controller', status: blockedController.status() });
  await stageAndUnstage(dock); await page.screenshot({ path: path.join(out, 'agent-controller.png'), animations: 'disabled' });
  const actual = (await api('GET', '/api/sessions')).sessions.find(session => session.id === controller); assert.equal(actual.appServerControlOnly, true);
  assert.equal(result.inputFrames, 0); assert.equal(result.pasteRequests.length, 1); assert.deepEqual(result.turnRequests, []); assert.deepEqual(result.errors, []); assert.equal(fs.readFileSync(path.join(fixture, 'file.txt'), 'utf8'), 'Reviewed change\n');
  result.cases.push('A real Agent Controller session rooted at JPA stages its bound fixture repository without paste, terminal keys or provider turn requests'); result.ok = true;
} catch (error) { result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>'); await page?.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled' }).catch(() => {}); process.exitCode = 1; }
finally {
  for (const session of sessions) await api('DELETE', '/api/sessions/' + session).catch(error => { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; });
  await context?.close(); await browser?.close(); chrome?.kill(); fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ok: result.ok, cases: result.cases, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
