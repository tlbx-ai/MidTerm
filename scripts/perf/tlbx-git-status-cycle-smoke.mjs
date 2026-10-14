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
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/git-status-cycle');
fs.mkdirSync(out, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-git-status-cycle-'));
const git = args => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' }).toString('utf8');
fs.writeFileSync(path.join(root, '.gitignore'), '.tlbx/\n');
git(['init', '--quiet']); git(['config', 'user.name', 'Status acceptance']); git(['config', 'user.email', 'status@tlbx.invalid']); git(['config', 'core.autocrlf', 'false']); git(['add', '.']); git(['-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Baseline']);
const name = 'new ä.txt', target = path.join(root, name);
fs.writeFileSync(target, 'First reviewed 字\n');
const result = { ok: false, cases: [], statuses: [], errors: [], inputFrames: 0 };
let chrome, browser, context, page, session;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(method, route, data) {
  const response = await context.request.fetch(url + route, { method, data });
  assert.ok(response.ok(), route + ': ' + response.status());
  const body = await response.text(); return body ? JSON.parse(body.replace(/^\uFEFF/, '')) : null;
}
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check'], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0])); break; } catch { await sleep(100); }
  }
  assert.ok(browser); context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const eq = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]);
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', workingDirectory: root, launchRequestId: crypto.randomUUID() })).id;
  page = await context.newPage(); page.setDefaultTimeout(25000);
  page.on('pageerror', error => result.errors.push(error.message));
  page.on('websocket', socket => socket.on('framesent', frame => { if (Buffer.isBuffer(frame.payload) && frame.payload[0] === 0x14) result.inputFrames++; }));
  await page.goto(url); await page.locator('.session-item[data-session-id="' + session + '"] .session-title').click();
  await page.locator('.session-wrapper[data-session-id="' + session + '"] .git-indicator').click();
  const dock = page.locator('#git-dock'); await dock.locator('.git-dock-resize-grip').press('End');
  const row = scope => dock.locator('.git-tree-file[data-path="' + name + '"][data-scope="' + scope + '"]');
  async function expectStatus(scope, letter, label) {
    const section = dock.locator('.git-section[data-section="' + (scope === 'staged' ? 'staged' : letter === 'U' ? 'untracked' : 'changes') + '"]');
    await section.waitFor();
    if (!(await section.getAttribute('class')).includes('git-section-expanded')) await section.locator('.git-section-header').click();
    await row(scope).waitFor(); const badge = row(scope).locator('.git-file-indicator');
    await badge.filter({ hasText: letter }).waitFor();
    assert.equal(await badge.textContent(), letter);
    assert.ok((await badge.getAttribute('aria-label')).toLowerCase().includes(label));
    assert.equal(await row(scope).getAttribute('aria-describedby'), await badge.getAttribute('id'));
    result.statuses.push({ scope, letter, label: await badge.getAttribute('aria-label') });
  }
  async function review(scope) {
    await row(scope).click();
    await dock.locator('.git-inspector-summary [data-git-scope="' + scope + '"]').waitFor();
    await dock.locator('.git-diff-lines').waitFor();
    return await dock.locator('.git-diff-lines').textContent();
  }
  async function action(kind) {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/git/operations' && r.request().method() === 'POST');
    await dock.locator('[data-action="' + kind + '"][data-path="' + name + '"]').click();
    assert.equal((await (await response).json()).state, 'completed');
  }
  await expectStatus('worktree', 'U', 'untracked'); assert.ok((await review('worktree')).includes('+First reviewed 字'));
  result.cases.push('New file is U in the worktree with an accessible untracked description and actual addition preview');
  await action('stage-file'); await expectStatus('staged', 'A', 'added');
  assert.ok((await review('staged')).includes('+First reviewed 字')); assert.equal(git(['show', ':' + name]), 'First reviewed 字\n');
  result.cases.push('Staging moves the file to A in the index and the preview matches the actual indexed bytes');
  fs.writeFileSync(target, 'First reviewed 字\nLater working change ä\n');
  await expectStatus('worktree', 'M', 'modified'); await expectStatus('staged', 'A', 'added');
  const working = await review('worktree'); assert.ok(working.includes('+Later working change ä'));
  const indexed = await review('staged'); assert.ok(indexed.includes('+First reviewed 字')); assert.ok(!indexed.includes('Later working change'));
  assert.equal((await row('staged').locator('.git-loc-add').textContent()).trim(), '+1');
  assert.equal((await row('worktree').locator('.git-loc-add').textContent()).trim(), '+1');
  assert.equal(git(['show', ':' + name]), 'First reviewed 字\n');
  await page.screenshot({ path: path.join(out, 'staged-and-working.png'), animations: 'disabled' });
  result.cases.push('Editing after stage preserves A in the index and shows a separate M worktree diff without contaminating the index');
  await action('stage-file'); await expectStatus('staged', 'A', 'added'); await row('worktree').waitFor({ state: 'hidden' });
  assert.equal(git(['show', ':' + name]), 'First reviewed 字\nLater working change ä\n');
  assert.ok((await review('staged')).includes('+Later working change ä'));
  result.cases.push('Restaging updates the indexed addition and removes the separate working modification');
  await action('unstage-file'); await expectStatus('worktree', 'U', 'untracked'); await row('staged').waitFor({ state: 'hidden' });
  assert.ok((await review('worktree')).includes('+Later working change ä'));
  assert.equal(git(['ls-files', '--', name]), ''); assert.equal(fs.readFileSync(target, 'utf8'), 'First reviewed 字\nLater working change ä\n');
  await page.screenshot({ path: path.join(out, 'unstaged-new.png'), animations: 'disabled' });
  result.cases.push('Unstaging restores U and previews the full new file while preserving all working bytes');
  assert.equal(result.inputFrames, 0); assert.deepEqual(result.errors, []); result.ok = true;
} catch (error) {
  result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>');
  await page?.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled' }).catch(() => {}); process.exitCode = 1;
} finally {
  if (context && session) await api('DELETE', '/api/sessions/' + session).catch(error => { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; });
  await context?.close(); await browser?.close(); chrome?.kill();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, cases: result.cases, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
