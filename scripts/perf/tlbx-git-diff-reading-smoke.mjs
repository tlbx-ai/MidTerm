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
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/git-diff-reading'); fs.mkdirSync(out, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-git-reading-'));
const filename = 'compare.txt', full = path.join(fixture, filename);
const original = Array.from({ length: 35 }, (_, i) => `Original context line ${i}`);
original[4] = '\tOLD_TAB ' + 'old_ä漢字😀'.repeat(70); original[5] = '    OLD_SPACES ' + 'old_code'.repeat(100);
fs.writeFileSync(full, original.join('\r\n') + '\r\n'); fs.writeFileSync(path.join(fixture, '.gitignore'), '.tlbx/\n');
const git = args => execFileSync('git', ['-C', fixture, '-c', 'core.hooksPath=' + path.join(fixture, 'no-hooks'), ...args], { windowsHide: true, stdio: 'pipe' }).toString('utf8');
git(['init', '--quiet']); git(['config', 'user.name', 'Diff acceptance']); git(['config', 'user.email', 'diff@tlbx.invalid']); git(['config', 'core.autocrlf', 'false']); git(['add', '.']); git(['commit', '--quiet', '-m', 'Baseline']);
const changed = [...original]; changed[4] = '\tTAB_MARK ' + 'new_ä漢字😀'.repeat(70); changed[5] = '    SPACE_MARK ' + 'new_code'.repeat(100); changed[25] = 'Changed later hunk: <script>alert("literal")</script> & Unicode ö 漢字 😀';
fs.writeFileSync(full, changed.join('\r\n') + '\r\n'); const expectedDisk = fs.readFileSync(full);
const result = { ok: false, fixture, cases: [], geometry: [], css: [], errors: [], mutations: 0, inputFrames: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); let chrome, browser, context, page, session;
async function api(method, route, data) { const response = await context.request.fetch(url + route, { method, data }); assert.ok(response.ok(), `${route}: ${response.status()}`); const text = await response.text(); return text ? JSON.parse(text.replace(/^\uFEFF/, '')) : null; }
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check'], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) { try { const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break; } catch { await sleep(100); } }
  assert.ok(browser, 'Chrome started'); context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const eq = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]);
  let ready = false;
  for (let i = 0; i < 40; i++) { try { const css = await context.request.get(url + '/css/app.css'), en = await context.request.get(url + '/locales/en.json'); ready = css.ok() && (await css.text()).includes('.git-panel-shell[data-diff-wrap=') && JSON.parse((await en.text()).replace(/^\uFEFF/, ''))['git.wrapLines'] === 'Wrap lines'; } catch {} if (ready) break; await sleep(250); }
  assert.ok(ready, 'Wrap CSS and locale are served');
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 90, rows: 30, workingDirectory: fixture, launchRequestId: crypto.randomUUID() })).id;
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => result.errors.push(error.message));
  page.on('response', async response => { if (new URL(response.url()).pathname === '/css/app.css') { const text = await response.text().catch(() => ''); result.css.push({ status: response.status(), size: text.length, complete: text.includes('.file-path-details') && text.includes('.git-diff-table') }); } });
  page.on('websocket', socket => socket.on('framesent', frame => { if (Buffer.isBuffer(frame.payload) && frame.payload[0] === 0x14) result.inputFrames++; }));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/git') && request.method() !== 'GET') result.mutations++; });
  await page.goto(url);
  assert.equal(await page.locator('#git-dock').evaluate(el => getComputedStyle(el).position), 'absolute', 'Actual browser CSS must be synchronized');
  const wrapper = page.locator(`.session-wrapper[data-session-id="${session}"]`), dock = page.locator('#git-dock');
  async function selectFile() { await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click(); await wrapper.locator('.git-indicator').click(); await dock.locator(`.git-tree-file[data-path="${filename}"]`).click(); await dock.locator('.git-diff-lines').first().waitFor(); }
  await selectFile();
  const wrap = dock.locator('[data-action="toggle-diff-wrap"]'), grip = dock.locator('.git-dock-resize-grip'), panes = dock.locator('.git-diff-lines');
  const snapshot = () => dock.locator('.git-diff-hunk-block').evaluateAll(hunks => hunks.map(hunk => ({ header: hunk.querySelector('.git-diff-hunk-header').textContent, lines: [...hunk.querySelectorAll('.git-diff-line')].map(line => ({ kind: line.className, text: line.textContent })) })));
  const expected = await snapshot(); assert.ok(expected.length >= 2); assert.equal(await wrap.getAttribute('aria-pressed'), 'false');
  await panes.evaluateAll(nodes => { window.diffReadingNodes = nodes; });
  for (const width of [250, 400, 600]) {
    await grip.focus(); await grip.press('End'); if (width === 250) await grip.press('Home'); else if (width === 400) for (let i = 0; i < 4; i++) await grip.press('Shift+ArrowRight');
    assert.equal((await dock.boundingBox()).width, width);
    if ((await wrap.getAttribute('aria-pressed')) === 'true') await wrap.click();
    const nowrap = await panes.first().evaluate(el => ({ whiteSpace: getComputedStyle(el).whiteSpace, tabSize: getComputedStyle(el).tabSize, client: el.clientWidth, scroll: el.scrollWidth, heights: [...el.querySelectorAll('.git-diff-line')].map(line => line.getBoundingClientRect().height), lineHeight: parseFloat(getComputedStyle(el).lineHeight) }));
    assert.equal(nowrap.whiteSpace, 'pre'); assert.equal(nowrap.tabSize, '4'); assert.ok(nowrap.scroll > nowrap.client * 2); for (const height of nowrap.heights) assert.ok(Math.abs(height - nowrap.lineHeight) < 1, JSON.stringify(nowrap));
    const markers = await dock.locator('.git-diff-line-add .git-diff-code').evaluateAll(nodes => {
      function start(el, marker) { const r = document.createRange(); const index = el.textContent.indexOf(marker); r.setStart(el.firstChild, index); r.setEnd(el.firstChild, index + 1); return r.getBoundingClientRect().x; }
      return [start(nodes.find(el => el.textContent.includes('TAB_MARK')), 'TAB_MARK'), start(nodes.find(el => el.textContent.includes('SPACE_MARK')), 'SPACE_MARK')];
    }); assert.ok(Math.abs(markers[0] - markers[1]) < 0.5, JSON.stringify(markers));
    await panes.first().focus(); await panes.first().press('ArrowRight'); await page.waitForFunction(() => document.querySelector('#git-dock .git-diff-lines').scrollLeft > 0);
    const horizontal = await panes.first().evaluate(async el => { el.scrollLeft = 180; let stable = 0, previous = -1; for (let i = 0; i < 60 && stable < 5; i++) { await new Promise(resolve => requestAnimationFrame(resolve)); const value = el.scrollLeft; stable = value === previous ? stable + 1 : 0; previous = value; } return el.scrollLeft; });
    const signs = await panes.first().evaluate(el => { const box = el.getBoundingClientRect(); return [...el.querySelectorAll('.git-diff-sign')].map(sign => ({ x: sign.getBoundingClientRect().x, left: box.x, right: box.right, text: sign.textContent })); });
    for (const sign of signs) assert.ok(sign.x >= sign.left - 1 && sign.x < sign.right, JSON.stringify(sign));
    await wrap.focus(); await wrap.press('Enter'); assert.equal(await wrap.getAttribute('aria-pressed'), 'true'); assert.deepEqual(await snapshot(), expected);
    const wrapped = await panes.first().evaluate(el => ({ whiteSpace: getComputedStyle(el).whiteSpace, client: el.clientWidth, scroll: el.scrollWidth, heights: [...el.querySelectorAll('.git-diff-line')].map(line => line.getBoundingClientRect().height) }));
    assert.equal(wrapped.whiteSpace, 'pre-wrap'); assert.ok(wrapped.scroll <= wrapped.client + 1, JSON.stringify(wrapped)); assert.ok(Math.max(...wrapped.heights) > nowrap.lineHeight * 2); assert.equal(await panes.evaluateAll(nodes => nodes.every((el, i) => el === window.diffReadingNodes[i])), true);
    await page.screenshot({ path: path.join(out, `${width}-wrapped.png`), animations: 'disabled' });
    await wrap.press('Enter'); assert.equal(await panes.first().evaluate(el => el.scrollLeft), horizontal); assert.deepEqual(await snapshot(), expected);
    await page.screenshot({ path: path.join(out, `${width}-nowrap.png`), animations: 'disabled' }); result.geometry.push({ width, nowrap, wrapped, markers, horizontal });
  }
  result.cases.push('250/400/600px real diffs preserve complete Unicode/CRLF-derived text, hunk old/new ordering and equal tab/four-space indentation; keyboard horizontal scrolling and wrap toggles retain DOM and horizontal position');
  await wrap.click(); await page.reload(); await selectFile(); assert.equal(await wrap.getAttribute('aria-pressed'), 'true'); assert.equal(await panes.first().evaluate(el => getComputedStyle(el).whiteSpace), 'pre-wrap');
  assert.equal(await dock.locator('script').count(), 0); assert.deepEqual(fs.readFileSync(full), expectedDisk); assert.equal(result.mutations, 0); assert.equal(result.inputFrames, 0); assert.deepEqual(result.errors, []);
  result.cases.push('Wrap preference survives reload; literal HTML remains text; inspection performs zero Git writes, zero terminal input and preserves exact disk bytes'); result.ok = true;
} catch (error) { result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>'); await page?.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled' }).catch(() => {}); process.exitCode = 1; }
finally {
  if (context && session) await api('DELETE', '/api/sessions/' + session).catch(error => { result.cleanupFailure = String(error); result.ok = false; process.exitCode = 1; });
  await context?.close(); await browser?.close(); chrome?.kill(); fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ok: result.ok, cases: result.cases, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
