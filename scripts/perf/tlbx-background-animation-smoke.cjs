// TLBX_PERF_URL, TLBX_COOKIE_HEADER; optionally TLBX_PERF_ARTIFACT_ROOT.
// Uses an isolated Chrome profile and deletes only the sessions it creates.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium } = require('../../docs/marketing/ScreenshotAutomation/node_modules/playwright');
const url = process.env.TLBX_PERF_URL;
if (!url || !process.env.TLBX_COOKIE_HEADER) throw Error('Authenticated source URL and cookie required');
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/background-animation');
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const summary = { ok: false, samples: [], errors: [] };
const sessions = [];
let browser, context, chrome;
const fixture = http.createServer((req, res) => {
  if (req.url === '/slow-image') {
    setTimeout(() => { res.statusCode = 204; res.end(); }, 20000);
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  // Slow loads ensure the initial visibility messages have already expired.
  setTimeout(() => res.end(`<!doctype html><html><head><title>Background render</title></head>
    <body style="background:#fff;color:#111"><img src="/slow-image"><div id="app"></div><script>
    window.framesDrawn=0;
    requestAnimationFrame(function hydrate(){
      document.getElementById('app').innerHTML='<h1>Background form</h1><form action="/received"><input name="value"><button>Submit</button></form><output></output>';
      if(location.pathname==='/received'){document.querySelector('h1').id='received';document.querySelector('h1').textContent='Received '+new URLSearchParams(location.search).get('value')}
      function frame(){document.querySelector('output').textContent=++window.framesDrawn;requestAnimationFrame(frame)}
      frame();
    });</script></body></html>`), 800);
});
async function api(route, data) {
  const response = await context.request.fetch(url + route, { method: data ? 'POST' : 'GET', data });
  const text = await response.text();
  if (!response.ok()) throw Error(route + ': ' + response.status() + ' ' + text);
  try { return JSON.parse(text); } catch { return text; }
}
async function command(id, name, command, extra = {}) {
  const response = await api('/api/browser/command', { sessionId: id, previewName: name, command, ...extra });
  assert.equal(response.success, true, JSON.stringify(response));
  return response.result;
}
(async () => {
  try {
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const profile = path.join(out, 'chrome-' + Date.now());
    fs.mkdirSync(profile);
    chrome = spawn(process.env.TLBX_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
      '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
      '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check',
    ], { windowsHide: true, stdio: ['ignore', fs.openSync(path.join(out, 'chrome.stdout.log'), 'w'), fs.openSync(path.join(out, 'chrome.stderr.log'), 'w')] });
    for (let i = 0; i < 100; i++) {
      try {
        const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
        browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
        break;
      } catch { await sleep(100); }
    }
    if (!browser) throw Error('Chrome did not start');
    context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
    const cookie = process.env.TLBX_COOKIE_HEADER, eq = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url }]);
    const page = await context.newPage();
    page.on('pageerror', error => summary.errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => window.mmDebug?.terminals);
    for (let i = 0; i < 4; i++) {
      const response = await api('/api/sessions', { shell: 'Pwsh', cols: 100, rows: 30,
        workingDirectory: process.cwd(), launchRequestId: crypto.randomUUID() });
      sessions.push(response.id ?? response.session?.id);
    }
    async function select(id) {
      await page.locator('.session-item[data-session-id="' + id + '"]').click({ position: { x: 40, y: 12 } });
      await page.waitForFunction(id => window.mmDebug.activeId === id, id);
    }
    await select(sessions[0]);
    const target = 'http://127.0.0.1:' + fixture.address().port + '/';
    // Three independent sessions, two named previews each, all opened in background.
    for (const id of sessions.slice(1)) {
      for (const name of ['first', 'second']) {
        await api('/api/browser/open', { sessionId: id, previewName: name, url: target, activateSession: false });
        assert.equal(await command(id, name, 'query', { selector: 'h1', textOnly: true }), 'Background form');
        await command(id, name, 'wait', { selector: 'input', timeout: 10 });
        const first = Number(await command(id, name, 'exec', { value: 'window.framesDrawn' }));
        await sleep(2200);
        const next = Number(await command(id, name, 'exec', { value: 'window.framesDrawn' }));
        assert.ok(next > first, `Background rendering stalled: ${first} -> ${next}`);
        const value = id + '-' + name;
        await command(id, name, 'fill', { selector: 'input', value });
        await command(id, name, 'submit', { selector: 'form' });
        // A read can overlap the navigation gap; wait for the new document's bridge.
        const deadline = Date.now() + 15000;
        let received;
        do {
          try { received = await command(id, name, 'query', { selector: '#received', textOnly: true }); } catch {}
          if (received === 'Received ' + value) break;
          await sleep(250);
        } while (Date.now() < deadline);
        assert.equal(received, 'Received ' + value);
        assert.equal(await command(id, name, 'query', { selector: 'h1', textOnly: true }), 'Received ' + value);
        assert.equal(await page.evaluate(() => window.mmDebug.activeId), sessions[0]);
        summary.samples.push({ id, name, first, next, value });
      }
    }
    await select(sessions[3]);
    const frame = page.locator('.web-preview-iframe:not(.hidden)');
    await frame.waitFor();
    const h1 = await frame.contentFrame().locator('h1').innerText();
    assert.equal(h1, 'Received ' + sessions[3] + '-second');
    await page.screenshot({ path: path.join(out, 'visible-after-background.png') });
    assert.deepEqual(summary.errors, []);
    summary.ok = true;
  } catch (error) {
    summary.failure = error.stack;
    process.exitCode = 1;
  } finally {
    if (context) for (const id of sessions) await context.request.delete(url + '/api/sessions/' + id).catch(() => {});
    if (browser) await browser.close();
    chrome?.kill();
    fixture.close();
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  }
})();
