import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('../../docs/marketing/ScreenshotAutomation/node_modules/playwright');
const { PNG } = require('../../docs/marketing/ScreenshotAutomation/node_modules/playwright-core/lib/utilsBundle.js');
const url = process.env.TLBX_PERF_URL, cookie = process.env.TLBX_COOKIE_HEADER;
if (!url || !cookie) throw new Error('Authenticated source URL required');
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/file-surfaces');
fs.mkdirSync(out, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-surfaces-'));
const documentPath = path.join(fixture, 'tracked.txt');
fs.writeFileSync(documentPath, 'Original first line\nsecond line\nthird line\n');
fs.writeFileSync(path.join(fixture, '.gitignore'), '.tlbx/\nno-hooks/\n'); fs.mkdirSync(path.join(fixture, 'no-hooks'));
const git = args => execFileSync('git', ['-C', fixture, ...args], { windowsHide: true, stdio: 'pipe' });
git(['init', '--quiet']); git(['config', 'user.name', 'Surface acceptance']); git(['config', 'user.email', 'surface@tlbx.invalid']);
git(['config', 'core.hooksPath', path.join(fixture, 'no-hooks')]); git(['add', '--', 'tracked.txt', '.gitignore']); git(['commit', '--quiet', '-m', 'Fixture baseline', '-m', 'A commit body for surface acceptance.']);
fs.writeFileSync(documentPath, 'Intermediate first line\nsecond line\nthird line\n');
git(['add', '--', 'tracked.txt']); git(['commit', '--quiet', '-m', 'Fixture surface', '-m', 'Commit body.']);
fs.writeFileSync(documentPath, 'Changed first line\nsecond line\nthird line\n');
const wallpaper = new PNG({ width: 64, height: 64 });
for (let i = 0; i < wallpaper.data.length; i += 4) { wallpaper.data[i] = 60; wallpaper.data[i + 1] = 120; wallpaper.data[i + 2] = 168; wallpaper.data[i + 3] = 255; }
const wallpaperBytes = PNG.sync.write(wallpaper); fs.writeFileSync(path.join(out, 'wallpaper.png'), wallpaperBytes);
const result = { ok: false, fixture, samples: [], errors: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, browser, context, page, session, savedSettings, savedImage;
async function api(method, route, data) {
  const response = await context.request.fetch(url + route, { method, data }); assert.ok(response.ok(), `${route}: ${response.status()}`);
  const text = await response.text(); return text ? JSON.parse(text) : null;
}
async function upload(bytes, name) {
  const response = await context.request.post(url + '/api/settings/background-image', { multipart: { file: { name, mimeType: 'image/png', buffer: bytes } } });
  assert.ok(response.ok(), `Image upload: ${response.status()}`); return response.json();
}
function rgba(value) {
  const numbers = value.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 0];
  if (value.startsWith('color(')) for (let i = 0; i < 3; i++) numbers[i] *= 255;
  return [...numbers.slice(0, 3), numbers[3] ?? 1];
}
async function sample(label, selector, owner, imageColor) {
  const evidence = await page.locator(selector).last().evaluate((element, stop) => {
    const chain = []; let node = element;
    while (node) {
      const style = getComputedStyle(node);
      chain.push({ tag: node.tagName, class: node.className, background: style.backgroundColor, image: style.backgroundImage });
      if (node.matches(stop)) break; node = node.parentElement;
    }
    const box = element.getBoundingClientRect(); let right = Math.min(innerWidth, box.right), bottom = Math.min(innerHeight, box.bottom);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
      if (/(auto|hidden|scroll|clip)/.test(style.overflowX)) right = Math.min(right, rect.right);
      if (/(auto|hidden|scroll|clip)/.test(style.overflowY)) bottom = Math.min(bottom, rect.bottom);
      if (parent.matches(stop)) break;
    }
    return { chain, owner: chain.at(-1)?.background, point: { x: right - 24, y: bottom - 24 }, box: { x: box.x, y: box.y, width: box.width, height: box.height } };
  }, owner);
  const painted = evidence.chain.filter(layer => rgba(layer.background)[3] > 0);
  assert.equal(painted.length, 1, `${label}: ${JSON.stringify(evidence.chain)}`);
  const expectedSurface = rgba(evidence.owner);
  const screenshot = await page.screenshot({ animations: 'disabled' });
  const pixels = PNG.sync.read(screenshot), x = Math.floor(evidence.point.x), y = Math.floor(evidence.point.y), offset = (y * pixels.width + x) * 4;
  const actual = [...pixels.data.subarray(offset, offset + 3)];
  const expected = expectedSurface.slice(0, 3).map((c, i) => Math.round(c * expectedSurface[3] + imageColor[i] * (1 - expectedSurface[3])));
  assert.ok(actual.every((c, i) => Math.abs(c - expected[i]) <= 3), `${label} pixel ${actual} != ${expected}`);
  result.samples.push({ label, actual, expected, alpha: expectedSurface[3], chain: evidence.chain });
  if (label.includes('65')) fs.writeFileSync(path.join(out, label + '.png'), screenshot);
}
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check'], {
    windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')],
  });
  for (let i = 0; i < 100; i++) { try { const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break; } catch { await sleep(100); } }
  if (!browser) throw new Error('Chrome did not start');
  context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const eq = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]);
  let ready = false;
  for (let i = 0; i < 40; i++) { try { const css = await context.request.get(url + '/css/app.css'); ready = css.ok() && (await css.text()).includes('.file-selection-target'); } catch {} if (ready) break; await sleep(250); }
  if (!ready) throw new Error('Source assets are not ready');
  savedSettings = await api('GET', '/api/settings');
  if (savedSettings.backgroundImageFileName) { const image = await context.request.get(url + '/api/settings/background-image'); assert.ok(image.ok()); savedImage = await image.body(); fs.writeFileSync(path.join(out, 'original-wallpaper.backup'), savedImage); }
  const info = await upload(wallpaperBytes, 'surface-wallpaper.png');
  await api('PATCH', '/api/settings', { backgroundImageEnabled: true, backgroundKenBurnsEnabled: false });
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 90, rows: 30, workingDirectory: fixture, launchRequestId: crypto.randomUUID() })).id;
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => result.errors.push(e.message));
  await page.goto(url); await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();
  const imageColor = await page.evaluate(async revision => { const image = new Image(); image.src = `/api/settings/background-image?v=${revision}&encoding=2`; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); }, info.revision);
  const wrapper = page.locator(`.session-wrapper[data-session-id="${session}"]`), files = wrapper.locator('.session-tab[data-tab="files"]'), terminal = wrapper.locator('.session-tab[data-tab="terminal"]');
  await files.click();
  const row = wrapper.locator('.tree-node').filter({ has: page.locator('.tree-name', { hasText: /^tracked\.txt$/ }) }); await row.waitFor();
  for (const theme of ['dark', 'light', 'solarizedDark', 'solarizedLight']) for (const transparency of [0, 65, 90]) {
    await api('PATCH', '/api/settings', { theme, uiTransparency: transparency, terminalTransparency: transparency });
    await page.reload(); await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();
    await page.waitForFunction(({ theme, transparency }) => window.mmDebug.settings.theme === theme && window.mmDebug.settings.uiTransparency === transparency, { theme, transparency });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await files.click(); await row.click();
    const preview = wrapper.locator('.file-browser-preview'); await preview.locator('.file-document-source').waitFor();
    const label = `${theme}-${transparency}`;
    await sample(label + '-tree', `.session-wrapper[data-session-id="${session}"] .file-browser-tree`, '.file-browser', imageColor);
    await sample(label + '-source', `.session-wrapper[data-session-id="${session}"] .file-document-source .file-viewer-text`, '.file-browser', imageColor);
    await preview.locator('.file-document-mode[data-mode="edit"]').click();
    await sample(label + '-editor', `.session-wrapper[data-session-id="${session}"] .file-document-editor textarea`, '.file-browser', imageColor);
    await terminal.click();
    await page.evaluate(target => window.mmDebug.terminals.get(window.mmDebug.activeId).terminal._core._linkProviderService.linkProviders.at(-2)._handler(new MouseEvent('click'), target), documentPath);
    const modal = page.locator('#file-viewer-modal'); await modal.locator('.file-document-view').waitFor();
    await modal.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
    await sample(label + '-modal', '#file-viewer-modal .file-document-source .file-viewer-text', '.file-viewer-modal-content', imageColor);
    await modal.locator('#file-viewer-dock-btn').click();
    const dock = page.locator('#file-viewer-dock'); await dock.locator('.file-document-source').waitFor();
    await sample(label + '-dock', '#file-viewer-dock .file-document-source .file-viewer-text', '#file-viewer-dock', imageColor);
    await dock.locator('#dock-close').click();
    await page.evaluate(() => localStorage.setItem('mt-git-dock-width', '600'));
    await wrapper.locator('.git-indicator').click();
    const gitDock = page.locator('#git-dock'); await gitDock.locator('.git-tree-file[data-path="tracked.txt"]').click();
    await gitDock.locator('.git-diff-lines').waitFor();
    await sample(label + '-git-list', '#git-dock .git-panel-list', '.git-panel-shell', imageColor);
    await sample(label + '-git-inspector', '#git-dock .git-panel-inspector', '.git-panel-shell', imageColor);
    await sample(label + '-git-diff', '#git-dock .git-diff-lines', '.git-panel-shell', imageColor);
    await gitDock.locator('[data-action="toggle-section"][data-section="commits"]').click();
    await gitDock.locator('.git-commit-entry').first().click(); await gitDock.locator('.git-commit-body').waitFor();
    await sample(label + '-git-commit', '#git-dock .git-commit-body', '.git-panel-shell', imageColor);
    await gitDock.locator('#git-dock-close').click();
  }
  assert.deepEqual(result.errors, []); result.ok = true;
} catch (error) {
  result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>');
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); process.exitCode = 1;
} finally {
  if (context) try {
    if (session) await api('DELETE', '/api/sessions/' + session);
    if (savedSettings) {
      if (savedImage) await upload(savedImage, savedSettings.backgroundImageFileName); else await api('DELETE', '/api/settings/background-image');
      await api('PATCH', '/api/settings', { theme: savedSettings.theme, uiTransparency: savedSettings.uiTransparency, terminalTransparency: savedSettings.terminalTransparency, backgroundImageEnabled: savedSettings.backgroundImageEnabled, backgroundKenBurnsEnabled: savedSettings.backgroundKenBurnsEnabled });
    }
  } catch (error) { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; }
  await context?.close(); await browser?.close(); chrome?.kill();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, samples: result.samples.length, failure: result.failure, cleanupFailure: result.cleanupFailure, summary: path.join(out, 'summary.json') }));
}
