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
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/git-file-list'); fs.mkdirSync(out, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-git-file-list-'));
const git = args => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' }).toString('utf8');
const names = [...Array.from({ length: 240 }, (_, i) => 'bulk/file' + String(i).padStart(3, '0') + '.txt'), 'Alpha/deep/same.txt', 'Beta/deep/same.txt', '深目录/ä字.txt'];
for (const name of names) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), 'Baseline\n'); }
fs.writeFileSync(path.join(root, '.gitignore'), '.tlbx/\n');
git(['init', '--quiet']); git(['config', 'user.name', 'File list acceptance']); git(['config', 'user.email', 'list@tlbx.invalid']); git(['config', 'commit.gpgSign', 'false']); git(['config', 'core.autocrlf', 'false']); git(['add', '.']); git(['commit', '--quiet', '-m', 'Baseline']);
for (const name of names) fs.writeFileSync(path.join(root, name), 'Changed ' + name + '\n');
const result = { ok: false, root, cases: [], errors: [], inputFrames: 0 };
let chrome, browser, context, page, session;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(method, route, data) { const r = await context.request.fetch(url + route, { method, data }); assert.ok(r.ok(), route + ': ' + r.status()); const text = await r.text(); return text ? JSON.parse(text.replace(/^\uFEFF/, '')) : null; }
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check'], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0])); break; } catch { await sleep(100); } }
  assert.ok(browser); context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } }); const eq = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]);
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', workingDirectory: root, launchRequestId: crypto.randomUUID() })).id; result.sessionId = session; fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
  page = await context.newPage(); page.setDefaultTimeout(25000); page.on('pageerror', error => result.errors.push(error.message));
  page.on('websocket', socket => socket.on('framesent', frame => { if (Buffer.isBuffer(frame.payload) && frame.payload[0] === 0x14) result.inputFrames++; }));
  await page.goto(url); const indicator = page.locator('.session-wrapper[data-session-id="' + session + '"] .git-indicator'); await page.locator('.session-item[data-session-id="' + session + '"] .session-title').click(); await indicator.click();
  const dock = page.locator('#git-dock'); await dock.locator('.git-dock-resize-grip').press('End');
  const filter = dock.locator('.git-file-filter'), layout = dock.locator('[data-action="toggle-file-layout"]'), changes = dock.locator('.git-section[data-section="changes"]');
  await changes.locator('.git-tree-file').last().waitFor(); assert.equal(await changes.locator('.git-tree-file').count(), names.length);
  const alpha = changes.locator('[data-action="toggle-git-folder"][data-folder="Alpha"]'); await alpha.focus(); await alpha.press('ArrowLeft'); assert.equal(await alpha.getAttribute('aria-expanded'), 'false'); assert.equal(await changes.locator('.git-tree-file[data-path="Alpha/deep/same.txt"]').count(), 0);
  await alpha.press('ArrowRight'); assert.equal(await alpha.getAttribute('aria-expanded'), 'true'); await alpha.press('ArrowRight'); assert.equal(await page.evaluate(() => document.activeElement?.dataset.folder), 'Alpha/deep');
  await page.keyboard.press('ArrowRight'); assert.equal(await page.evaluate(() => document.activeElement?.dataset.path), 'Alpha/deep/same.txt'); result.cases.push('Tree folders fold and unfold with ARIA hierarchy and Left/Right navigation into real descendants');
  await layout.click(); assert.equal(await changes.locator('[role="listbox"]').count(), 1); assert.equal(await changes.locator('.git-tree-dir').count(), 0); assert.equal(await changes.locator('.git-tree-name').filter({ hasText: 'Alpha/deep/same.txt' }).count(), 1);
  await filter.fill('same.txt'); assert.equal(await changes.locator('.git-tree-file').count(), 2); assert.equal(await filter.evaluate(el => document.activeElement === el), true);
  const first = changes.locator('.git-tree-file').first(), second = changes.locator('.git-tree-file').nth(1); await first.focus(); await page.keyboard.press('Space'); await second.click({ modifiers: ['Control'] }); assert.equal(await changes.locator('[aria-selected="true"]').count(), 2);
  await first.click(); assert.equal(await changes.locator('[aria-selected="true"]').count(), 1); await first.press('Shift+End'); assert.equal(await changes.locator('[aria-selected="true"]').count(), 2);
  const mutation = page.waitForResponse(r => new URL(r.url()).pathname === '/api/git/operations' && r.request().method() === 'POST'); await dock.locator('[data-action="stage-selected-files"]').click(); assert.equal((await (await mutation).json()).state, 'completed');
  assert.deepEqual(git(['diff', '--cached', '--name-only']).trim().split(/\r?\n/).sort(), ['Alpha/deep/same.txt','Beta/deep/same.txt']); result.cases.push('List view shows distinct full relative names; a focused filter and Ctrl/Space selection stage exactly the two displayed duplicate basenames');
  const stagedSection = dock.locator('.git-section[data-section="staged"]'); await stagedSection.locator('.git-tree-file').first().focus(); await page.keyboard.press('Control+a');
  const unstaged = page.waitForResponse(r => new URL(r.url()).pathname === '/api/git/operations' && r.request().method() === 'POST'); await dock.locator('[data-action="unstage-selected-files"]').click(); assert.equal((await (await unstaged).json()).state, 'completed'); assert.equal(git(['diff','--cached','--name-only']).trim(), '');
  const restaged = page.waitForResponse(r => new URL(r.url()).pathname === '/api/git/operations' && r.request().method() === 'POST'); await changes.locator('[data-action="stage-section"]').click(); assert.equal((await (await restaged).json()).state, 'completed');
  assert.deepEqual(git(['diff', '--cached', '--name-only']).trim().split(/\r?\n/).sort(), ['Alpha/deep/same.txt','Beta/deep/same.txt']); result.cases.push('Ctrl+A in the index group unstages exactly the selected files; filtered group restaging restores their index membership');
  await filter.fill('bulk/file00'); const count = await changes.locator('.git-tree-file').count(); assert.equal(count, 10);
  const staged = page.waitForResponse(r => new URL(r.url()).pathname === '/api/git/operations' && r.request().method() === 'POST'); await changes.locator('[data-action="stage-section"]').click(); assert.equal((await (await staged).json()).state, 'completed');
  assert.equal(git(['diff','--cached','--name-only']).trim().split(/\r?\n/).length, 12); assert.ok(!git(['diff','--cached','--name-only']).includes('file010.txt')); result.cases.push('Filtered group staging acts on only the matching ten paths, preserving all hidden changes');
  await filter.fill('bulk/file'); const row = changes.locator('.git-tree-file[data-path="bulk/file100.txt"]'); await row.focus(); await page.keyboard.press('Control+a'); assert.equal(await changes.locator('[aria-selected="true"]').count(), 230);
  await row.click(); assert.equal(await changes.locator('[aria-selected="true"]').count(), 1); const scroller = changes.locator('.git-section-body'); await scroller.evaluate(el => { el.scrollTop = 450; });
  await row.evaluate(el => { window.retainedGitFile = el; window.retainedGitFilter = document.querySelector('#git-dock .git-file-filter'); }); const scroll = await scroller.evaluate(el => el.scrollTop);
  fs.writeFileSync(path.join(root, 'bulk/file120.txt'), 'Changed first\nChanged second\n'); await changes.locator('.git-tree-file[data-path="bulk/file120.txt"] .git-loc-add').filter({ hasText: '+2' }).waitFor();
  assert.equal(await row.evaluate(el => el === window.retainedGitFile), true); assert.equal(await filter.evaluate(el => el === window.retainedGitFilter), true); assert.equal(await row.getAttribute('aria-selected'), 'true'); assert.equal(await scroller.evaluate(el => el.scrollTop), scroll); assert.equal(await row.evaluate(el => document.activeElement === el), true);
  result.cases.push('Real status pushes retain the exact file/filter DOM, selected files, focused row and scroll among hundreds of changes');
  await filter.fill('深目录'); assert.equal(await changes.locator('.git-tree-file').count(), 1); assert.equal(await dock.locator('[data-action="stage-selected-files"]').count(), 0); await filter.fill(''); await layout.click(); assert.equal(await changes.locator('[role="tree"]').count(), 1);
  await page.screenshot({ path: path.join(out, 'tree-list-controls.png'), animations: 'disabled' }); result.cases.push('Unicode path filtering clears hidden bulk selections and restores independent tree mode');
  await dock.locator('#git-dock-close').click(); await page.setViewportSize({ width: 390, height: 844 });
  const mobileOpener = page.locator('#btn-mobile-actions-menu'); await mobileOpener.focus(); await mobileOpener.click(); await page.locator('#btn-mobile-git').click();
  await page.waitForFunction(() => document.querySelector('#git-dock').contains(document.activeElement));
  assert.equal(await dock.getAttribute('role'), 'dialog'); assert.equal(await dock.getAttribute('aria-modal'), 'true');
  await dock.evaluate(el => { const nodes = [...el.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]')].filter(node => node.tabIndex >= 0 && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden'); window.gitFocusFirst = nodes[0]; window.gitFocusLast = nodes[nodes.length - 1]; nodes[0].focus(); });
  await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => document.activeElement === window.gitFocusLast), true); await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement === window.gitFocusFirst), true);
  for (let index = 0; index < 8; index++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.querySelector('#git-dock').contains(document.activeElement)), true); }
  await page.screenshot({ path: path.join(out, 'mobile-focus.png'), animations: 'disabled' }); await page.keyboard.press('Escape'); await dock.waitFor({ state: 'hidden' });
  assert.equal(await mobileOpener.evaluate(el => document.activeElement === el), true); result.cases.push('390px Git overlay owns initial/Tab/Shift-Tab focus, closes on Escape and returns focus to its visible mobile opener without terminal input');
  assert.equal(result.inputFrames, 0); assert.deepEqual(result.errors, []); result.ok = true;
} catch (error) { result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>'); await page?.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled' }).catch(() => {}); process.exitCode = 1; }
finally {
  if (context && session) await api('DELETE', '/api/sessions/' + session).catch(error => { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; });
  await context?.close(); await browser?.close(); chrome?.kill(); fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ok: result.ok, cases: result.cases, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
