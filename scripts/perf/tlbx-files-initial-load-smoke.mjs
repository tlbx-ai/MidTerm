import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('../../docs/marketing/ScreenshotAutomation/node_modules/playwright');
const url = process.env.TLBX_PERF_URL, cookie = process.env.TLBX_COOKIE_HEADER;
if (!url || !cookie) throw new Error('Source URL and authenticated cookie required');
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/files-initial-load');
fs.mkdirSync(out, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-files-first-paint-'));
const child = path.join(fixture, 'child');
fs.mkdirSync(child); fs.writeFileSync(path.join(child, 'nested.txt'), 'nested');
fs.writeFileSync(path.join(fixture, 'root.txt'), 'root');
const result = { ok: false, cases: [], timings: [], errors: [] };
const sessions = [];
let chrome, browser, context, releaseRoots;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(method, route, data) {
  const response = await context.request.fetch(url + route, { method, data });
  assert.ok(response.ok(), `${route}: ${response.status()} ${await response.text()}`);
  const raw = await response.text(); return raw ? JSON.parse(raw) : null;
}
async function newSession(cwd) {
  const session = await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 90, rows: 30,
    workingDirectory: cwd, launchRequestId: crypto.randomUUID() });
  sessions.push(session.id); return session.id;
}
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check',
  ], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'),
    fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
  for (let i = 0; i < 100; i++) {
    try {
      const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break;
    } catch { await sleep(100); }
  }
  assert.ok(browser, 'Chrome started');
  context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const eq = cookie.indexOf('=');
  await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]);
  const real = await newSession('Q:\\repos\\Jpa');
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.errors.push(error.message));
  await page.goto(url);
  await page.locator(`.session-item[data-session-id="${real}"] .session-title`).click();
  const realWrapper = page.locator(`.session-wrapper[data-session-id="${real}"]`);
  let started = performance.now();
  await realWrapper.locator('.session-tab[data-tab="files"]').click();
  await realWrapper.locator('.tree-name').filter({ hasText: /^agent$/ }).waitFor();
  result.timings.push({ name: 'Real JPA first visible folders', ms: Math.round(performance.now() - started) });
  await page.screenshot({ path: path.join(out, 'jpa-first-folders.png') });
  result.cases.push('Real JPA folders render after first activation');

  const session = await newSession(fixture);
  await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();
  const wrapper = page.locator(`.session-wrapper[data-session-id="${session}"]`);
  const treeRequests = [];
  let sawEnrichment;
  const enrichmentStarted = new Promise(resolve => { sawEnrichment = resolve; });
  const blockedRoots = new Promise(resolve => { releaseRoots = resolve; });
  await page.route('**/api/files/navigation**', async route => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('sessionId') === session && query.get('includeDetectedRoots') !== 'false') {
      sawEnrichment(); await blockedRoots;
    }
    try { await route.continue(); } catch { /* An obsolete background request may be aborted. */ }
  });
  page.on('request', request => {
    const endpoint = new URL(request.url());
    if (endpoint.pathname === '/api/files/tree' && endpoint.searchParams.get('sessionId') === session)
      treeRequests.push({ path: endpoint.searchParams.get('path'), depth: endpoint.searchParams.get('depth') });
  });
  started = performance.now();
  await wrapper.locator('.session-tab[data-tab="files"]').click();
  await wrapper.locator('.tree-name').filter({ hasText: /^child$/ }).waitFor({ timeout: 2500 });
  const firstPaint = Math.round(performance.now() - started);
  result.timings.push({ name: 'Folders while optional roots remain blocked', ms: firstPaint });
  await enrichmentStarted;
  assert.ok(treeRequests.every(request => request.path === fixture && request.depth === '1'));
  assert.equal(await wrapper.locator('.tree-name').filter({ hasText: /^nested.txt$/ }).count(), 0);
  result.cases.push('Initial folders paint within 2.5s while optional root discovery is indefinitely blocked');
  result.cases.push('Initial listing requests depth 1 only; child folders are not scanned');
  await wrapper.locator('.tree-node').filter({ has: page.locator('.tree-name', { hasText: /^child$/ }) }).dblclick();
  await wrapper.locator('.tree-name').filter({ hasText: /^nested.txt$/ }).waitFor({ timeout: 2500 });
  releaseRoots();
  await page.waitForFunction(({ id, child }) => {
    const nav = document.querySelector(`.session-wrapper[data-session-id="${id}"] .file-browser-navigation`);
    return nav?.getAttribute('aria-busy') === 'false' && nav.querySelector('input').value === child;
  }, { id: session, child });
  await sleep(200);
  assert.equal(await wrapper.locator('.file-browser-address-form input').inputValue(), child);
  result.cases.push('Navigation continues during slow root discovery; stale root responses cannot restore the previous location');
  for (let i = 0; i < 3; i++) {
    await page.reload();
    const reloaded = page.locator(`.session-wrapper[data-session-id="${session}"]`);
    await reloaded.locator('.tree-name').filter({ hasText: /^child$/ }).waitFor();
  }
  result.cases.push('Three reloads with a remembered Files tab render folders');
  assert.deepEqual(result.errors, []);
  result.ok = true;
} catch (error) {
  result.failure = error.stack; process.exitCode = 1;
} finally {
  releaseRoots?.();
  for (const session of sessions) {
    try { await api('DELETE', '/api/sessions/' + session); } catch (error) { result.errors.push(String(error)); }
  }
  await context?.close(); await browser?.close();
  if (chrome && chrome.exitCode === null) chrome.kill();
  assert.ok(path.dirname(fixture) === os.tmpdir() && path.basename(fixture).startsWith('tlbx-files-first-paint-'));
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
