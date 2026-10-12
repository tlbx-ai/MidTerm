import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('../../docs/marketing/ScreenshotAutomation/node_modules/playwright');
const url = process.env.TLBX_PERF_URL, cookie = process.env.TLBX_COOKIE_HEADER;
if (!url || !cookie) throw new Error('Authenticated source URL required');
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/git-repository'); fs.mkdirSync(out, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-git-repositories-'));
const roots = ['Repository A', 'Repository B', 'Unbound C'].map(name => path.join(fixture, name));
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' }).toString('utf8');
for (const [i, root] of roots.entries()) {
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'shared.txt'), `Baseline ${i}\n`); fs.writeFileSync(path.join(root, '.gitignore'), '.tlbx/\n');
  git(root, ['init', '--quiet']); git(root, ['config', 'user.name', 'Repository acceptance']); git(root, ['config', 'user.email', 'repo@tlbx.invalid']); git(root, ['config', 'commit.gpgSign', 'false']); git(root, ['add', '.']); git(root, ['commit', '--quiet', '-m', 'Baseline']);
  fs.writeFileSync(path.join(root, 'shared.txt'), `Change ${i}\n`);
}
const result = { ok: false, fixture, cases: [], requests: [], errors: [], inputFrames: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); let chrome, browser, context, page, session;
async function request(method, route, data) { return context.request.fetch(url + route, { method, data }); }
async function api(method, route, data) { const r = await request(method, route, data); assert.ok(r.ok(), `${route}: ${r.status()}`); const text = await r.text(); return text ? JSON.parse(text.replace(/^\uFEFF/, '')) : null; }
const operation = (root, action = 'stage') => ({ sessionId: session, repoRoot: root, operationId: crypto.randomUUID(), action, paths: ['shared.txt'] });
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check'], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) { try { const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break; } catch { await sleep(100); } }
  assert.ok(browser); context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } }); const eq = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]);
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', workingDirectory: roots[0], launchRequestId: crypto.randomUUID() })).id;
  await api('POST', '/api/git/repos', { sessionId: session, path: roots[1], label: 'Repository B', role: 'target' });
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => result.errors.push(error.message)); page.on('websocket', socket => socket.on('framesent', frame => { if (Buffer.isBuffer(frame.payload) && frame.payload[0] === 0x14) result.inputFrames++; }));
  await page.goto(url); await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();
  const dock = page.locator('#git-dock');
  const openRoot = async root => {
    const escaped = await page.evaluate(value => CSS.escape(value), root);
    await page.locator(`.session-wrapper[data-session-id="${session}"] .git-indicator[data-repo-root=${escaped}]`).click();
    await page.waitForFunction(root => document.querySelector('#git-dock .git-panel-summary-subtitle')?.getAttribute('title') === root, root);
    await dock.locator('.git-dock-resize-grip').press('End');
  };
  await openRoot(roots[1]); await dock.locator('.git-tree-file[data-path="shared.txt"]').click(); await dock.locator('.git-command-text').first().waitFor();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']); await dock.locator('[data-action="copy-command"]').nth(1).click(); await dock.locator('.git-action-status').nth(1).filter({ hasText: 'Copied' }).waitFor();
  const command = await page.evaluate(() => navigator.clipboard.readText()); assert.ok(command.includes(`git -C '${roots[1]}'`));
  const copiedOutput = execFileSync('pwsh', ['-NoProfile', '-Command', command], { cwd: roots[0], windowsHide: true, stdio: 'pipe' }).toString('utf8'); assert.ok(copiedOutput.includes('+Change 1')); assert.ok(!copiedOutput.includes('+Change 0')); assert.equal(git(roots[0], ['diff', '--cached', '--name-only']), '');
  result.cases.push('A real clipboard command runs in PowerShell from repository A but explicitly addresses selected repository B');
  let release; const gate = new Promise(resolve => { release = resolve; }); let started; const entered = new Promise(resolve => { started = resolve; });
  await page.route('**/api/git/operations', async route => { result.requests.push(route.request().postDataJSON()); started(); await gate; const response = await route.fetch(); await route.fulfill({ response }); });
  await dock.locator('[data-action="stage-file"][data-path="shared.txt"]').click(); await entered; await openRoot(roots[0]);
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/git/operations' && r.request().method() === 'POST'); release(); const body = await (await response).json(); assert.equal(body.state, 'completed');
  assert.equal(result.requests[0].repoRoot, roots[1]); assert.equal(git(roots[0], ['diff', '--cached', '--name-only']), ''); assert.equal(git(roots[1], ['diff', '--cached', '--name-only']).trim(), 'shared.txt'); assert.ok((await dock.locator('.git-panel-summary-subtitle').getAttribute('title')) === roots[0]);
  await page.unroute('**/api/git/operations'); await api('POST', '/api/git/operations', operation(roots[1], 'unstage'));
  result.cases.push('Switching to A during a delayed B stage does not retarget the captured operation or overwrite the current A view');
  for (const manipulated of [roots[2], path.join(roots[1], 'nested')]) { const denied = await request('POST', '/api/git/operations', operation(manipulated)); assert.equal(denied.status(), 403); assert.equal((await denied.json()).errorCode, 'repository_unbound'); }
  assert.equal(git(roots[2], ['diff', '--cached', '--name-only']), '');
  await api('DELETE', `/api/git/repos?sessionId=${session}&repoRoot=${encodeURIComponent(roots[1])}`); const removed = await request('POST', '/api/git/operations', operation(roots[1])); assert.equal(removed.status(), 403); assert.equal((await removed.json()).errorCode, 'repository_unbound'); assert.equal(git(roots[1], ['diff', '--cached', '--name-only']), '');
  result.cases.push('Unbound, manipulated and removed repository roots are rejected before any index mutation');
  for (const [i, root] of roots.entries()) assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), `Change ${i}\n`);
  assert.equal(result.inputFrames, 0); assert.deepEqual(result.errors, []); await page.screenshot({ path: path.join(out, 'selected-repository.png'), animations: 'disabled' }); result.ok = true;
} catch (error) { result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>'); await page?.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled' }).catch(() => {}); process.exitCode = 1; }
finally {
  if (context && session) await api('DELETE', '/api/sessions/' + session).catch(error => { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; });
  await context?.close(); await browser?.close(); chrome?.kill(); fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ok: result.ok, cases: result.cases, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
