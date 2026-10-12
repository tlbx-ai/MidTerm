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
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/git-partial-staging'); fs.mkdirSync(out, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-git-partial-'));
const git = args => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' }).toString('utf8');
const baseline = Array.from({ length: 40 }, (_, i) => 'Baseline line ' + (i + 1));
const file = path.join(root, 'a.txt'); fs.writeFileSync(file, baseline.join('\r\n') + '\r\n'); fs.writeFileSync(path.join(root, '.gitignore'), '.tlbx/\n');
git(['init', '--quiet']); git(['config', 'user.name', 'Partial staging acceptance']); git(['config', 'user.email', 'partial@tlbx.invalid']); git(['config', 'commit.gpgSign', 'false']); git(['config', 'core.autocrlf', 'false']); git(['add', '.']); git(['commit', '--quiet', '-m', 'Baseline']);
const working = [...baseline]; working[4] = 'First reviewed ä字😀'; working[29] = 'Second reviewed change ö';
const workingText = working.join('\r\n') + '\r\n'; fs.writeFileSync(file, workingText);
fs.writeFileSync(path.join(root, 'new ä.txt'), 'First ä\nSecond 字\nThird 😀\n');
const result = { ok: false, cases: [], operations: [], errors: [], inputFrames: 0 };
let chrome, browser, context, page, session;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(method, route, data) { const r = await context.request.fetch(url + route, { method, data }); assert.ok(r.ok(), route + ': ' + r.status()); const text = await r.text(); return text ? JSON.parse(text.replace(/^\uFEFF/, '')) : null; }
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check'], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0])); break; } catch { await sleep(100); } }
  assert.ok(browser); context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } }); const eq = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]);
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', workingDirectory: root, launchRequestId: crypto.randomUUID() })).id;
  page = await context.newPage(); page.setDefaultTimeout(25000); page.on('pageerror', error => result.errors.push(error.message));
  page.on('websocket', socket => socket.on('framesent', frame => { if (Buffer.isBuffer(frame.payload) && frame.payload[0] === 0x14) result.inputFrames++; }));
  await page.goto(url); await page.locator('.session-item[data-session-id="' + session + '"] .session-title').click(); await page.locator('.session-wrapper[data-session-id="' + session + '"] .git-indicator').click();
  const dock = page.locator('#git-dock'); await dock.locator('.git-dock-resize-grip').press('End');
  async function review(name, scope) {
    const section = dock.locator('.git-section[data-section="' + (scope === 'staged' ? 'staged' : name.startsWith('new') ? 'untracked' : 'changes') + '"]');
    await section.waitFor(); if (!(await section.getAttribute('class')).includes('git-section-expanded')) await section.locator('.git-section-header').click();
    await dock.locator('.git-tree-file[data-path="' + name + '"][data-scope="' + scope + '"]').click();
    await dock.locator('.git-inspector-summary .git-summary-pill').filter({ hasText: scope }).waitFor(); await dock.locator('.git-diff-lines').first().waitFor();
  }
  async function apply(locator, expected = 'completed') {
    const pending = page.waitForResponse(r => new URL(r.url()).pathname === '/api/git/operations' && r.request().method() === 'POST');
    await locator.click(); const response = await pending; const body = await response.json(); result.operations.push({ request: response.request().postDataJSON(), result: { state: body.state, errorCode: body.errorCode, status: response.status() } });
    assert.equal(body.state, expected); return body;
  }
  await review('a.txt', 'worktree'); assert.equal(await dock.locator('.git-diff-hunk-block').count(), 2); assert.ok(await dock.locator('.git-diff-word-change').count() > 0);
  await dock.locator('[data-action="toggle-diff-side"]').click(); await dock.locator('.git-diff-table-side').first().waitFor();
  assert.equal(await dock.locator('.git-panel-list').isVisible(), false); assert.equal(await dock.locator('.git-inspector-back').isVisible(), true);
  const pairs = await dock.locator('.git-diff-pair').evaluateAll(rows => rows.filter(row => row.querySelector('.git-diff-line-del') && row.querySelector('.git-diff-line-add')).map(row => {
    const old = row.querySelector('.git-diff-line-del'), current = row.querySelector('.git-diff-line-add');
    const a = old.getBoundingClientRect(), b = current.getBoundingClientRect(); return { old: old.textContent, current: current.textContent, oldNumber: old.querySelector('.git-diff-number').textContent, newNumber: current.querySelector('.git-diff-number').textContent, a: { x: a.x, y: a.y, height: a.height, width: a.width }, b: { x: b.x, y: b.y, height: b.height, width: b.width } };
  })); assert.equal(pairs.length, 2);
  for (const pair of pairs) { assert.equal(pair.a.y, pair.b.y); assert.ok(Math.abs(pair.a.height - pair.b.height) < 1); assert.ok(pair.b.x > pair.a.x); assert.equal(pair.oldNumber, pair.newNumber); }
  result.sidePairs = pairs; await page.screenshot({ path: path.join(out, 'side-by-side.png'), animations: 'disabled' }); result.cases.push('Actual side-by-side changes pair old/new coordinates, align replacement rows and visibly preserve Unicode word marks');
  await dock.locator('[data-action="toggle-diff-side"]').click(); await dock.locator('.git-diff-table-side').waitFor({ state: 'hidden' });
  assert.equal(await dock.locator('.git-panel-list').isVisible(), true);
  await dock.locator('[data-action="previous-diff-hunk"]').click(); assert.equal(await page.evaluate(() => [...document.querySelectorAll('#git-dock .git-diff-lines')].indexOf(document.activeElement)), 1);
  await dock.locator('[data-action="next-diff-hunk"]').click(); assert.equal(await page.evaluate(() => [...document.querySelectorAll('#git-dock .git-diff-lines')].indexOf(document.activeElement)), 0);
  await dock.locator('[data-action="next-diff-hunk"]').click(); assert.equal(await page.evaluate(() => [...document.querySelectorAll('#git-dock .git-diff-lines')].indexOf(document.activeElement)), 1);
  result.cases.push('Previous/next change navigation focuses the actual hunk and wraps correctly from the initial state');
  const changedLines = dock.locator('[data-diff-line]'); await changedLines.evaluateAll(nodes => { window.partialLineNodes = nodes; });
  await changedLines.first().focus(); await page.keyboard.press('Space'); await page.keyboard.press('Shift+ArrowDown'); assert.equal(await dock.locator('[data-diff-line][aria-selected="true"]').count(), 2);
  assert.equal(await changedLines.evaluateAll(nodes => nodes.every((node, index) => node === window.partialLineNodes[index])), true);
  await apply(dock.locator('[data-action="apply-diff-selection"]')); const firstOnly = [...baseline]; firstOnly[4] = working[4];
  assert.equal(git(['show', ':a.txt']), firstOnly.join('\r\n') + '\r\n'); assert.equal(fs.readFileSync(file, 'utf8'), workingText);
  await dock.locator('.git-diff-lines').filter({ hasText: 'Second reviewed change' }).waitFor(); assert.equal(await dock.locator('[data-diff-line][aria-selected="true"]').count(), 0);
  await page.screenshot({ path: path.join(out, 'after-selected-stage.png'), animations: 'disabled' }); result.cases.push('Keyboard range selection preserves DOM and stages exactly the first CRLF/Unicode replacement, leaving the second change and disk bytes intact');
  await apply(dock.locator('[data-action="apply-diff-hunk"]').first()); assert.equal(git(['show', ':a.txt']), workingText);
  await review('a.txt', 'staged'); await apply(dock.locator('[data-action="apply-diff-hunk"]').first()); const secondOnly = [...baseline]; secondOnly[29] = working[29];
  assert.equal(git(['show', ':a.txt']), secondOnly.join('\r\n') + '\r\n'); assert.equal(fs.readFileSync(file, 'utf8'), workingText); result.cases.push('Whole-hunk stage and selective hunk unstage update only the reviewed index content and preserve later working changes');
  await review('new ä.txt', 'worktree'); await dock.locator('[data-diff-line]').first().focus(); await page.keyboard.press('Space'); await dock.locator('[data-diff-line]').nth(2).click({ modifiers: ['Control'] });
  assert.equal(await dock.locator('[data-diff-line][aria-selected="true"]').count(), 2); await apply(dock.locator('[data-action="apply-diff-selection"]')); assert.equal(git(['show', ':new ä.txt']), 'First ä\nThird 😀\n');
  await review('new ä.txt', 'staged'); await dock.locator('[data-diff-line]').first().focus(); await page.keyboard.press('Space'); await apply(dock.locator('[data-action="apply-diff-selection"]'));
  assert.equal(git(['show', ':new ä.txt']), 'Third 😀\n'); assert.equal(fs.readFileSync(path.join(root, 'new ä.txt'), 'utf8'), 'First ä\nSecond 字\nThird 😀\n'); result.cases.push('Ctrl-click and keyboard selection stage nonadjacent new-file lines and unstage one indexed addition without changing the working copy');
  await review('a.txt', 'worktree'); const indexBefore = git(['ls-files', '--stage']); const unreviewed = [...working]; unreviewed[4] = 'Changed after review ä字😀'; fs.writeFileSync(file, unreviewed.join('\r\n') + '\r\n');
  const stale = await apply(dock.locator('[data-action="apply-diff-hunk"]').first(), 'error'); assert.equal(stale.errorCode, 'diff_changed'); assert.equal(git(['ls-files', '--stage']), indexBefore);
  await dock.locator('.git-operation-status').filter({ hasText: 'reviewed diff changed' }).waitFor(); result.cases.push('A real working-copy edit after review is rejected visibly before publishing any stale selected patch');
  assert.equal(result.inputFrames, 0); assert.deepEqual(result.errors, []); result.ok = true;
} catch (error) { result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>'); await page?.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled' }).catch(() => {}); process.exitCode = 1; }
finally {
  if (context && session) await api('DELETE', '/api/sessions/' + session).catch(error => { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; });
  await context?.close(); await browser?.close(); chrome?.kill(); fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ok: result.ok, cases: result.cases, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
