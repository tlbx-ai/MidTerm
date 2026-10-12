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
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/git-commit-comparison'); fs.mkdirSync(out, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-commit-comparison-'));
const git = args => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' }).toString('utf8').trimEnd();
const write = (name, text) => fs.writeFileSync(path.join(root, name), text);
git(['init', '--quiet', '--initial-branch=main']); git(['config', 'user.name', 'Commit comparison acceptance']); git(['config', 'user.email', 'comparison@tlbx.invalid']); git(['config', 'commit.gpgSign', 'false']); git(['config', 'core.autocrlf', 'false']);
fs.mkdirSync(path.join(root, 'folder')); write('.gitignore', '.tlbx/\n'); write('root.txt', 'Root ä\n'); write('folder/nested.txt', 'Nested 字\n'); git(['add', '.']); git(['commit', '--quiet', '-m', 'Root commit']); const rootHash = git(['rev-parse', 'HEAD']);
write('root.txt', 'Normal reviewed ä\n'); git(['add', '.']); git(['commit', '--quiet', '-m', 'Normal commit']); const normalHash = git(['rev-parse', 'HEAD']);
git(['switch', '--quiet', '-c', 'side']); write('side.txt', 'Side first 字\nSide second ä\n'); git(['add', '.']); git(['commit', '--quiet', '-m', 'Side changes']); const sideHash = git(['rev-parse', 'HEAD']);
git(['switch', '--quiet', 'main']); write('main.txt', 'Main content\n'); git(['add', '.']); git(['commit', '--quiet', '-m', 'Main changes']); const mainHash = git(['rev-parse', 'HEAD']);
git(['merge', '--quiet', '--no-ff', 'side', '-m', 'Merge both parents']); const mergeHash = git(['rev-parse', 'HEAD']); git(['commit', '--quiet', '--allow-empty', '-m', 'Empty comparison']); const emptyHash = git(['rev-parse', 'HEAD']);
const before = git(['status', '--porcelain']) + git(['ls-files', '--stage']) + git(['rev-parse', 'HEAD']);
const result = { ok: false, root, cases: [], comparisons: [], errors: [], mutations: 0, inputFrames: 0 };
let chrome, browser, context, page, session;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(method, route, data) { const r = await context.request.fetch(url + route, { method, data }); assert.ok(r.ok(), route + ': ' + r.status()); const text = await r.text(); return text ? JSON.parse(text.replace(/^\uFEFF/, '')) : null; }
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check'], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0])); break; } catch { await sleep(100); } }
  assert.ok(browser); context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } }); const eq = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]);
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', workingDirectory: root, launchRequestId: crypto.randomUUID() })).id;
  result.sessionId = session; fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
  page = await context.newPage(); page.setDefaultTimeout(25000); page.on('pageerror', error => result.errors.push(error.message));
  page.on('websocket', socket => socket.on('framesent', frame => { if (Buffer.isBuffer(frame.payload) && frame.payload[0] === 0x14) result.inputFrames++; }));
  page.on('request', r => { if (new URL(r.url()).pathname.startsWith('/api/git') && r.method() !== 'GET') result.mutations++; });
  await page.goto(url); await page.locator('.session-item[data-session-id="' + session + '"] .session-title').click(); await page.locator('.session-wrapper[data-session-id="' + session + '"] .git-indicator').click();
  const dock = page.locator('#git-dock'); await dock.locator('.git-dock-resize-grip').press('End');
  const filenames = () => dock.locator('.git-commit-patch-list .git-inspector-file-title').allTextContents();
  async function copiedComparison() {
    await dock.locator('.git-command-row').filter({ has: page.locator('.git-command-label').filter({ hasText: 'Diff commit' }) }).locator('[data-action="copy-command"]').click();
    const command = await page.evaluate(() => navigator.clipboard.readText());
    return execFileSync('pwsh', ['-NoProfile','-NonInteractive','-Command', command], { windowsHide: true, stdio: 'pipe' }).toString('utf8');
  }
  async function inspect(hash) {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/git/commit' && new URL(r.url()).searchParams.get('hash') === hash);
    await dock.locator('[data-action="open-commit"][data-hash="' + hash + '"]').click(); const body = await (await response).json();
    await dock.locator('.git-commit-comparison').waitFor(); result.comparisons.push({ hash: body.hash, parent: body.comparedParentHash, index: body.comparedParentIndex, root: body.isRootCommit, additions: body.totalAdditions, deletions: body.totalDeletions, files: body.files.map(file => file.path) }); return body;
  }
  const initial = await inspect(rootHash); assert.equal(initial.isRootCommit, true); assert.equal(initial.comparedParentHash, null); assert.equal(initial.totalAdditions, 3); assert.ok((await filenames()).includes('folder/nested.txt'));
  assert.ok((await dock.locator('.git-commit-comparison').textContent()).includes('Empty tree')); await page.screenshot({ path: path.join(out, 'root-commit.png'), animations: 'disabled' }); result.cases.push('Root commit visibly compares recursive file additions against the empty tree');
  assert.ok((await copiedComparison()).includes('folder/nested.txt'));
  const normal = await inspect(normalHash); assert.equal(normal.comparedParentHash, rootHash); assert.equal(normal.totalAdditions, 1); assert.equal(normal.totalDeletions, 1); assert.deepEqual(await filenames(), ['root.txt']); result.cases.push('Normal commit displays the actual single-parent file patch and statistics');
  const merge = await inspect(mergeHash); assert.deepEqual(merge.parentHashes, [mainHash, sideHash]); assert.equal(merge.comparedParentIndex, 0); assert.deepEqual(await filenames(), ['side.txt']);
  const parent = dock.locator('.git-commit-parent'); await parent.focus(); const secondResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/git/commit' && new URL(r.url()).searchParams.get('parentIndex') === '1');
  await page.keyboard.press('ArrowDown'); const second = await (await secondResponse).json(); assert.equal(second.comparedParentHash, sideHash); await dock.locator('.git-inspector-file-title').filter({ hasText: 'main.txt' }).waitFor();
  assert.equal(await parent.inputValue(), '1'); assert.equal(await parent.evaluate(el => document.activeElement === el), true); assert.deepEqual(await filenames(), ['main.txt']); await page.screenshot({ path: path.join(out, 'merge-second-parent.png'), animations: 'disabled' }); result.cases.push('Merge defaults to first parent; a real keyboard parent switch changes files/statistics and restores select focus');
  const copied = await copiedComparison(); assert.ok(copied.includes('main.txt')); assert.ok(!copied.includes('side.txt')); result.cases.push('Copied comparison commands execute the displayed empty-tree or selected-parent comparison in real PowerShell');
  const empty = await inspect(emptyHash); assert.equal(empty.comparedParentHash, mergeHash); assert.deepEqual(empty.files, []); await dock.locator('.git-patch-empty').filter({ hasText: 'No changes compared' }).waitFor(); result.cases.push('A genuinely empty comparison is explicitly identified');
  const invalid = await context.request.get(url + '/api/git/commit?sessionId=' + session + '&repoRoot=' + encodeURIComponent(root) + '&hash=' + normalHash + '&parentIndex=1'); assert.equal(invalid.status(), 400);
  const marker = path.join(root, 'must-not-be-created.txt'); const malicious = await context.request.get(url + '/api/git/commit?sessionId=' + session + '&repoRoot=' + encodeURIComponent(root) + '&hash=' + encodeURIComponent('--output=' + marker)); assert.equal(malicious.status(), 404); assert.equal(fs.existsSync(marker), false); result.cases.push('Out-of-range parents and option-shaped references are rejected without writes');
  await inspect(mergeHash);
  let release, notifyHeld, notifyFulfilled; const held = new Promise(resolve => { notifyHeld = resolve; }); const gate = new Promise(resolve => { release = resolve; }); const fulfilled = new Promise(resolve => { notifyFulfilled = resolve; });
  await page.route('**/api/git/commit?**', async route => { const query = new URL(route.request().url()).searchParams; if (query.get('hash') === mergeHash && query.get('parentIndex') === '1') { const response = await route.fetch(); notifyHeld(); await gate; await route.fulfill({ response }); notifyFulfilled(); } else await route.continue(); });
  await parent.selectOption('1'); await held; await inspect(rootHash); await inspect(mergeHash);
  const delayed = page.waitForResponse(response => new URL(response.url()).searchParams.get('hash') === mergeHash && new URL(response.url()).searchParams.get('parentIndex') === '1');
  release(); await fulfilled; await (await delayed).finished(); await page.unroute('**/api/git/commit?**');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => document.querySelector('#git-dock .git-commit-parent')?.value === '0'); assert.deepEqual(await filenames(), ['side.txt']); result.cases.push('A delayed second-parent response cannot overwrite a newer first-parent selection of the same merge commit');
  assert.equal(git(['status', '--porcelain']) + git(['ls-files', '--stage']) + git(['rev-parse', 'HEAD']), before);
  assert.equal(result.inputFrames, 0); assert.equal(result.mutations, 0); assert.deepEqual(result.errors, []); result.ok = true;
} catch (error) { result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>'); await page?.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled' }).catch(() => {}); process.exitCode = 1; }
finally {
  if (context && session) await api('DELETE', '/api/sessions/' + session).catch(error => { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; });
  await context?.close(); await browser?.close(); chrome?.kill(); fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ok: result.ok, cases: result.cases, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
