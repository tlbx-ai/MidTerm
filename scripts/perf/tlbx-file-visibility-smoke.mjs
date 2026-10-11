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
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/file-visibility');
fs.mkdirSync(out, { recursive: true });
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-file-visibility-'));
const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-nongit-visibility-'));
for (const name of ['node_modules', 'bin', 'empty']) fs.mkdirSync(path.join(nonGit, name));
execFileSync('git', ['init', '--quiet', fixtures]);
fs.writeFileSync(path.join(fixtures, '.gitignore'), '*.log\nignored-empty/\n');
for (const name of ['visible.md', 'ignored.log', 'unicode-Ω.log', 'tracked.log']) fs.writeFileSync(path.join(fixtures, name), '# ' + name + '\n');
execFileSync('git', ['-C', fixtures, 'add', '--force', 'tracked.log']);
for (const name of ['ignored-empty', 'visible-empty', 'nested', 'onlyignored']) fs.mkdirSync(path.join(fixtures, name));
fs.writeFileSync(path.join(fixtures, 'onlyignored', 'one.log'), 'ignored content');
const hidden = path.join(fixtures, '.hidden.md'); fs.writeFileSync(hidden, '# Hidden\n');
fs.writeFileSync(path.join(fixtures, 'nested', 'nested.log'), '# Nested ignored\n');
fs.writeFileSync(path.join(fixtures, 'nested', 'nested.md'), '# Nested visible\n');
if (process.platform === 'win32') execFileSync('attrib', ['+H', hidden]);
const result = { ok: false, fixtures, nonGit, cases: [], errors: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, browser, context, session, otherSession, page;
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
  await wrapper.locator('.session-tab[data-tab="files"]').click();
  const tree = wrapper.locator('.file-browser-tree'), controls = wrapper.locator('.file-browser-navigation .file-visibility-controls');
  const select = name => tree.locator('.tree-node').filter({ has: page.locator('.tree-name', { hasText: new RegExp('^' + name.replace('.', '\\.') + '$') }) });
  await select('ignored.log').waitFor(); await select('ignored-empty').waitFor(); await select('visible-empty').waitFor();
  assert.equal(await select('.hidden.md').count(), 0); assert.equal(await controls.locator('[data-file-visibility="showIgnored"]').isChecked(), true);
  const params = new URLSearchParams({ path: fixtures, sessionId: session, depth: '1' });
  const treeDefault = await api('GET', '/api/files/tree?' + params), listDefault = await api('GET', '/api/files/list?' + params);
  assert.deepEqual(treeDefault.entries.map(e => e.name), listDefault.entries.map(e => e.name));
  assert.equal(treeDefault.visibility.ignoreAvailable, true);
  result.cases.push('Native hidden files are excluded by default while ignored and empty directories remain visible in both APIs');
  await select('visible.md').click(); const editor = wrapper.locator('.file-browser-preview textarea');
  await editor.fill('# Draft retained during filtering\n');
  await controls.locator('[data-file-visibility="showIgnored"]').uncheck();
  await select('ignored.log').waitFor({ state: 'hidden' }); assert.equal(await editor.inputValue(), '# Draft retained during filtering\n');
  assert.equal(await page.locator('.file-unsaved-overlay').count(), 0); await select('tracked.log').waitFor();
  assert.ok((await controls.locator('.file-visibility-summary').innerText()).includes('filtered out'));
  result.cases.push('Hiding ignored entries retains the dirty editor and tracked files without a save or discard');
  await controls.locator('[data-file-visibility="showHidden"]').check(); await select('.hidden.md').waitFor();
  assert.ok((await select('.hidden.md').innerText()).includes('Hidden'));
  await controls.locator('[data-file-visibility="showIgnored"]').check(); await select('unicode-Ω.log').waitFor();
  assert.ok((await select('unicode-Ω.log').innerText()).includes('Ignored'));
  result.cases.push('Hidden and ignored files reveal explicit labels, including Unicode names');
  await page.route('**/api/files/tree**', route => route.fulfill({ status: 503, body: 'Injected filter failure' }));
  await controls.locator('[data-file-visibility="showIgnored"]').uncheck();
  await wrapper.locator('.file-browser-navigation-error:not([hidden])').waitFor();
  await select('ignored.log').waitFor(); assert.equal(await editor.inputValue(), '# Draft retained during filtering\n');
  await page.unroute('**/api/files/tree**'); await controls.locator('[data-file-visibility="showIgnored"]').check();
  result.cases.push('A failed tree filter reload preserves the actual visible list and draft with an explicit error');
  await select('nested').click(); await select('nested.log').waitFor();
  await controls.locator('[data-file-visibility="showIgnored"]').uncheck(); await select('nested.log').waitFor({ state: 'hidden' });
  await controls.locator('[data-file-visibility="showIgnored"]').check(); await select('nested.log').waitFor();
  result.cases.push('Visibility changes also reload expanded child directories');
  await page.screenshot({ path: path.join(out, 'files-visibility.png') });
  await wrapper.locator('.file-browser-preview .preview-save-btn').click();
  await page.waitForFunction(() => document.querySelector('.file-browser-preview .file-save-status')?.dataset.fileSaveState === 'saved');
  await wrapper.locator('.session-tab[data-tab="terminal"]').click();
  await page.evaluate(folder => {
    const terminal = window.mmDebug.terminals.get(window.mmDebug.activeId).terminal;
    terminal._core._linkProviderService.linkProviders.at(-2)._handler(new MouseEvent('click'), folder);
  }, fixtures);
  const modal = page.locator('#file-viewer-modal'); await modal.locator('.file-list').waitFor();
  assert.equal(await modal.locator('[data-file-visibility="showHidden"]').isChecked(), true);
  assert.equal(await modal.locator('[data-file-visibility="showIgnored"]').isChecked(), true);
  await modal.locator('[data-file-visibility="showIgnored"]').uncheck();
  await modal.locator('.file-list-item', { has: page.locator('.file-name', { hasText: /^ignored\.log$/ }) }).waitFor({ state: 'hidden' });
  assert.equal(await controls.locator('[data-file-visibility="showIgnored"]').isChecked(), false);
  result.cases.push('Modal and Files share the same visibility state and actual filtered listing');
  await page.route('**/api/files/list**', route => route.fulfill({ status: 503, body: 'Injected directory filter failure' }));
  await modal.locator('[data-file-visibility="showIgnored"]').check();
  await modal.locator('.file-directory-filter-error').waitFor();
  await modal.locator('.file-list').waitFor(); assert.equal(await modal.locator('[data-file-visibility="showIgnored"]').isEnabled(), true);
  await page.unroute('**/api/files/list**'); await modal.locator('[data-file-visibility="showIgnored"]').uncheck();
  await modal.locator('.file-directory-filter-error').waitFor({ state: 'hidden' });
  result.cases.push('A failed directory filter reload preserves the listing and a working control for retry');
  await page.locator('#file-viewer-dock-btn').click(); const dock = page.locator('#file-viewer-dock');
  await dock.locator('.file-list').waitFor(); await dock.locator('[data-file-visibility="showIgnored"]').check();
  await dock.locator('.file-list-item', { has: page.locator('.file-name', { hasText: /^ignored\.log$/ }) }).waitFor();
  await page.screenshot({ path: path.join(out, 'dock-visibility.png') });
  await page.locator('#dock-undock').click(); await modal.locator('.file-list').waitFor();
  assert.equal(await modal.locator('[data-file-visibility="showIgnored"]').isChecked(), true);
  result.cases.push('Dock filtering works after presentation transfer and survives undocking');
  await modal.locator('.modal-close').click();
  await wrapper.locator('.session-tab[data-tab="files"]').click();
  const address = wrapper.locator('.file-browser-address-form input');
  await address.fill(path.join(fixtures, 'onlyignored')); await address.press('Enter');
  await page.waitForFunction(target => document.querySelector('.file-browser-address-form input')?.value === target && document.querySelector('.file-browser-navigation')?.getAttribute('aria-busy') === 'false', path.join(fixtures, 'onlyignored'));
  await controls.locator('[data-file-visibility="showIgnored"]').uncheck();
  await tree.locator('.tree-empty').waitFor(); assert.ok((await tree.locator('.tree-empty').innerText()).includes('visibility filters'));
  await controls.locator('[data-file-visibility="showIgnored"]').check(); await select('one.log').waitFor();
  result.cases.push('An all-filtered directory has an explicit empty-filter state and can reveal its files again');
  otherSession = (await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 90, rows: 30, workingDirectory: nonGit, launchRequestId: crypto.randomUUID() })).id;
  await page.locator(`.session-item[data-session-id="${otherSession}"] .session-title`).click();
  const otherWrapper = page.locator(`.session-wrapper[data-session-id="${otherSession}"]`);
  await otherWrapper.locator('.session-tab[data-tab="files"]').click();
  await otherWrapper.locator('.tree-name', { hasText: /^node_modules$/ }).waitFor();
  await otherWrapper.locator('.tree-name', { hasText: /^bin$/ }).waitFor();
  assert.equal(await otherWrapper.locator('[data-file-visibility="showIgnored"]').isDisabled(), true);
  const otherAddress = otherWrapper.locator('.file-browser-address-form input');
  await otherAddress.fill(path.join(nonGit, 'empty')); await otherAddress.press('Enter');
  await otherWrapper.locator('.tree-empty').waitFor(); assert.match(await otherWrapper.locator('.tree-empty').innerText(), /empty/i);
  result.cases.push('Non-Git directories retain ordinary folders and distinguish an actually empty directory from filtering');
  assert.deepEqual(result.errors, []); result.ok = true;
} catch (error) {
  result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>');
  if (page) { await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    result.pageText = (await page.locator('body').innerText().catch(() => '')).slice(-2500); }
  process.exitCode = 1;
} finally {
  if (context && session) { try { for (const id of [session, otherSession].filter(Boolean)) await api('DELETE', '/api/sessions/' + id); }
    catch (error) { result.cleanupFailure = String(error).replaceAll(cookie, '<redacted-session-cookie>'); result.ok = false; process.exitCode = 1; } }
  await context?.close(); await browser?.close(); chrome?.kill();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, cases: result.cases, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
