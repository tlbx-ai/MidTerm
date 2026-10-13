import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('../../docs/marketing/ScreenshotAutomation/node_modules/playwright');
const url = process.env.TLBX_PERF_URL, cookie = process.env.TLBX_COOKIE_HEADER;
if (!url || !cookie) throw new Error('Source URL and authenticated cookie required');
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/files-navigation');
fs.mkdirSync(out, { recursive: true });
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-files-navigation-'));
const a = path.join(fixtures, 'A'), b = path.join(fixtures, 'B'), nested = path.join(a, 'nested');
fs.mkdirSync(nested, { recursive: true }); fs.mkdirSync(b);
fs.writeFileSync(path.join(a, 'A.md'), '# A\n'); fs.writeFileSync(path.join(b, 'B.md'), '# B\n');
for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(fixtures, `root-${String(i).padStart(3, '0')}.txt`), 'root file');
const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-files-root-')); execFileSync('git', ['init', '--quiet', extra]);
fs.writeFileSync(path.join(extra, 'extra.md'), '# Extra authorized root\n');
const result = { ok: false, fixtures, extra, cases: [], errors: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, browser, context, session, page;
async function api(method, route, data) {
  const response = await context.request.fetch(url + route, { method, data });
  assert.ok(response.ok(), `${route}: ${response.status()} ${await response.text()}`);
  const raw = await response.text(); return raw ? JSON.parse(raw) : null;
}
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check',
  ], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) {
    try { const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break;
    } catch { await sleep(100); }
  }
  if (!browser) throw new Error('Chrome did not start');
  context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const eq = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]);
  let ready = false;
  for (let i = 0; i < 40; i++) { try { ready = (await context.request.get(url + '/api/version', { timeout: 2000 })).ok(); } catch {}
    if (ready) break; await sleep(1000); }
  if (!ready) throw new Error('Source did not become ready');
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 90, rows: 30, workingDirectory: fixtures, launchRequestId: crypto.randomUUID() })).id;
  page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => result.errors.push(error.message));
  await page.goto(url); await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();
  const wrapper = page.locator(`.session-wrapper[data-session-id="${session}"]`);
  const files = wrapper.locator('.session-tab[data-tab="files"]'), terminal = wrapper.locator('.session-tab[data-tab="terminal"]');
  await files.click();
  const viewOptions = wrapper.locator('.file-listing-options');
  await viewOptions.locator('summary').click();
  await viewOptions.locator('[data-mode="tree"]').click();
  await page.keyboard.press('Escape');
  const nav = wrapper.locator('.file-browser-navigation'), address = nav.locator('.file-browser-address-form input');
  const tree = wrapper.locator('.file-browser-tree'), preview = wrapper.locator('.file-browser-preview');
  const dialog = page.locator('.file-unsaved-overlay'), editor = preview.locator('textarea');
  const waitPath = async target => page.waitForFunction(({ id, target }) => {
    const nav = document.querySelector(`.session-wrapper[data-session-id="${id}"] .file-browser-navigation`);
    return nav?.getAttribute('aria-busy') === 'false' && nav.querySelector('input').value === target;
  }, { id: session, target });
  const go = async target => {
    if (!(await address.isVisible())) await nav.locator('.file-browser-edit-address').click();
    await address.fill(target); await address.press('Enter');
  };
  const choose = async name => tree.locator('.tree-node').filter({ has: page.locator('.tree-name', { hasText: new RegExp('^' + name.replace('.', '\\.') + '$') }) }).click();
  await waitPath(fixtures); await tree.locator('.tree-node').first().waitFor();
  await choose('root-050.txt');
  const rootScroll = await tree.evaluate(e => e.scrollTop);
  await go(a); await waitPath(a);
  await nav.locator('[data-browser-navigation="back"]').click(); await waitPath(fixtures);
  assert.equal(await tree.locator('.selected .tree-name').innerText(), 'root-050.txt');
  assert.equal(await tree.evaluate(e => e.scrollTop), rootScroll);
  result.cases.push('Folder Back restores the previous tree selection and exact scroll position');
  await go(a); await waitPath(a); assert.equal(await nav.locator('[data-browser-navigation="up"]').isEnabled(), true);
  assert.equal(await nav.locator('[aria-current="location"]').innerText(), 'A');
  result.cases.push('Pasting an authorized folder changes the tree and shows server-provided breadcrumbs and Up');
  await choose('A.md'); await preview.locator('.file-document-mode[data-mode="edit"]').click(); await editor.fill('# Address navigation draft\n');
  await go(b); await dialog.waitFor(); await dialog.locator('[data-file-decision="cancel"]').click(); await waitPath(a);
  assert.equal(await editor.inputValue(), '# Address navigation draft\n'); assert.equal(await tree.locator('.selected .tree-name').innerText(), 'A.md');
  result.cases.push('Cancel on folder navigation retains address, selection and unsaved editor');
  await page.route('**/api/files/save**', route => route.fulfill({ status: 403, body: 'Injected save failure' }));
  await go(b); await dialog.locator('[data-file-decision="save"]').click(); await dialog.locator('.file-unsaved-error:not([hidden])').waitFor();
  assert.equal(await editor.inputValue(), '# Address navigation draft\n');
  await dialog.locator('[data-file-decision="cancel"]').click(); await page.unroute('**/api/files/save**');
  await go(b); await dialog.locator('[data-file-decision="save"]').click(); await waitPath(b);
  assert.equal(fs.readFileSync(path.join(a, 'A.md'), 'utf8'), '# Address navigation draft\n');
  await nav.locator('[data-browser-navigation="back"]').click(); await waitPath(a);
  await tree.locator('.selected .tree-name').waitFor(); assert.equal(await tree.locator('.selected .tree-name').innerText(), 'A.md');
  await preview.locator('.file-document-mode[data-mode="edit"]').click(); await editor.waitFor(); assert.equal(await editor.inputValue(), '# Address navigation draft\n');
  result.cases.push('Failed save blocks navigation; confirmed save writes disk and Back restores the selected file preview');
  await nav.locator('[data-browser-navigation="forward"]').click(); await waitPath(b);
  await go(path.join(b, 'B.md')); await preview.locator('.file-document-view').waitFor();
  await page.waitForFunction(() => document.querySelector('.file-browser-preview .preview-toolbar-name')?.textContent === 'B.md');
  assert.equal(await tree.locator('.selected .tree-name').innerText(), 'B.md'); assert.equal(await address.inputValue(), b);
  result.cases.push('An absolute file address opens its actual document and selects it in the containing folder');
  await go(nested); await waitPath(nested);
  await nav.locator('[data-breadcrumb-path]').filter({ hasText: /^A$/ }).click(); await waitPath(a);
  await tree.locator('.tree-node').filter({ has: page.locator('.tree-name', { hasText: /^nested$/ }) }).dblclick();
  await waitPath(nested);
  await nav.locator('[data-browser-navigation="up"]').click(); await waitPath(a);
  result.cases.push('Double-clicking a directory opens it as the browsing location with a working hierarchy return');
  await nav.locator('[data-browser-navigation="up"]').click(); await waitPath(fixtures);
  result.cases.push('Breadcrumb and Up navigation use hierarchy independently from Back/Forward');
  await go(path.join(fixtures, 'missing')); await nav.locator('.file-browser-navigation-error:not([hidden])').waitFor();
  assert.ok(await tree.locator('.tree-name', { hasText: /^A$/ }).isVisible());
  await go(path.dirname(fixtures)); await nav.locator('.file-browser-navigation-error:not([hidden])').waitFor();
  assert.ok(await tree.locator('.tree-name', { hasText: /^B$/ }).isVisible());
  result.cases.push('Missing and unauthorized addresses show errors without replacing the usable tree');
  await go(fixtures); await waitPath(fixtures);
  let sawOld; const pendingOld = new Promise(resolve => { sawOld = resolve; });
  let releaseOld; const heldOld = new Promise(resolve => { releaseOld = resolve; });
  await page.route('**/api/files/tree**', async route => {
    if (new URL(route.request().url()).searchParams.get('path') === a) {
      const response = await route.fetch(); sawOld(); await heldOld; await route.fulfill({ response }).catch(() => {});
    } else await route.continue();
  });
  await go(a); await pendingOld; await go(b); await waitPath(b); releaseOld(); await sleep(150);
  assert.equal(await address.inputValue(), b); assert.equal(await tree.locator('.tree-name', { hasText: 'A.md' }).count(), 0);
  await page.unroute('**/api/files/tree**');
  result.cases.push('An old directory response cannot overwrite a newer address or tree');
  await choose('B.md'); await preview.locator('.file-document-mode[data-mode="edit"]').click(); await editor.fill('# Retained while CWD changes\n');
  await terminal.click(); await wrapper.locator('.xterm-screen').click();
  await page.keyboard.type(`Set-Location -LiteralPath '${a.replaceAll("'", "''")}'`); await page.keyboard.press('Enter');
  await files.click();
  await page.waitForFunction(({ id, target }) => document.querySelector(`.session-wrapper[data-session-id="${id}"] [data-browser-navigation="cwd"]`)?.title.endsWith(target), { id: session, target: a });
  assert.equal(await address.inputValue(), b); assert.equal(await editor.inputValue(), '# Retained while CWD changes\n');
  await nav.locator('[data-browser-navigation="cwd"]').click(); await dialog.waitFor(); await dialog.locator('[data-file-decision="cancel"]').click();
  assert.equal(await address.inputValue(), b); assert.equal(await editor.inputValue(), '# Retained while CWD changes\n');
  await nav.locator('[data-browser-navigation="cwd"]').click(); await dialog.locator('[data-file-decision="save"]').click(); await waitPath(a);
  assert.equal(fs.readFileSync(path.join(b, 'B.md'), 'utf8'), '# Retained while CWD changes\n');
  result.cases.push('A real terminal CWD change retains the current file view until explicit guarded navigation to CWD');
  await api('POST', '/api/git/repos', { sessionId: session, path: extra, role: 'target', label: 'Extra root' });
  const reposBeforeBrowse = await api('GET', '/api/git/repos?sessionId=' + session);
  await terminal.click(); await files.click();
  await page.waitForFunction(({ id, target }) => [...document.querySelectorAll(`.session-wrapper[data-session-id="${id}"] .file-browser-navigation select option`)].some(option => option.value === target), { id: session, target: extra });
  await nav.locator('select').selectOption(extra); await waitPath(extra); await choose('extra.md'); await preview.locator('.file-document-mode[data-mode="edit"]').click(); await editor.waitFor();
  assert.equal(await editor.inputValue(), '# Extra authorized root\n');
  const reposAfterBrowse = await api('GET', '/api/git/repos?sessionId=' + session);
  assert.deepEqual(reposAfterBrowse.repos.map(repo => ({ path: repo.repoRoot, role: repo.role, primary: repo.isPrimary })),
    reposBeforeBrowse.repos.map(repo => ({ path: repo.repoRoot, role: repo.role, primary: repo.isPrimary })));
  result.cases.push('An explicitly bound repository appears as an authorized selectable root and opens actual files');
  await page.screenshot({ path: path.join(out, 'roots-and-address.png') });
  assert.deepEqual(result.errors, []); result.ok = true;
} catch (error) {
  result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>');
  if (page) { await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    result.pageText = (await page.locator('body').innerText().catch(() => '')).slice(-2500); }
  process.exitCode = 1;
} finally {
  if (context && session) { try { await api('DELETE', '/api/sessions/' + session); }
    catch (error) { result.cleanupFailure = String(error).replaceAll(cookie, '<redacted-session-cookie>'); result.ok = false; process.exitCode = 1; } }
  await context?.close(); await browser?.close(); chrome?.kill();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, cases: result.cases, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
