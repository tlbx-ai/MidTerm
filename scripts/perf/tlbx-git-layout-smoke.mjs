import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { exerciseGitHistory } from './git-history-acceptance.mjs';
import { exerciseGitTexts } from './git-text-acceptance.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('../../docs/marketing/ScreenshotAutomation/node_modules/playwright');
const url = process.env.TLBX_PERF_URL, cookie = process.env.TLBX_COOKIE_HEADER;
const navigation = process.env.TLBX_GIT_NAVIGATION === '1';
const history = process.env.TLBX_GIT_HISTORY === '1';
const texts = process.env.TLBX_GIT_TEXTS === '1';
if (!url || !cookie) throw new Error('Authenticated source URL required');
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/git-layout'); fs.mkdirSync(out, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-git-layout-'));
const folder = 'Folder with a long descriptive name/Deep directory with another long descriptive name';
const name = 'A very long tracked filename whose path must remain readable and whose actions must remain inside the inspector.txt';
const relative = folder + '/' + name, full = path.join(fixture, relative);
fs.mkdirSync(path.dirname(full), { recursive: true });
for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(fixture, `file${i}.txt`), 'Original\n');
fs.writeFileSync(full, 'Original\n'); fs.writeFileSync(path.join(fixture, '.gitignore'), '.tlbx/\n');
const git = args => execFileSync('git', ['-C', fixture, '-c', 'core.hooksPath=' + path.join(fixture, 'no-hooks'), ...args], { windowsHide: true, stdio: 'pipe' }).toString('utf8');
git(['init', '--quiet']); git(['config', 'user.name', 'A long author name used for inspector geometry acceptance']); git(['config', 'user.email', 'layout@tlbx.invalid']); git(['add', '.']); git(['commit', '--quiet', '-m', 'Fixture root']);
fs.appendFileSync(full, 'Normal commit line\n'); git(['commit', '--quiet', '-am', 'A long normal commit subject whose inspector must remain usable in a narrow dock']);
const commit = git(['rev-parse', 'HEAD']).trim();
if (texts) git(['commit','--allow-empty','-qm','A full Unicode subject ä 字 '+ 'with useful review context and a complete readable title '.repeat(9)]);
if (history) for (let index = 0; index < 53; index++) git(['commit','--allow-empty','--allow-empty-message','-qm', index===17 ? '' : `History commit ${index} ä 字`]);
for (let i = 0; i < 40; i++) fs.appendFileSync(path.join(fixture, `file${i}.txt`), `Changed ${i}\n`);
fs.appendFileSync(path.join(fixture, 'file35.txt'), Array.from({ length: 100 }, (_, i) => `Long changed line ${i} ` + 'abcdefghij'.repeat(8)).join('\n') + '\n');
fs.appendFileSync(full, 'WORKTREE_CHANGE_' + 'abcdefghij'.repeat(50) + '\n');
const result = { ok: false, fixture, cases: [], geometry: [], errors: [], inputFrames: 0, diffReads: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); let chrome, browser, context, page, session;
async function api(method, route, data) { const response = await context.request.fetch(url + route, { method, data }); assert.ok(response.ok(), `${route}: ${response.status()}`); const text = await response.text(); return text ? JSON.parse(text.replace(/^\uFEFF/, '')) : null; }
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check'], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) { try { const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break; } catch { await sleep(100); } }
  assert.ok(browser, 'Chrome started'); context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const eq = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]); await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  let ready = false;
  for (let i = 0; i < 40; i++) { try { const css = await context.request.get(url + '/css/app.css'); ready = css.ok() && (await css.text()).includes('@container git-panel (max-width: 539px)'); } catch {} if (ready) break; await sleep(250); }
  assert.ok(ready, 'Complete container-responsive CSS is served');
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 90, rows: 30, workingDirectory: fixture, launchRequestId: crypto.randomUUID() })).id;
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => result.errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.includes('/api/git/diff')) result.diffReads++; });
  page.on('websocket', socket => socket.on('framesent', frame => { if (Buffer.isBuffer(frame.payload) && frame.payload[0] === 0x14) result.inputFrames++; }));
  await page.goto(url); await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();
  const wrapper = page.locator(`.session-wrapper[data-session-id="${session}"]`), dock = page.locator('#git-dock');
  await page.evaluate(() => localStorage.setItem('mt-git-dock-width', '400')); await wrapper.locator('.git-indicator').click();
  const file = dock.locator(`.git-tree-file[data-path="${relative}"]`), inspector = dock.locator('.git-panel-inspector');
  if (texts) await exerciseGitTexts({page,dock,git,fixture,relative,out,result,api,session,url});
  else if (history) await exerciseGitHistory({page,dock,git,fixture,out,result,api,session});
  else {
  await file.click(); await inspector.locator('.git-diff-lines').waitFor(); assert.ok((await inspector.innerText()).includes('WORKTREE_CHANGE_'));
  async function measure(label) {
    const geometry = await dock.evaluate((el, label) => {
      const body = el.querySelector('.git-dock-body'), inspector = el.querySelector('.git-panel-inspector'), list = el.querySelector('.git-panel-list');
      const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      return { label, viewport: innerWidth, body: rect(body), inspector: rect(inspector), listVisible: getComputedStyle(list).display !== 'none', overflow: inspector.scrollWidth > inspector.clientWidth + 1, buttons: [...inspector.querySelectorAll('button')].map(button => ({ action: button.dataset.action, ...rect(button) })).filter(r => r.width > 0 && r.height > 0) };
    }, label);
    assert.ok(geometry.inspector.width > 0 && geometry.inspector.right <= geometry.body.right + 1 && geometry.inspector.right <= geometry.viewport + 1, JSON.stringify(geometry));
    assert.equal(geometry.overflow, false, JSON.stringify(geometry));
    assert.equal(geometry.listVisible, geometry.body.width > 539, JSON.stringify(geometry));
    for (const button of geometry.buttons) assert.ok(button.x >= geometry.inspector.x - 1 && button.right <= geometry.inspector.right + 1, JSON.stringify({ label, button, inspector: geometry.inspector }));
    result.geometry.push(geometry);
  }
  if (navigation) {
    const grip = dock.locator('.git-dock-resize-grip'), body = inspector.locator('.git-inspector-body');
    await grip.focus(); await grip.press('End'); await page.waitForFunction(() => document.querySelector('#git-dock').getBoundingClientRect().width === 600);
    const navFile = dock.locator('.git-tree-file[data-path="file35.txt"]');
    const rows = dock.locator('.git-section-body'); await rows.evaluate(el => { el.scrollTop = 280; }); await navFile.click(); await inspector.locator('.git-diff-lines').filter({ hasText: 'Long changed line' }).waitFor(); await body.evaluate(el => { el.scrollTop = 250; });
    await body.evaluate(el => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const initial = { list: await rows.evaluate(el => el.scrollTop), detail: await body.evaluate(el => el.scrollTop), reads: result.diffReads };
    await body.evaluate(el => { window.gitRetainedBody = el; window.gitRetainedDiff = el.querySelector('.git-diff-lines'); });
    await navFile.focus(); await page.setViewportSize({ width: 500, height: 1000 }); await page.waitForFunction(() => document.querySelector('#git-dock').getBoundingClientRect().width === 500);
    await page.waitForFunction(() => document.activeElement?.classList.contains('git-inspector-back'));
    assert.equal(await body.evaluate(el => el.scrollTop), initial.detail); assert.equal(await dock.locator('.git-panel-list').isVisible(), false);
    await inspector.locator('.git-inspector-back').press('Enter'); await page.waitForFunction(() => document.activeElement?.dataset.action === 'open-file');
    assert.equal(await navFile.getAttribute('class').then(c => c.includes('git-tree-file-selected')), true); assert.equal(await rows.evaluate(el => el.scrollTop), initial.list);
    await navFile.press('Enter'); await page.waitForFunction(() => document.activeElement?.classList.contains('git-inspector-back'));
    assert.equal(result.diffReads, initial.reads); assert.equal(await body.evaluate(el => el === window.gitRetainedBody && el.querySelector('.git-diff-lines') === window.gitRetainedDiff), true);
    assert.equal(await body.evaluate(el => el.scrollTop), initial.detail);
    result.cases.push('Narrow Back retains the exact selected file, list scroll and loaded diff; keyboard reopens cached content with visible focus and zero refetches');
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (let cycle = 0; cycle < 3; cycle++) {
      await grip.focus(); await grip.press('End'); await page.waitForFunction(() => document.querySelector('#git-dock .git-panel-list').getClientRects().length > 0);
      assert.equal(await grip.evaluate(el => document.activeElement === el), true); assert.equal(await rows.evaluate(el => el.scrollTop), initial.list);
      if (await inspector.locator('.git-command-section').getAttribute('open') === null) await inspector.locator('.git-command-section > summary').click();
      await inspector.locator('[data-action="copy-command"]').first().focus();
      await page.setViewportSize({ width: 900, height: 900 }); await page.setViewportSize({ width: 1920, height: 1000 });
      assert.equal(await body.evaluate(el => el === window.gitRetainedBody), true);
      await grip.focus(); await grip.press('Home'); await page.waitForFunction(() => document.querySelector('#git-dock').getBoundingClientRect().width === 250);
      assert.equal(await grip.evaluate(el => document.activeElement === el), true); assert.equal(result.diffReads, initial.reads);
    }
    result.cases.push('Repeated real keyboard dock and window resizing preserves selected content, retained DOM, scroll and resizer focus');
    const start = await grip.boundingBox(); await page.mouse.move(start.x + start.width / 2, start.y + 200); await page.mouse.down(); await page.mouse.move(start.x - 180, start.y + 200, { steps: 8 }); await page.mouse.up();
    assert.ok((await dock.boundingBox()).width >= 420); assert.equal(await grip.getAttribute('aria-orientation'), 'vertical');
    await grip.press('End'); assert.equal(await page.evaluate(() => localStorage.getItem('mt-git-dock-width')), '600');
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForFunction(() => document.querySelector('#git-dock').dataset.gitOverlay === 'true');
    const overlay = await dock.boundingBox(); assert.equal(overlay.x, 0); assert.equal(overlay.width, 390); assert.equal(await grip.isVisible(), false);
    assert.equal(await wrapper.locator('.session-tab-panels').evaluate(el => getComputedStyle(el).marginRight), '0px');
    assert.ok((await inspector.innerText()).includes('Long changed line')); await page.screenshot({ path: path.join(out, 'mobile-overlay-390.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.waitForFunction(() => document.querySelector('#git-dock').getBoundingClientRect().width === 600);
    assert.equal(result.diffReads, initial.reads); await page.screenshot({ path: path.join(out, 'restored-wide-600.png'), animations: 'disabled' });
    result.cases.push('Actual pointer resize persists width; 390px overlay retains inspection without terminal margin reservation and restores the saved desktop width');
  } else {
  for (const viewport of [900, 1440, 1920]) {
    await page.setViewportSize({ width: viewport, height: 1000 });
    for (const width of [250, 300, 400, 539, 540, 541, 600]) {
      await dock.evaluate((el, width) => { el.style.width = width + 'px'; }, width);
      await dock.evaluate(el => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await measure(`${viewport}-${width}-file`);
      const body = inspector.locator('.git-inspector-body'); await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
      if (await inspector.locator('.git-command-section').getAttribute('open') === null) await inspector.locator('.git-command-section > summary').click();
      const copy = inspector.locator('[data-action="copy-command"]').first(); await copy.click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await copy.getAttribute('data-command'));
      await body.evaluate(el => { el.scrollTop = 0; }); await inspector.locator('.git-path-details').click();
      const info = page.locator('.file-operation-overlay'); assert.ok((await info.locator('.file-operation-message').innerText()).includes(full)); await info.locator('[data-operation-choice="cancel"]').click();
      await page.screenshot({ path: path.join(out, `${viewport}-${width}.png`), animations: 'disabled' });
    }
  }
  result.cases.push('21 real file-inspector layouts at 250–600px docks and 900/1440/1920px windows retain the complete diff, full path and clickable Copy/Details actions without horizontal clipping');
  await dock.evaluate(el => { el.style.width = '600px'; });
  const back = inspector.locator('.git-inspector-back'); if (await back.isVisible()) await back.click();
  if (await dock.locator(`.git-commit-entry[data-hash="${commit}"]`).count() === 0) await dock.locator('[data-action="toggle-section"][data-section="commits"]').click();
  await dock.locator(`.git-commit-entry[data-hash="${commit}"]`).click(); await inspector.locator('.git-commit-body, .git-commit-patch-list').first().waitFor();
  for (const viewport of [900, 1440, 1920]) for (const width of [250, 400, 600]) {
    await page.setViewportSize({ width: viewport, height: 1000 }); await dock.evaluate((el, width) => { el.style.width = width + 'px'; }, width);
    await dock.evaluate(el => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await measure(`${viewport}-${width}-commit`);
    await page.screenshot({ path: path.join(out, `${viewport}-${width}-commit.png`), animations: 'disabled' });
  }
  result.cases.push('Nine real normal-commit inspectors keep long authors, parent hashes, patches and actions inside the available panel');
  }
  }
  assert.equal(result.inputFrames, 0); assert.deepEqual(result.errors, []); result.ok = true;
} catch (error) { result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>'); await page?.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled' }).catch(() => {}); process.exitCode = 1; }
finally {
  if (context && session) await api('DELETE', '/api/sessions/' + session).catch(error => { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; });
  await context?.close(); await browser?.close(); chrome?.kill(); fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ok: result.ok, cases: result.cases, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
