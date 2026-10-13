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
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/git-commit'); fs.mkdirSync(out, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-git-commit-'));
const git = args => execFileSync('git', ['-C', fixture, ...args], { windowsHide: true, stdio: 'pipe' }).toString('utf8');
const write = (name, text) => fs.writeFileSync(path.join(fixture, name), text);
write('a.txt', 'A original\n'); write('b.txt', 'B original\n'); write('.gitignore', '.tlbx/\n');
git(['init', '--quiet']); git(['config', 'user.name', 'Commit acceptance']); git(['config', 'user.email', 'commit@tlbx.invalid']); git(['config', 'commit.gpgSign', 'false']); git(['add', '.']); git(['commit', '--quiet', '-m', 'Baseline']);
write('a.txt', 'A index\n'); write('b.txt', 'B working\n'); write('new ä.txt', 'New content\n');
const result = { ok: false, fixture, cases: [], operations: [], responses: [], errors: [], inputFrames: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); let chrome, browser, context, page, session;
async function api(method, route, data) { const response = await context.request.fetch(url + route, { method, data }); assert.ok(response.ok(), `${route}: ${response.status()}`); const text = await response.text(); return text ? JSON.parse(text.replace(/^\uFEFF/, '')) : null; }
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check'], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) { try { const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break; } catch { await sleep(100); } }
  assert.ok(browser, 'Chrome started'); context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const eq = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]);
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 90, rows: 30, workingDirectory: fixture, launchRequestId: crypto.randomUUID() })).id;
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => result.errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/git/operations') result.operations.push(request.postDataJSON()); });
  page.on('websocket', socket => socket.on('framesent', frame => { if (Buffer.isBuffer(frame.payload) && frame.payload[0] === 0x14) result.inputFrames++; }));
  await page.goto(url); await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click(); await page.locator(`.session-wrapper[data-session-id="${session}"] .git-indicator`).click();
  const dock = page.locator('#git-dock'); await dock.locator('.git-dock-resize-grip').press('End'); const message = dock.locator('.git-commit-message'), commit = dock.locator('[data-action="commit-staged"]'), status = dock.locator('.git-operation-status');
  const action = async (name, file) => { const locator = file ? dock.locator(`[data-action="${name}"][data-path="${file}"]`) : dock.locator(`[data-action="${name}"]`); const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/git/operations' && r.request().method() === 'POST'); await locator.click(); const r = await response; const body = await r.json(); result.responses.push({ status: r.status(), body }); await page.waitForFunction(() => !document.querySelector('#git-dock .git-commit-message').readOnly); return body; };
  assert.equal(await commit.isDisabled(), true); await action('stage-file', 'a.txt'); await dock.locator('.git-tree-file[data-scope="staged"][data-path="a.txt"]').waitFor();
  write('a.txt', 'A index\nA later working change\n'); await api('POST', '/api/git/repos/refresh', { sessionId: session, repoRoot: fixture });
  await page.waitForFunction(() => document.querySelectorAll('#git-dock .git-tree-file[data-path="a.txt"]').length === 2);
  await dock.locator('.git-tree-file[data-path="a.txt"][data-scope="staged"]').click(); await dock.locator('.git-diff-lines').waitFor(); assert.ok((await dock.locator('.git-diff-lines').innerText()).includes('A index')); assert.ok(!(await dock.locator('.git-diff-lines').innerText()).includes('later working'));
  await message.fill('Selected index commit ä\n\n# Literal body'); const first = await action('commit-staged'); assert.equal(first.state, 'completed'); assert.equal(await message.inputValue(), '');
  assert.equal(git(['show', 'HEAD:a.txt']).replaceAll('\r\n', '\n'), 'A index\n'); assert.equal(git(['show', 'HEAD:b.txt']).replaceAll('\r\n', '\n'), 'B original\n'); assert.equal(fs.readFileSync(path.join(fixture, 'a.txt'), 'utf8'), 'A index\nA later working change\n');
  result.cases.push('Real stage/index review/selective commit excludes unstaged content and retains later working changes, Unicode message and literal body');
  await action('stage-file', 'new ä.txt'); await dock.locator('.git-tree-file[data-scope="staged"][data-path="new ä.txt"]').waitFor(); await action('unstage-file', 'new ä.txt'); assert.equal(fs.readFileSync(path.join(fixture, 'new ä.txt'), 'utf8'), 'New content\n');
  result.cases.push('Stage/unstage a real untracked Unicode file changes index membership without changing its disk bytes');
  await action('stage-file', 'b.txt'); git(['config', 'user.name', '']); git(['config', 'user.email', '']); await message.fill('Identity retry message'); const missing = await action('commit-staged'); assert.equal(missing.errorCode, 'identity_missing'); assert.equal(await message.inputValue(), 'Identity retry message'); assert.equal(await status.getAttribute('role'), 'alert'); await page.screenshot({ path: path.join(out, 'identity-error.png'), animations: 'disabled' });
  git(['config', 'user.name', 'Commit acceptance']); git(['config', 'user.email', 'commit@tlbx.invalid']); assert.equal((await action('commit-staged')).state, 'completed');
  result.cases.push('Missing identity produces a concrete visible error and retained message; configured identity retries the same draft successfully');
  const hooks = path.join(fixture, '.git', 'acceptance-hooks'); fs.mkdirSync(hooks); const hook = path.join(hooks, 'pre-commit'); fs.writeFileSync(hook, '#!/bin/sh\necho "Acceptance hook rejected" >&2\nexit 1\n'); git(['config', 'core.hooksPath', hooks]);
  await action('stage-file', 'a.txt'); await message.fill('Hook retry message'); const failed = await action('commit-staged'); assert.equal(failed.errorCode, 'git_failed'); await dock.locator('.git-operation-details > summary').click(); assert.ok((await dock.locator('.git-operation-details').innerText()).includes('Acceptance hook rejected')); assert.equal(await message.inputValue(), 'Hook retry message'); await page.screenshot({ path: path.join(out, 'hook-error.png'), animations: 'disabled' });
  fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n'); assert.equal((await action('commit-staged')).state, 'completed');
  result.cases.push('A real rejecting pre-commit hook preserves staged bytes and commit draft; correcting the hook allows retry');
  write('b.txt', 'B acknowledgement test\n'); await api('POST', '/api/git/repos/refresh', { sessionId: session, repoRoot: fixture }); await dock.locator('[data-action="stage-file"][data-path="b.txt"]').waitFor(); await action('stage-file', 'b.txt'); await message.fill('Lost acknowledgement commit');
  const countBefore = Number(git(['rev-list', '--count', 'HEAD']).trim()); let lost = false;
  await page.route('**/api/git/operations', async route => { const request = route.request().postDataJSON(); if (request.action === 'commit' && !lost) { lost = true; const r = await route.fetch(); assert.equal((await r.json()).state, 'completed'); await route.abort('connectionclosed'); } else await route.continue(); });
  await commit.click(); await dock.locator('[data-action="retry-operation"]').waitFor(); assert.equal(await message.inputValue(), 'Lost acknowledgement commit'); assert.equal(await commit.isDisabled(), true); assert.equal(await dock.locator('[data-action="stage-all"]').isDisabled(), true); const originalId = result.operations.at(-1).operationId;
  const replay = await action('retry-operation'); assert.equal(replay.state, 'completed'); assert.equal(result.operations.at(-1).operationId, originalId); assert.equal(Number(git(['rev-list', '--count', 'HEAD']).trim()), countBefore + 1); assert.equal(await message.inputValue(), ''); await page.unroute('**/api/git/operations');
  result.cases.push('A lost real commit response retains the message and replays the recorded operation ID without a second commit');
  const all = await action('stage-all'); assert.equal(all.state, 'completed'); assert.ok(all.status.staged.some(file => file.path === 'new ä.txt')); await action('unstage-all'); assert.equal(git(['diff', '--cached', '--name-only']), '');
  assert.equal(result.inputFrames, 0); assert.deepEqual(result.errors, []); await page.screenshot({ path: path.join(out, 'review-commit-ready.png'), animations: 'disabled' });
  result.cases.push('Whole-repository stage/unstage works through backend contracts with zero terminal input frames'); result.ok = true;
} catch (error) { result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>'); await page?.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled' }).catch(() => {}); process.exitCode = 1; }
finally {
  if (context && session) await api('DELETE', '/api/sessions/' + session).catch(error => { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; });
  await context?.close(); await browser?.close(); chrome?.kill(); fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ok: result.ok, cases: result.cases, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
