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
const out = path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT || '.dev/file-git-production/git-workspace'); fs.mkdirSync(out, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbx-git-workspace-ui-'));
const git = args => execFileSync('git', ['-C', fixture, ...args], { windowsHide: true, stdio: 'pipe' }).toString('utf8').trimEnd();
const write = text => fs.writeFileSync(path.join(fixture, 'file.txt'), text);
write('base\n'); fs.writeFileSync(path.join(fixture, '.gitignore'), '.tlbx/\n'); git(['init', '-q', '-b', 'main']); git(['config','user.name','Workspace UI acceptance']); git(['config','user.email','workspace@tlbx.invalid']); git(['config','commit.gpgSign','false']); git(['config','core.autocrlf','false']); git(['add','.']); git(['commit','-qm','base']);
const result = { ok: false, fixture, cases: [], operations: [], errors: [], inputFrames: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); let chrome, browser, context, page, session;
async function api(method, route, data) { const response = await context.request.fetch(url + route, { method, data }); assert.ok(response.ok(), `${route}: ${response.status()}`); const text = await response.text(); return text ? JSON.parse(text.replace(/^\uFEFF/, '')) : null; }
try {
  const profile = path.join(out, 'chrome-profile'); fs.mkdirSync(profile, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--ignore-certificate-errors','--no-first-run','--no-default-browser-check'], { windowsHide: true, stdio: ['ignore',fs.openSync(path.join(out,'chrome.stdout.log'),'w'),fs.openSync(path.join(out,'chrome.stderr.log'),'w')] });
  for (let i=0;i<100;i++) { try { browser=await chromium.connectOverCDP('http://127.0.0.1:'+Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split(/\r?\n/)[0])); break; } catch { await sleep(100); } }
  assert.ok(browser); context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}}); const eq=cookie.indexOf('='); await context.addCookies([{name:cookie.slice(0,eq),value:cookie.slice(eq+1),url}]);
  session=(await api('POST','/api/sessions',{shell:'Pwsh',workingDirectory:fixture,launchRequestId:crypto.randomUUID()})).id;
  page=await context.newPage(); page.setDefaultTimeout(25000); page.on('pageerror',error=>result.errors.push(error.message));
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/git/operations')result.operations.push(request.postDataJSON());});
  page.on('websocket',socket=>socket.on('framesent',frame=>{if(Buffer.isBuffer(frame.payload)&&frame.payload[0]===0x14)result.inputFrames++;}));
  await page.goto(url); await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click(); await page.locator(`.session-wrapper[data-session-id="${session}"] .git-indicator`).click();
  const dock=page.locator('#git-dock'), dialog=page.locator('.git-workspace-dialog'); await dock.locator('.git-dock-resize-grip').press('End');
  const refresh=async()=>{await api('POST','/api/git/repos/refresh',{sessionId:session,repoRoot:fixture}); await page.waitForFunction(()=>!document.querySelector('#git-dock [data-action="stage-all"]')?.disabled);};
  const open=async()=>{await dock.locator('[data-action="git-workspace"]').click();await dialog.locator('.git-workspace-section').first().waitFor();};
  const close=async()=>{await dialog.locator('[data-close]').click();await dialog.waitFor({state:'detached'});};
  const action=async(name, options={})=>{
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/git/operations'&&r.request().postDataJSON()?.action===name);
    await dialog.locator(`[data-workspace-action="${name}"]${options.resolution?`[data-resolution="${options.resolution}"]`:''}`).click();
    if(options.confirm) await dialog.locator('[data-confirm="true"]').click();
    const body=await(await response).json();
    if(name==='resolve-conflict'&&body.state==='completed')await dialog.waitFor({state:'detached'});
    else await page.waitForFunction(()=>{const feedback=document.querySelector('.git-workspace-feedback');return feedback?.textContent&&!/in progress|läuft/.test(feedback.textContent);});
    return body;
  };
  await open(); await dialog.locator('details:has([name="newBranch"]) summary').click(); await dialog.locator('[name="newBranch"]').fill('feature/ä'); assert.equal((await action('branch-create')).state,'completed'); assert.equal(git(['branch','--show-current']),'feature/ä');
  await dialog.locator('[name="branch"]').selectOption('main'); assert.equal((await action('branch-switch')).state,'completed'); await page.screenshot({path:path.join(out,'workspace-desktop.png'),animations:'disabled'}); await close();
  result.cases.push('Visible branch menu creates and switches real Unicode branches without a terminal command');
  write('stashed bytes\n'); await refresh(); await open(); await dialog.locator('details:has([name="stashMessage"]) summary').click();await dialog.locator('[name="stashMessage"]').fill('UI stash ä');assert.equal((await action('stash-create')).state,'completed');assert.equal(fs.readFileSync(path.join(fixture,'file.txt'),'utf8'),'base\n');assert.equal((await action('stash-apply')).state,'completed');assert.equal(fs.readFileSync(path.join(fixture,'file.txt'),'utf8'),'stashed bytes\n');
  await dialog.locator('[data-workspace-action="stash-drop"]').click();await dialog.locator('[data-confirm="false"]').click();assert.ok(git(['stash','list']).includes('UI stash'));assert.equal((await action('stash-drop',{confirm:true})).state,'completed');assert.equal(git(['stash','list']),'');await close();git(['restore','file.txt']);
  result.cases.push('Stash save/apply preserve disk bytes; deletion requires a working explicit confirmation and cancel preserves it');
  const bare=path.join(fixture,'remote.git');fs.mkdirSync(bare);execFileSync('git',['-C',bare,'init','--bare','-q'],{windowsHide:true,stdio:'pipe'});git(['remote','add','origin',bare]);fs.appendFileSync(path.join(fixture,'.gitignore'),'remote.git/\n');git(['add','.gitignore']);git(['commit','-qm','ignore remote fixture']);await refresh();await open();await dialog.locator('[name="remote"]').selectOption('origin');assert.equal((await action('push')).state,'completed');await dialog.locator('[name="remote"]').selectOption('origin');assert.equal((await action('fetch')).state,'completed');await dialog.locator('[name="remote"]').selectOption('origin');assert.equal((await action('pull')).state,'completed');await close();
  result.cases.push('Visible explicit remote and target-branch controls perform real push/fetch/fast-forward pull against an isolated bare repository');
  git(['switch','-qc','incoming']);write('incoming\n');git(['commit','-qam','incoming']);git(['switch','main']);write('ours\n');git(['commit','-qam','ours']);await refresh();await open();await dialog.locator('details:has([name="mergeBranch"]) summary').click();await dialog.locator('[name="mergeBranch"]').selectOption('refs/heads/incoming');assert.equal((await action('merge')).state,'conflicted');assert.ok(await dialog.locator('.git-workspace-feedback').innerText());await close();
  await dock.locator('[data-action="resolve-conflict"][data-path="file.txt"]').click();await dialog.locator('.git-conflict-versions').waitFor();assert.ok((await dialog.innerText()).includes('incoming'));await page.screenshot({path:path.join(out,'conflict-review.png'),animations:'disabled'});assert.equal((await action('resolve-conflict',{resolution:'theirs'})).state,'completed');assert.equal(fs.readFileSync(path.join(fixture,'file.txt'),'utf8'),'incoming\n');await open();await dialog.locator('[name="mergeMessage"]').fill('UI resolved merge');assert.equal((await action('commit')).state,'completed');assert.equal(git(['rev-list','--parents','-n','1','HEAD']).split(' ').length,3);await close();
  result.cases.push('Merge exposes real conflicts; incoming preview/accept stages actual bytes and Finish merge creates both native parents');
  await page.setViewportSize({width:390,height:844});await open();await page.screenshot({path:path.join(out,'workspace-narrow.png'),animations:'disabled'});assert.ok(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1));await dialog.locator('[name="branch"]').focus();await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.equal(await dock.locator('[data-action="git-workspace"]').evaluate(element=>element===document.activeElement),true);
  result.cases.push('390px repository dialog fits without horizontal overflow; Escape closes it and restores the triggering branch control');
  assert.equal(result.inputFrames,0);assert.deepEqual(result.errors,[]);result.ok=true;
} catch(error) { result.failure=String(error.stack||error).replaceAll(cookie,'<redacted-cookie>');await page?.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});process.exitCode=1; }
finally { if(context&&session)await api('DELETE','/api/sessions/'+session).catch(error=>{result.cleanupFailure=String(error);result.ok=false;process.exitCode=1;});await context?.close();await browser?.close();chrome?.kill();fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({ok:result.ok,cases:result.cases,failure:result.failure,summary:path.join(out,'summary.json')})); }
