import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { request } = require('../../docs/marketing/ScreenshotAutomation/node_modules/playwright');
const url = process.env.TLBX_PERF_URL, cookie = process.env.TLBX_COOKIE_HEADER;
if (!url || !cookie) throw new Error('Source authentication required');
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/operations-api');
fs.mkdirSync(out, { recursive: true });
const fixtureRoot = path.resolve('.dev/file-git-production/operation-fixtures'); fs.mkdirSync(fixtureRoot, { recursive: true });
const fixture = fs.mkdtempSync(path.join(fixtureRoot, 'owned-'));
const result = { ok: false, fixture, cases: [] };
let context, session;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(method, route, data) {
  const response = await context.fetch(route, { method, data });
  assert.ok(response.ok(), `${route}: ${response.status()} ${await response.text()}`);
  const raw = await response.text(); return raw ? JSON.parse(raw) : null;
}
const operation = (action, paths = [], extra = {}) => ({ requestId: crypto.randomUUID(), action, paths, ...extra });
try {
  context = await request.newContext({ baseURL: url, ignoreHTTPSErrors: true, extraHTTPHeaders: { Cookie: cookie } });
  let ready = false;
  for (let i = 0; i < 90; i++) {
    try { ready = (await context.get('/api/version', { timeout: 2000 })).ok(); } catch {}
    if (ready) break; await sleep(1000);
  }
  assert.ok(ready, 'Source did not become ready');
  session = (await api('POST', '/api/sessions', { shell: 'Pwsh', cols: 90, rows: 30, workingDirectory: fixture, launchRequestId: crypto.randomUUID() })).id;
  const endpoint = '/api/files/operations?sessionId=' + session;
  const run = async body => api('POST', endpoint, body);
  let body = operation('createFile', [], { destinationDirectory: fixture, name: 'Ünicode 🎸.txt' });
  let item = (await run(body)).items[0]; assert.ok(item.success); assert.ok(fs.existsSync(item.path)); assert.equal(fs.statSync(item.path).size, 0);
  const original = item.path; fs.writeFileSync(original, 'Actual UTF-8 🎸\r\n');
  const replay = await run(body); assert.equal(replay.items[0].path, original); assert.equal(fs.readFileSync(original, 'utf8'), 'Actual UTF-8 🎸\r\n');
  result.cases.push('Real Unicode empty-file creation and replay do not overwrite subsequent user edits');
  body = operation('createFolder', [], { destinationDirectory: fixture, name: 'destination' });
  item = (await run(body)).items[0]; assert.ok(item.success); const destination = item.path; assert.ok(fs.statSync(destination).isDirectory());
  result.cases.push('New folder creates an actual directory');
  item = (await run(operation('duplicate', [original]))).items[0]; assert.ok(item.success); assert.equal(fs.readFileSync(item.path, 'utf8'), fs.readFileSync(original, 'utf8'));
  const duplicate = item.path;
  item = (await run(operation('rename', [duplicate], { name: 'renamed.txt' }))).items[0]; assert.ok(item.success); assert.ok(!fs.existsSync(duplicate));
  const renamed = item.path;
  item = (await run(operation('move', [renamed], { destinationDirectory: destination }))).items[0]; assert.ok(item.success); assert.ok(!fs.existsSync(renamed));
  assert.equal(fs.readFileSync(item.path, 'utf8'), 'Actual UTF-8 🎸\r\n');
  result.cases.push('Duplicate, rename and move change the real filesystem and retain bytes');
  body = operation('copy', [original], { destinationDirectory: destination });
  item = (await run(body)).items[0]; assert.ok(item.success); const copied = item.path;
  const collision = await run(operation('copy', [original], { destinationDirectory: destination }));
  assert.equal(collision.items[0].success, false); assert.equal(collision.items[0].code, 'name_conflict');
  const both = await run(operation('copy', [original], { destinationDirectory: destination, conflict: 'keepBoth' }));
  assert.ok(both.items[0].success); assert.notEqual(both.items[0].path, copied);
  result.cases.push('Copy collisions preserve the existing file; Keep both publishes a distinct complete copy');
  fs.writeFileSync(copied, 'Previous destination');
  item = (await run(operation('copy', [original], { destinationDirectory: destination, conflict: 'replace' }))).items[0]; assert.ok(item.success); assert.ok(item.recoveryId);
  assert.equal(fs.readFileSync(copied, 'utf8'), 'Actual UTF-8 🎸\r\n');
  const old = await api('POST', '/api/files/restore?sessionId=' + session, { recoveryId: item.recoveryId, conflict: 'keepBoth' });
  assert.equal(fs.readFileSync(old.path, 'utf8'), 'Previous destination');
  result.cases.push('Explicit replacement retains the old destination in recoverable storage');
  body = operation('delete', [original]); item = (await run(body)).items[0]; assert.ok(item.success); assert.ok(!fs.existsSync(original));
  const receipt = await api('GET', '/api/files/operations/' + body.requestId + '?sessionId=' + session); assert.equal(receipt.complete, true); assert.equal(receipt.items[0].recoveryId, item.recoveryId);
  const recovery = await api('GET', '/api/files/recovery?' + new URLSearchParams({ sessionId: session, directory: fixture }));
  assert.ok(recovery.entries.some(entry => entry.id === item.recoveryId));
  const restored = await api('POST', '/api/files/restore?sessionId=' + session, { recoveryId: item.recoveryId });
  assert.ok(restored.success); assert.equal(fs.readFileSync(original, 'utf8'), 'Actual UTF-8 🎸\r\n');
  result.cases.push('Delete, status receipt, recovery listing and Undo operate on actual disk bytes');
  const missingSession = await context.post('/api/files/operations', { data: operation('delete', [original]) }); assert.equal(missingSession.status(), 400);
  const invalidName = await context.post(endpoint, { data: operation('rename', [original], { name: '../escape' }) }); assert.equal(invalidName.status(), 400);
  const rootDelete = await context.post(endpoint, { data: operation('delete', [fixture]) }); assert.equal(rootDelete.status(), 403); assert.ok(fs.existsSync(original));
  result.cases.push('Missing session, traversal names and deletion of the session root are rejected before changing data');
  result.ok = true;
} catch (error) { result.failure = String(error.stack || error).replaceAll(cookie, '<redacted-session-cookie>'); process.exitCode = 1; }
finally {
  if (context && session) await api('DELETE', '/api/sessions/' + session).catch(error => { result.cleanupFailure = String(error).replaceAll(cookie, '<redacted-session-cookie>'); result.ok = false; process.exitCode = 1; });
  await context?.dispose(); fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, cases: result.cases.length, failure: result.failure, summary: path.join(out, 'summary.json') }));
}
