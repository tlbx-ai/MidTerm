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
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/git-new-files'); fs.mkdirSync(out, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-git-new-files-'));
const git = args => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
fs.writeFileSync(path.join(root, '.gitignore'), '.tlbx/\n'); git(['init', '--quiet']); git(['config', 'user.name', 'New files acceptance']); git(['config', 'user.email', 'new@tlbx.invalid']); git(['config', 'commit.gpgSign', 'false']); git(['config', 'core.autocrlf', 'false']); git(['add', '.']); git(['commit', '--quiet', '-m', 'Baseline']);
fs.mkdirSync(path.join(root, 'folder'));
const fixtures = {
  'new ä.md': Buffer.from('# New ä document\nActual reviewed text 字\n'),
  'empty.txt': Buffer.alloc(0),
  'new.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5VIAAAAASUVORK5CYII=', 'base64'),
  'large.txt': Buffer.from(Array.from({ length: 5000 }, (_, i) => 'Large line ' + i + ' ' + 'x'.repeat(400) + '\n').join('')),
  'folder/inside.txt': Buffer.from('Nested reviewed content\n')
};
for (const [name, bytes] of Object.entries(fixtures)) fs.writeFileSync(path.join(root, name), bytes);
const result = { ok: false, root, cases: [], responses: [], errors: [], inputFrames: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); let chrome, browser, context, page, session;
async function api(method, route, data) { const r = await context.request.fetch(url + route, { method, data }); assert.ok(r.ok(), route + ': ' + r.status()); const text = await r.text(); return text ? JSON.parse(text.replace(/^\uFEFF/, '')) : null; }
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check'], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) { try { const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break; } catch { await sleep(100); } }
  assert.ok(browser); context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } }); const eq = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]);
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', workingDirectory: root, launchRequestId: crypto.randomUUID() })).id;
  page = await context.newPage(); page.setDefaultTimeout(25000); page.on('pageerror', error => result.errors.push(error.message)); page.on('websocket', socket => socket.on('framesent', frame => { if (Buffer.isBuffer(frame.payload) && frame.payload[0] === 0x14) result.inputFrames++; }));
  await page.goto(url); await page.locator('.session-item[data-session-id="' + session + '"] .session-title').click(); await page.locator('.session-wrapper[data-session-id="' + session + '"] .git-indicator').click();
  const dock = page.locator('#git-dock'); await dock.locator('.git-dock-resize-grip').press('End');
  const inspect = async name => {
    const escaped = await page.evaluate(value => CSS.escape(value), name);
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/git/diff-view' && new URL(r.url()).searchParams.get('path') === name);
    await dock.locator('.git-tree-file[data-path=' + escaped + ']').click(); const body = await (await response).json(); result.responses.push(body);
    await dock.locator('.git-new-file-metadata').waitFor(); return body.files[0];
  };
  const text = await inspect('new ä.md'); assert.equal(text.status, 'untracked'); assert.equal(text.additions, 2); assert.equal(text.deletions, 0);
  assert.ok((await dock.locator('.git-diff-lines').textContent()).includes('+Actual reviewed text 字')); assert.equal(text.sizeBytes, fixtures['new ä.md'].length);
  assert.ok(!(await dock.locator('.git-tree-file[data-path="new ä.md"]').innerText()).includes('+0')); await page.screenshot({ path: path.join(out, 'new-text.png'), animations: 'disabled' }); result.cases.push('New Unicode text is a real addition against an empty base with honest metadata and no fake zero row statistics');
  const empty = await inspect('empty.txt'); assert.equal(empty.sizeBytes, 0); assert.equal(empty.hunks.length, 0); await dock.locator('.git-patch-empty').filter({ hasText: 'New empty file' }).waitFor(); result.cases.push('A genuinely empty new file is explicitly identified');
  const binary = await inspect('new.png'); assert.equal(binary.isBinary, true); assert.equal(binary.sizeBytes, fixtures['new.png'].length); assert.equal(binary.mimeType, 'image/png'); assert.equal(await dock.locator('.git-inspector-patch > .git-inspector-file-header .git-file-loc').count(), 0);
  await dock.locator('[data-action="open-file-viewer"]').click(); const modal = page.locator('#file-viewer-modal'); await modal.waitFor({ state: 'visible' }); await page.waitForFunction(() => [...document.querySelectorAll('#file-viewer-modal img')].some(img => img.complete && img.naturalWidth > 0));
  await page.screenshot({ path: path.join(out, 'binary-viewer.png'), animations: 'disabled' }); await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' }); result.cases.push('A new real PNG has binary size/type metadata and opens a decoded image in the existing file viewer');
  const large = await inspect('large.txt'); assert.equal(large.isTruncated, true); assert.equal(large.hasLineStats, false); assert.ok(large.sizeBytes > 2_000_000); await dock.locator('.git-panel-hint').filter({ hasText: 'Limited preview' }).waitFor();
  assert.equal(await dock.locator('.git-inspector-patch > .git-inspector-file-header .git-file-loc').count(), 0); assert.ok(large.hunks.flatMap(hunk => hunk.lines).reduce((sum, line) => sum + line.text.length, 0) < 600000);
  await dock.locator('[data-action="open-file-viewer"]').click(); await modal.waitFor({ state: 'visible' }); await page.screenshot({ path: path.join(out, 'large-file-viewer.png'), animations: 'disabled' }); await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' }); result.cases.push('Large new text stays bounded and explicitly partial, with access to the file viewer and no invented complete line count');
  const nested = await inspect('folder/inside.txt'); assert.equal(nested.additions, 1); assert.ok((await dock.locator('.git-diff-lines').textContent()).includes('+Nested reviewed content')); result.cases.push('Files inside an untracked directory are individually listed and reviewable');
  const staged = page.waitForResponse(r => new URL(r.url()).pathname === '/api/git/operations' && r.request().method() === 'POST'); await dock.locator('[data-action="stage-all"]').click(); assert.equal((await (await staged).json()).state, 'completed');
  await dock.locator('.git-commit-message').fill('Reviewed new text, image, empty and large files'); const committed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/git/operations' && r.request().method() === 'POST'); await dock.locator('[data-action="commit-staged"]').click(); assert.equal((await (await committed).json()).state, 'completed');
  for (const [name, bytes] of Object.entries(fixtures)) { assert.deepEqual(git(['show', 'HEAD:' + name]), bytes); assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes); }
  assert.equal(result.inputFrames, 0); assert.deepEqual(result.errors, []); result.cases.push('Review to real stage/commit preserves every exact file byte in HEAD and the working tree without terminal input'); result.ok = true;
} catch (error) { result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>'); await page?.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled' }).catch(() => {}); process.exitCode = 1; }
finally {
  if (context && session) await api('DELETE', '/api/sessions/' + session).catch(error => { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; });
  await context?.close(); await browser?.close(); chrome?.kill(); fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ok: result.ok, cases: result.cases, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
