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
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/git-quoting-browser'); fs.mkdirSync(out, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-git-quote-browser-'));
const root = path.join(base, "repo ä $HOME " + String.fromCharCode(96) + " ‘smart’ it's"); fs.mkdirSync(root);
const files = ['space name.txt', 'Unicode ä字.txt', '$HOME.txt', 'literal' + String.fromCharCode(96) + 'tick.txt', "it's quoted.txt", 'smart‘quote’.txt', '--option.txt', 'glob[abc].txt', "attack'$(touch injected.marker)'.txt", 'attack‘$(Set-Content injected.marker owned)’.txt'];
const git = args => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' }).toString('utf8');
for (const [i, file] of files.entries()) fs.writeFileSync(path.join(root, file), 'Baseline ' + i + '\n');
fs.writeFileSync(path.join(root, '.gitignore'), '.tlbx/\n*.marker\n'); git(['init', '--quiet']); git(['config', 'user.name', 'Browser quoting']); git(['config', 'user.email', 'browser@tlbx.invalid']); git(['config', 'commit.gpgSign', 'false']); git(['add', '.']); git(['commit', '--quiet', '-m', 'Baseline']);
for (const [i, file] of files.entries()) fs.writeFileSync(path.join(root, file), 'Browser exact change ' + i + '\n');
const result = { ok: false, root, cases: [], commands: [], errors: [], inputFrames: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); let chrome, browser, context, page, session;
async function api(method, route, data) { const r = await context.request.fetch(url + route, { method, data }); assert.ok(r.ok(), route + ': ' + r.status()); const text = await r.text(); return text ? JSON.parse(text.replace(/^\uFEFF/, '')) : null; }
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check'], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) { try { const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break; } catch { await sleep(100); } }
  assert.ok(browser); context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } }); const eq = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]); await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', workingDirectory: root, launchRequestId: crypto.randomUUID() })).id;
  page = await context.newPage(); page.setDefaultTimeout(25000); page.on('pageerror', error => result.errors.push(error.message)); page.on('websocket', socket => socket.on('framesent', frame => { if (Buffer.isBuffer(frame.payload) && frame.payload[0] === 0x14) result.inputFrames++; }));
  await page.goto(url); await page.locator('.session-item[data-session-id="' + session + '"] .session-title').click();
  await page.locator('.session-wrapper[data-session-id="' + session + '"] .git-indicator').click(); const dock = page.locator('#git-dock'); await dock.locator('.git-dock-resize-grip').press('End');
  for (const [i, file] of files.entries()) {
    const escaped = await page.evaluate(value => CSS.escape(value), file);
    const row = dock.locator('.git-tree-file[data-path=' + escaped + '][data-scope="worktree"]');
    await row.click(); await dock.locator('.git-command-text').first().waitFor();
    await dock.locator('.git-diff-lines').waitFor(); assert.ok((await dock.locator('.git-diff-lines').textContent()).includes('+Browser exact change ' + i));
    const rowText = await row.innerText(); assert.ok(rowText.includes('+1') && rowText.includes('-1'));
    const copy = dock.locator('[data-action="copy-command"]').nth(1); await copy.click(); await dock.locator('.git-action-status').nth(1).filter({ hasText: 'Copied' }).waitFor();
    const command = await page.evaluate(() => navigator.clipboard.readText()); result.commands.push({ file, command });
    const diff = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: base, windowsHide: true, stdio: 'pipe' }).toString('utf8'); assert.ok(diff.includes('+Browser exact change ' + i));
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/git/operations' && r.request().method() === 'POST'); await dock.locator('[data-action="stage-file"][data-path=' + escaped + ']').click(); assert.equal((await (await response).json()).state, 'completed');
    assert.deepEqual(git(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean), [file]);
    const unstaged = page.waitForResponse(r => new URL(r.url()).pathname === '/api/git/operations' && r.request().method() === 'POST'); await dock.locator('[data-action="unstage-file"][data-path=' + escaped + ']').click(); assert.equal((await (await unstaged).json()).state, 'completed');
    assert.equal(git(['diff', '--cached', '--name-only']), ''); assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), 'Browser exact change ' + i + '\n');
    assert.ok(!fs.existsSync(path.join(root, 'injected.marker')) && !fs.existsSync(path.join(base, 'injected.marker')));
    result.cases.push({ file, actualClipboard: true, exactIndex: true, unchangedDisk: true });
  }
  assert.equal(result.inputFrames, 0); assert.deepEqual(result.errors, []); await page.screenshot({ path: path.join(out, 'literal-paths.png'), animations: 'disabled' }); result.ok = true;
} catch (error) { result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>'); await page?.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled' }).catch(() => {}); process.exitCode = 1; }
finally {
  if (context && session) await api('DELETE', '/api/sessions/' + session).catch(error => { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; });
  await context?.close(); await browser?.close(); chrome?.kill(); fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ok: result.ok, cases: result.cases.length, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
