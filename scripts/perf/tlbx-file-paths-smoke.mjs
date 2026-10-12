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
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/file-paths'); fs.mkdirSync(out, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-paths-'));
const name = 'Same long filename with spaces and Unicode äöü whose full path must remain available.md';
const folders = ['Folder A with a long descriptive name', 'Folder B with a long descriptive name'];
const paths = folders.map(folder => path.join(fixture, folder, 'Deep directory with another long name', name));
for (const full of paths) { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, '# Path fixture\n'); }
fs.writeFileSync(path.join(fixture, '.gitignore'), '.tlbx/\n');
const git = args => execFileSync('git', ['-C', fixture, '-c', 'core.hooksPath=' + path.join(fixture, 'no-hooks'), ...args], { windowsHide: true, stdio: 'pipe' });
git(['init', '--quiet']); git(['config', 'user.name', 'Path acceptance']); git(['config', 'user.email', 'path@tlbx.invalid']); git(['add', '.']); git(['commit', '--quiet', '-m', 'Fixture baseline']);
for (const full of paths) fs.appendFileSync(full, 'Changed\n');
const result = { ok: false, fixture, cases: [], errors: [], mutations: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); let chrome, browser, context, page, session;
async function api(method, route, data) { const response = await context.request.fetch(url + route, { method, data }); assert.ok(response.ok(), `${route}: ${response.status()}`); const text = await response.text(); return text ? JSON.parse(text) : null; }
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check'], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) { try { const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break; } catch { await sleep(100); } }
  if (!browser) throw new Error('Chrome did not start');
  context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 }, hasTouch: true });
  const eq = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]); await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const css = await context.request.get(url + '/css/app.css'); assert.ok(css.ok() && (await css.text()).includes('.file-path-details'));
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 90, rows: 30, workingDirectory: fixture, launchRequestId: crypto.randomUUID() })).id;
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => result.errors.push(error.message));
  page.on('request', request => { if (/\/api\/files\/(save|operations)/.test(new URL(request.url()).pathname) && ['PUT', 'POST'].includes(request.method())) result.mutations++; });
  await page.goto(url); await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();
  const wrapper = page.locator(`.session-wrapper[data-session-id="${session}"]`); await wrapper.locator('.session-tab[data-tab="files"]').click();
  const tree = wrapper.locator('.file-browser-tree'), preview = wrapper.locator('.file-browser-preview');
  const byPath = full => tree.locator('.tree-node').filter({ has: page.locator('input') }).evaluateAll((rows, full) => rows.find(row => row.dataset.path === full)?.getAttribute('title'), full);
  async function navigate(folder) { await wrapper.locator('.file-browser-address-form input').fill(folder); await wrapper.locator('.file-browser-address-form button').click(); await page.waitForFunction(({ session, full }) => [...document.querySelectorAll(`.session-wrapper[data-session-id="${session}"] .tree-node`)].some(row => row.dataset.path === full), { session, full: path.join(folder, name) }); }
  const info = page.locator('.file-operation-overlay');
  async function copyDetails(expected) { await info.waitFor(); assert.ok((await info.locator('.file-operation-message').innerText()).includes(expected)); await info.locator('[data-operation-choice="copy"]').click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected); }
  for (const full of paths) {
    await navigate(path.dirname(full));
    const row = tree.locator('.tree-node').filter({ has: page.locator('.tree-name', { hasText: name }) });
    assert.equal(await byPath(full), full); assert.equal(await row.getAttribute('aria-label'), full);
    await row.locator('input').click(); const details = tree.locator('[data-selection-action="details"]'); await details.focus(); await details.press('Enter'); await copyDetails(full);
    assert.equal(await details.evaluate(el => el === document.activeElement), true);
  }
  result.cases.push('Deep equal filenames expose exact full tooltip/AX paths; keyboard Details copies the uncut path and restores focus');
  await tree.locator('[data-selection-action="open"]').click(); await preview.locator('.file-document-view').waitFor();
  await preview.locator('[data-path-details]').click(); await copyDetails(paths[1]);
  await wrapper.locator('.session-tab[data-tab="terminal"]').click();
  await page.evaluate(target => window.mmDebug.terminals.get(window.mmDebug.activeId).terminal._core._linkProviderService.linkProviders.at(-2)._handler(new MouseEvent('click'), target), paths[0]);
  const modal = page.locator('#file-viewer-modal'); await modal.locator('.file-document-view').waitFor(); await modal.locator('[data-path-details]').click(); await copyDetails(paths[0]);
  await modal.locator('#file-viewer-dock-btn').click(); const dock = page.locator('#file-viewer-dock'); await dock.locator('[data-path-details]').click(); await copyDetails(paths[0]); await dock.locator('#dock-close').click();
  result.cases.push('Preview, modal and dock all show and copy the same complete Unicode path without content mutations');
  await page.evaluate(() => localStorage.setItem('mt-git-dock-width', '600')); await wrapper.locator('.git-indicator').click();
  const gitDock = page.locator('#git-dock'); await gitDock.locator('.git-tree-file').first().waitFor();
  result.gitPaths = await gitDock.locator('.git-tree-file').evaluateAll(rows => rows.map(row => ({ path: row.dataset.path, title: row.title })));
  for (const full of paths) {
    const relative = path.relative(fixture, full).replaceAll('\\', '/');
    const fileButton = gitDock.locator(`.git-tree-file[data-path="${relative}"]`); assert.equal(await fileButton.getAttribute('title'), full); assert.equal(await fileButton.getAttribute('aria-label'), full);
    await fileButton.click(); await gitDock.locator('.git-path-details').click(); await copyDetails(full);
  }
  await gitDock.locator('#git-dock-close').click(); result.cases.push('Git equal-name rows identify their repository-rooted paths and Inspector Details copies the correct selected path');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(target => window.mmDebug.terminals.get(window.mmDebug.activeId).terminal._core._linkProviderService.linkProviders.at(-2)._handler(new MouseEvent('click'), target), path.dirname(paths[0]));
  await modal.locator('.file-list-item').first().tap(); await modal.locator('[data-selection-action="details"]').tap(); await copyDetails(paths[0]);
  await modal.locator('.modal-close').tap();
  await page.evaluate(target => window.mmDebug.terminals.get(window.mmDebug.activeId).terminal._core._linkProviderService.linkProviders.at(-2)._handler(new MouseEvent('click'), target), paths[1]);
  await modal.locator('[data-path-details]').tap(); await info.waitFor(); assert.ok((await info.locator('.file-operation-message').innerText()).includes(paths[1]));
  assert.equal(await info.locator('[role="dialog"]').evaluate(el => el.getBoundingClientRect().right <= innerWidth), true); await page.screenshot({ path: path.join(out, 'touch-full-path-390.png') }); await copyDetails(paths[1]);
  assert.equal(result.mutations, 0); assert.deepEqual(result.errors, []); result.ok = true; result.cases.push('390px touch directory and file Details remain readable and copy full paths with zero filesystem mutation requests');
} catch (error) { result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>'); await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); process.exitCode = 1; }
finally {
  if (context && session) try { await api('DELETE', '/api/sessions/' + session); } catch (error) { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; }
  await context?.close(); await browser?.close(); chrome?.kill(); fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ok: result.ok, cases: result.cases, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
