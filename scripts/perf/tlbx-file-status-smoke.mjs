import assert from 'node:assert/strict';
import { clickControl, tapControl } from './ui-controls.mjs';
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
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/file-status'); fs.mkdirSync(out, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-status-'));
const git = args => execFileSync('git', ['-C', fixture, '-c', 'core.hooksPath=' + path.join(fixture, 'no-hooks'), ...args], { windowsHide: true, stdio: 'pipe' }).toString('utf8');
const write = (relative, content) => { const full = path.join(fixture, relative); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content); };
for (const folder of ['conflict', 'modified', 'deleted', 'renamed', 'mixed']) write(folder + '/change.txt', 'Baseline\n');
for (const folder of ['deleted', 'added', 'untracked']) write(folder + '/keep.txt', 'Unchanged\n');
write('.gitignore', '.tlbx/\n');
git(['init', '--quiet', '-b', 'main']); git(['config', 'user.name', 'Status acceptance']); git(['config', 'user.email', 'status@tlbx.invalid']); git(['add', '.']); git(['commit', '--quiet', '-m', 'Fixture baseline']);
git(['checkout', '--quiet', '-b', 'side']); write('conflict/change.txt', 'Side\n'); git(['commit', '--quiet', '-am', 'Side change']);
git(['checkout', '--quiet', 'main']); write('conflict/change.txt', 'Main\n'); git(['commit', '--quiet', '-am', 'Main change']);
assert.throws(() => git(['merge', '--no-edit', 'side'])); assert.ok(git(['ls-files', '-u']).includes('conflict/change.txt'));
write('modified/change.txt', 'Modified\n'); fs.unlinkSync(path.join(fixture, 'deleted/change.txt'));
git(['mv', 'renamed/change.txt', 'renamed/New name äöü.txt']);
write('added/New file.txt', 'Added\n'); git(['add', 'added/New file.txt']);
write('untracked/New file.txt', 'Untracked\n'); write('mixed/change.txt', 'Index\n'); git(['add', 'mixed/change.txt']); write('mixed/change.txt', 'Index\nWorktree\n');
const expected = [
  { folder: 'modified', file: 'modified/change.txt', status: 'modified', letter: 'M' },
  { folder: 'untracked', file: 'untracked/New file.txt', status: 'untracked', letter: 'U' },
  { folder: 'added', file: 'added/New file.txt', status: 'added', letter: 'A' },
  { folder: 'deleted', file: 'deleted/change.txt', status: 'deleted', letter: 'D' },
  { folder: 'renamed', file: 'renamed/New name äöü.txt', status: 'renamed', letter: 'R' },
  { folder: 'conflict', file: 'conflict/change.txt', status: 'conflicted', letter: '!' },
];
const result = { ok: false, fixture, cases: [], samples: [], errors: [], mutations: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); let chrome, browser, context, page, session, savedSettings;
async function api(method, route, data) { const response = await context.request.fetch(url + route, { method, data }); assert.ok(response.ok(), `${route}: ${response.status()}`); const text = await response.text(); return text ? JSON.parse(text.replace(/^\uFEFF/, '')) : null; }
async function dialogContrast(label, root = '.file-operation-overlay') {
  const elements = page.locator(`${root} .file-operation-message, ${root} .dialog-message, ${root} .file-unsaved-path, ${root} h3, ${root} button`);
  const samples = await elements.evaluateAll(nodes => { window.statusContrastNodes = nodes.map(el => ({ el, style: el.getAttribute('style') })); return nodes.map(el => { const style = getComputedStyle(el), r = el.getBoundingClientRect(); const sample = { text: el.textContent, color: style.color, x: r.x + Math.min(8, r.width / 2), y: r.y + Math.min(8, r.height / 2) }; el.style.setProperty('color', 'transparent', 'important'); return sample; }); });
  let png;
  try { png = PNG.sync.read(await page.screenshot({ animations: 'disabled' })); }
  finally { await page.evaluate(() => { for (const { el, style } of window.statusContrastNodes) { if (style === null) el.removeAttribute('style'); else el.setAttribute('style', style); } delete window.statusContrastNodes; }); }
  const luminance = rgb => rgb.reduce((sum, c, i) => { const v = c / 255; return sum + [0.2126, 0.7152, 0.0722][i] * (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); }, 0);
  for (const sample of samples) {
    const bgOffset = (Math.floor(sample.y) * png.width + Math.floor(sample.x)) * 4;
    const background = [...png.data.subarray(bgOffset, bgOffset + 3)], fg = sample.color.match(/[\d.]+/g).map(Number).slice(0, 3);
    const a = luminance(fg), b = luminance(background), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    result.samples.push({ label, dialogText: sample.text, foreground: fg, background, ratio }); assert.ok(ratio >= 4.5, `${label}: ${sample.text}: ${ratio}`);
  }
}
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check'], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) { try { const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break; } catch { await sleep(100); } }
  assert.ok(browser, 'Chrome started'); context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 }, hasTouch: true });
  const eq = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]);
  const css = await context.request.get(url + '/css/app.css'); assert.ok(css.ok() && (await css.text()).includes('.tree-git-badge[data-git-status='));
  const en = await context.request.get(url + '/locales/en.json'); assert.equal(JSON.parse((await en.text()).replace(/^\uFEFF/, ''))['git.fileStatus.untracked'], 'Untracked');
  savedSettings = await api('GET', '/api/settings');
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 90, rows: 30, workingDirectory: fixture, launchRequestId: crypto.randomUUID() })).id;
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => result.errors.push(error.message));
  page.on('request', request => { if (/\/api\/files\/(save|operations)/.test(new URL(request.url()).pathname) && ['PUT', 'POST'].includes(request.method())) result.mutations++; });
  await page.goto(url);
  const wrapper = page.locator(`.session-wrapper[data-session-id="${session}"]`);
  const tree = wrapper.locator('.file-browser-tree');
  async function openFiles() { const title = page.locator(`.session-item[data-session-id="${session}"] .session-title`); await title.waitFor({ state: 'attached' }); if (await page.locator('#btn-hamburger').isVisible() && !(await page.locator('.terminal-page').evaluate(el => el.classList.contains('sidebar-open')))) await page.locator('#btn-hamburger').click(); await title.click(); const tab = wrapper.locator('.session-tab[data-tab="files"]'); if (await tab.isVisible()) await tab.click(); else if (await page.locator('#btn-mobile-strip-files').isVisible()) await page.locator('#btn-mobile-strip-files').click(); else { await page.locator('#btn-mobile-actions-menu').click(); await page.locator('#btn-mobile-tab-files').click(); } await tree.locator('[data-git-status="conflicted"]').first().waitFor(); }
  async function folderRow(folder) { const full = path.join(fixture, folder); return tree.locator(`.tree-node[data-path="${full.replaceAll('\\', '\\\\')}"]`); }
  async function badgeSnapshot(locator) { return locator.evaluate(el => ({ letter: el.textContent, status: el.dataset.gitStatus, color: getComputedStyle(el).color, title: el.title, label: el.getAttribute('aria-label') })); }
  for (const language of ['en', 'de']) for (const theme of ['dark', 'light', 'solarizedDark', 'solarizedLight']) {
    await api('PATCH', '/api/settings', { theme, uiTransparency: 90, language }); await page.reload(); await openFiles();
    const files = {};
    for (const state of expected) {
      const row = await folderRow(state.folder), badge = row.locator('.tree-git-badge');
      files[state.status] = await badgeSnapshot(badge); assert.equal(files[state.status].letter, state.letter); assert.equal(files[state.status].status, state.status);
      assert.equal(await row.getAttribute('aria-describedby'), await badge.getAttribute('id'));
      assert.ok(files[state.status].label.includes(language === 'en' ? 'Contains changes' : 'Enthält Änderungen'));
      await row.locator('.tree-expand').click();
      const fileRow = await folderRow(state.file);
      if (state.status === 'deleted') assert.equal(await fileRow.count(), 0);
      else {
        const fileBadge = fileRow.locator('.tree-git-badge'); await fileBadge.waitFor();
        const actual = await badgeSnapshot(fileBadge); assert.equal(actual.letter, state.letter); assert.equal(actual.status, state.status); assert.equal(actual.color, files[state.status].color); assert.ok(files[state.status].label.endsWith(actual.label));
      }
    }
    // Deleted entries no longer exist on disk; Files conveys their change through
    // the surviving parent, while Git retains the actual deleted file entry.
    assert.equal(await (await folderRow('deleted/change.txt')).count(), 0);
    await (await folderRow('modified')).click({ modifiers: ['Control'] }); await clickControl(tree.locator('[data-selection-action="details"]'));
    const dialog = page.locator('.file-operation-overlay'); await dialog.locator('[role="dialog"]').waitFor();
    await dialogContrast(`${language}-${theme}`); await page.screenshot({ path: path.join(out, `${language}-${theme}-details.png`), animations: 'disabled' }); await dialog.locator('[data-operation-choice="cancel"]').click();
    await (await folderRow('modified/change.txt')).click();
    const preview = wrapper.locator('.file-browser-preview'); await preview.locator('.file-document-modes [data-mode="edit"]').click();
    await preview.locator('textarea').fill('Unsaved contrast fixture\n'); await (await folderRow('untracked/New file.txt')).click();
    const decision = page.locator('.file-unsaved-overlay'); await decision.waitFor(); await dialogContrast(`${language}-${theme}-unsaved`, '.file-unsaved-overlay');
    await page.screenshot({ path: path.join(out, `${language}-${theme}-unsaved.png`), animations: 'disabled' }); await decision.locator('[data-file-decision="discard"]').click(); await decision.waitFor({ state: 'hidden' });
    assert.equal(fs.readFileSync(path.join(fixture, 'modified/change.txt'), 'utf8'), 'Modified\n');
    await wrapper.locator('.git-indicator').click();
    const dock = page.locator('#git-dock'); await dock.locator('.git-dock-resize-grip').press('End'); await dock.locator('.git-tree-file').first().waitFor();
    for (const state of expected) {
      const row = dock.locator(`.git-tree-file[data-path="${state.file}"]`), badge = row.locator('.git-file-indicator'), actual = await badgeSnapshot(badge);
      assert.equal(actual.letter, state.letter); assert.equal(actual.status, state.status); assert.equal(actual.color, files[state.status].color); assert.ok(files[state.status].label.endsWith(actual.label));
      assert.equal(await row.getAttribute('aria-describedby'), await badge.getAttribute('id')); assert.equal(actual.title, actual.label);
      result.samples.push({ language, theme, ...state, files: files[state.status], git: actual });
    }
    assert.equal(await dock.locator('.git-tree-file[data-path="mixed/change.txt"]').count(), 2);
    const back = wrapper.locator('.file-browser-back'); if (await back.isVisible()) await back.click();
    const ax = await context.newCDPSession(page); const axTree = await ax.send('Accessibility.getFullAXTree'); await ax.detach();
    const descriptions = axTree.nodes.filter(node => node.name?.value?.startsWith(fixture) && node.description?.value).map(node => ({ name: node.name.value, description: node.description.value, role: node.role.value }));
    assert.ok(descriptions.some(node => node.role === 'treeitem' && node.description.includes(language === 'en' ? 'Contains changes' : 'Enthält Änderungen')));
    for (const state of expected) {
      const label = files[state.status].label.split(': ').at(-1);
      assert.ok(descriptions.some(node => node.role === 'button' && node.name === path.join(fixture, state.file) && node.description === label));
      if (state.status !== 'deleted') assert.ok(descriptions.some(node => node.role === 'treeitem' && node.name === path.join(fixture, state.file) && node.description === label));
    }
    if (theme === 'dark') { await dock.locator('#git-dock-close').click(); await page.screenshot({ path: path.join(out, `${language}-files.png`) }); await wrapper.locator('.git-indicator').click(); await page.screenshot({ path: path.join(out, `${language}-git.png`) }); }
    await dock.locator('#git-dock-close').click();
  }
  result.cases.push('All six real states match letters, colors, translated labels and real Chrome AX descriptions in Files and Git across four themes and two languages');
  await page.setViewportSize({ width: 390, height: 844 }); await openFiles();
  const untrackedFolder = await folderRow('untracked');
  if ((await untrackedFolder.getAttribute('aria-expanded')) !== 'true') await untrackedFolder.locator('.tree-expand').tap();
  const untrackedBadge = tree.locator('.tree-node .tree-git-badge[data-git-status="untracked"]').last(); assert.equal((await badgeSnapshot(untrackedBadge)).letter, 'U');
  await tapControl(tree.locator('[data-selection-action="selectMultiple"]')); const selectedFile=await folderRow('untracked/New file.txt'); if(await selectedFile.getAttribute('aria-selected')!=='true')await selectedFile.tap(); await tapControl(tree.locator('[data-selection-action="details"]'));
  const info = page.locator('.file-operation-overlay'); assert.ok((await info.locator('.file-operation-message').innerText()).includes('Ungetrackt')); await dialogContrast('390px-touch'); await page.screenshot({ path: path.join(out, 'touch-files-status-details-390.png'), animations: 'disabled' }); await info.locator('[data-operation-choice="cancel"]').tap();
  await page.screenshot({ path: path.join(out, 'touch-files-390.png') });
  git(['add', 'untracked/New file.txt']); await api('POST', '/api/git/repos/refresh', { sessionId: session, repoRoot: fixture });
  await page.reload(); await openFiles(); const afterStage = await badgeSnapshot((await folderRow('untracked')).locator('.tree-git-badge')); assert.equal(afterStage.letter, 'A');
  git(['restore', '--staged', 'untracked/New file.txt']); await api('POST', '/api/git/repos/refresh', { sessionId: session, repoRoot: fixture });
  await page.reload(); await openFiles(); assert.equal((await badgeSnapshot((await folderRow('untracked')).locator('.tree-git-badge'))).letter, 'U');
  result.cases.push('390px touch and real stage/unstage distinguish U from A; mixed staged/worktree changes remain separate Git entries');
  assert.deepEqual(result.errors, []); assert.equal(result.mutations, 0); result.ok = true;
} catch (error) { result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>'); await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); process.exitCode = 1; }
finally {
  if (context && savedSettings) await api('PATCH', '/api/settings', { theme: savedSettings.theme, uiTransparency: savedSettings.uiTransparency, language: savedSettings.language }).catch(error => { result.restoreFailure = String(error); result.ok = false; process.exitCode = 1; });
  if (context && session) await api('DELETE', '/api/sessions/' + session).catch(error => { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; });
  await context?.close(); await browser?.close(); chrome?.kill(); fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ok: result.ok, cases: result.cases, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
