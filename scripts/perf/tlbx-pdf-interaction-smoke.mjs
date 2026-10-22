// Real-input acceptance for PDF selection, clipboard, hand-pan and Ctrl+wheel.
// Run with TLBX_PERF_URL and a private TLBX_COOKIE_HEADER against a test instance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('../../docs/marketing/ScreenshotAutomation/node_modules/playwright');
const url = process.env.TLBX_PERF_URL;
const cookie = process.env.TLBX_COOKIE_HEADER;
if (!url || !cookie) throw new Error('Authenticated test URL and cookie required');
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/pdf-interactions');
fs.mkdirSync(out, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-pdf-interactions-'));
// A standalone three-page PDF fixture without a Python/PDF generation dependency.
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>',
];
for (let i = 0; i < 3; i++) {
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
  const stream = `BT /F1 18 Tf 50 700 Td (Selectable text for the PDF viewer) Tj 0 -35 Td (Page ${i + 1}: mouse and keyboard acceptance) Tj ET`;
  objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
}
objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
let pdf = '%PDF-1.4\n';
const offsets = [0];
for (const [i, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
}
const startXref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
const file = path.join(fixture, 'interaction.pdf');
fs.writeFileSync(file, pdf);
const browser = await chromium.launch({
  executablePath: process.env.TLBX_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
const separator = cookie.indexOf('=');
await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url }]);
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const cases = [];
let session;
async function api(method, route, data) {
  const response = await context.request.fetch(url + route, { method, data });
  assert.ok(response.ok(), `${method} ${route}: ${response.status()}`);
  return response.status() === 204 ? null : response.json();
}
try {
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 90, rows: 30, workingDirectory: fixture, launchRequestId: crypto.randomUUID() })).id;
  await page.goto(url);
  await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();
  const wrapper = page.locator(`.session-wrapper[data-session-id="${session}"]`);
  await wrapper.locator('.session-tab[data-tab="files"]').click();
  await wrapper.locator('.tree-node[data-name="interaction.pdf"]').dblclick();
  const frame = page.frameLocator('iframe.preview-pdf');
  const text = frame.locator('.textLayer span').filter({ hasText: 'Selectable text for the PDF viewer' }).first();
  await text.waitFor();
  const content = page.frames().find(f => f.url().includes('/pdf/index.html'));
  assert.ok(content);
  await frame.locator('#selectText').click();
  const box = await text.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 16 });
  await page.mouse.up();
  const selection = await content.evaluate(() => getSelection().toString());
  assert.ok(selection.includes('text for the PDF'), `Actual drag selection: ${selection}`);
  await page.screenshot({ path: path.join(out, 'selected-text.png') });
  await frame.locator('#copyText').click();
  await page.waitForFunction(async expected => await navigator.clipboard.readText() === expected, selection);
  cases.push('Real mouse drag selects PDF text and Copy writes the exact text');
  // Native Ctrl+C remains available; selection and iframe focus come from user input.
  await text.click({ clickCount: 3 });
  const keyboardSelection = await content.evaluate(() => getSelection().toString());
  assert.ok(keyboardSelection.length > 5);
  await page.keyboard.press('Control+c');
  await page.waitForFunction(async expected => await navigator.clipboard.readText() === expected, keyboardSelection);
  cases.push('Native Ctrl+C copies selected PDF text');
  const browserBefore = await page.evaluate(() => ({ dpr: devicePixelRatio, width: innerWidth, scale: visualViewport.scale }));
  const firstPage = frame.locator('.page').first();
  const pageBefore = await firstPage.boundingBox();
  const widthBefore = pageBefore.width;
  const originX = box.x + box.width / 2;
  const originY = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await firstPage.evaluate(el => new Promise(resolve => requestAnimationFrame(() => resolve(el.getBoundingClientRect().width))));
  const widthAfter = await firstPage.evaluate(el => el.getBoundingClientRect().width);
  assert.ok(widthAfter > widthBefore * 1.1, `${widthBefore} -> ${widthAfter}`);
  assert.deepEqual(await page.evaluate(() => ({ dpr: devicePixelRatio, width: innerWidth, scale: visualViewport.scale })), browserBefore);
  const pageAfter = await firstPage.boundingBox();
  assert.ok(Math.abs((originX - pageBefore.x) / pageBefore.width - (originX - pageAfter.x) / pageAfter.width) < 0.02);
  assert.ok(Math.abs((originY - pageBefore.y) / pageBefore.height - (originY - pageAfter.y) / pageAfter.height) < 0.02);
  cases.push('Trusted Ctrl+wheel zooms around the pointer while browser zoom and viewport remain unchanged');
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 120);
  await page.keyboard.up('Control');
  await page.waitForTimeout(150);
  assert.ok(await firstPage.evaluate(el => el.getBoundingClientRect().width) < widthAfter);
  cases.push('Ctrl+wheel zooms out as well');
  await frame.locator('#zoom').selectOption('3');
  for (let i = 0; i < 3; i++) await frame.locator('#zoomIn').click();
  const limitWidth = await firstPage.evaluate(el => el.getBoundingClientRect().width);
  const zoomButton = await frame.locator('#zoomIn').boundingBox();
  await page.mouse.move(zoomButton.x + zoomButton.width / 2, zoomButton.y + zoomButton.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await page.waitForTimeout(150);
  assert.equal(await firstPage.evaluate(el => el.getBoundingClientRect().width), limitWidth);
  assert.deepEqual(await page.evaluate(() => ({ dpr: devicePixelRatio, width: innerWidth, scale: visualViewport.scale })), browserBefore);
  cases.push('Ctrl+wheel over the toolbar still suppresses browser zoom at the PDF zoom limit');
  await frame.locator('#zoom').selectOption('2');
  await frame.locator('#handTool').click();
  const area = await frame.locator('#viewerContainer').boundingBox();
  assert.ok(area);
  const start = await content.evaluate(() => ({ left: document.getElementById('viewerContainer').scrollLeft, top: document.getElementById('viewerContainer').scrollTop }));
  await page.mouse.move(area.x + area.width * 0.65, area.y + area.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * 0.65 - 120, area.y + area.height * 0.6 - 100, { steps: 12 });
  await page.mouse.up();
  const end = await content.evaluate(() => ({ left: document.getElementById('viewerContainer').scrollLeft, top: document.getElementById('viewerContainer').scrollTop }));
  assert.ok(end.top > start.top + 80 && end.left > start.left + 100, JSON.stringify({ start, end }));
  assert.equal(await content.evaluate(() => getSelection().toString()), '');
  cases.push('Hand tool pans in both axes without selecting text');
  await frame.locator('#selectText').click();
  assert.equal(await frame.locator('#selectText').getAttribute('aria-pressed'), 'true');
  const topBefore = end.top;
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(150);
  assert.ok(await content.evaluate(() => document.getElementById('viewerContainer').scrollTop) > topBefore);
  cases.push('Plain wheel scrolls normally and text mode can be restored');
  await page.screenshot({ path: path.join(out, 'tools.png') });
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ ok: true, cases, errors }, null, 2));
  console.log(JSON.stringify({ ok: true, cases }));
} catch (error) {
  await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ ok: false, cases, errors, error: String(error) }, null, 2));
  throw error;
} finally {
  if (session) await api('DELETE', '/api/sessions/' + session).catch(() => {});
  await browser.close();
  // Keep the self-contained PDF fixture alongside the evidence for diagnosis.
  fs.copyFileSync(file, path.join(out, 'interaction.pdf'));
  if (path.dirname(path.resolve(fixture)) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('tlbx-pdf-interactions-')) throw new Error('Refusing fixture cleanup outside the owned temp directory');
  fs.rmSync(fixture, { recursive: true, force: true });
}
