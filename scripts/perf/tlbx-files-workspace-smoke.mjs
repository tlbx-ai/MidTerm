import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('../../docs/marketing/ScreenshotAutomation/node_modules/playwright');
const url=process.env.TLBX_PERF_URL, cookie=process.env.TLBX_COOKIE_HEADER;
if(!url||!cookie)throw Error('Authenticated source instance required');
const out=path.resolve(process.env.TLBX_PERF_ARTIFACT_ROOT||'.dev/files-design/workspace');
fs.mkdirSync(out,{recursive:true});
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tlbx-files-workspace-'));
const a=path.join(fixture,'A'), b=path.join(fixture,'B'), nested=path.join(a,'nested');
fs.mkdirSync(nested,{recursive:true});fs.mkdirSync(b);
const readme=path.join(fixture,'README.md');fs.writeFileSync(readme,'# Remote workspace\n\nA readable document.\n');
fs.writeFileSync(path.join(a,'source.ts'),'export const answer = 42;\n');
fs.writeFileSync(path.join(fixture,'long-source.ts'),Array.from({length:200},(_,i)=>`export const line_${i} = ${i};`).join('\n'));
for(let i=0;i<60;i++)fs.writeFileSync(path.join(fixture,`source-${String(i).padStart(2,'0')}.ts`),`export const value = ${i};\n`);
const result={ok:false,cases:[],errors:[],fixture};
let chrome,browser,context,page,session,savedSettings;
async function api(method,route,data){const r=await context.request.fetch(url+route,{method,data});assert.ok(r.ok(),`${route}: ${r.status()}`);const raw=await r.text();return raw?JSON.parse(raw):null;}
async function start(width,touch=false){
 context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width,height:900},hasTouch:touch,isMobile:touch});
 const eq=cookie.indexOf('=');await context.addCookies([{name:cookie.slice(0,eq),value:cookie.slice(eq+1),url}]);
 session=(await api('POST','/api/sessions',{shell:'Pwsh',cols:100,rows:30,workingDirectory:fixture,launchRequestId:crypto.randomUUID()})).id;
 page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>result.errors.push(e.message));
 await page.goto(url);
 const title=page.locator(`.session-item[data-session-id="${session}"] .session-title`);
 await title.waitFor({state:'attached'});
 if(touch&&!await title.isVisible())await page.locator('#btn-hamburger').click();
 await title.click();
 const wrapper=page.locator(`.session-wrapper[data-session-id="${session}"]`);
 if(touch){if(await page.locator('#btn-mobile-strip-files').isVisible())await page.locator('#btn-mobile-strip-files').tap();else{await page.locator('#btn-mobile-actions-menu').tap();await page.locator('#btn-mobile-tab-files').tap();}}
 else await wrapper.locator('[data-tab="files"]').click();
 await wrapper.locator('.tree-node').first().waitFor();
 return wrapper;
}
async function stop(){if(session)await api('DELETE','/api/sessions/'+session);session=null;await context?.close();context=null;}
try{
 const profile=path.join(out,'chrome-profile');fs.mkdirSync(profile,{recursive:true});
 chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--ignore-certificate-errors','--no-first-run','--no-default-browser-check'],{windowsHide:true,stdio:['ignore',fs.openSync(path.join(out,'chrome.stdout.log'),'w'),fs.openSync(path.join(out,'chrome.stderr.log'),'w')]});
 for(let i=0;i<100;i++){try{const port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);break;}catch{await new Promise(r=>setTimeout(r,100));}}
 let wrapper=await start(1440), root=wrapper.locator('.file-browser'), tree=root.locator('.file-browser-tree'), preview=root.locator('.file-browser-preview'), nav=root.locator('nav');
 const row=name=>tree.locator('.tree-node').filter({has:page.locator('.tree-name',{hasText:new RegExp('^'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')})});
 const waitPath=target=>page.waitForFunction(({id,target})=>{const n=document.querySelector(`.session-wrapper[data-session-id="${id}"] .file-browser-navigation`);return n?.getAttribute('aria-busy')==='false'&&n.querySelector('input').value===target;},{id:session,target});
 const go=async target=>{if(await nav.locator('.file-browser-edit-address').isVisible())await nav.locator('.file-browser-edit-address').click();await nav.locator('.file-browser-address-form input').fill(target);await nav.locator('.file-browser-address-form input').press('Enter');await waitPath(target);};
 savedSettings=await api('GET','/api/settings');
 await api('PATCH','/api/settings',{inputMode:'both',managerBarEnabled:true});
 await page.waitForFunction(()=>window.mmDebug.settings.inputMode==='both');
 await wrapper.locator('[data-tab="terminal"]').click();
 const composer=page.locator('.smart-input-docked .smart-input-textarea');
 await composer.fill('Preserved Command Bay draft');
 await wrapper.locator('[data-tab="files"]').click();assert.equal(await page.locator('#adaptive-footer-dock').isVisible(),false);
 await wrapper.locator('[data-tab="terminal"]').click();assert.equal(await composer.inputValue(),'Preserved Command Bay draft');
 await wrapper.locator('[data-tab="files"]').click();
 result.cases.push('Both input mode hides the entire terminal footer on Files and preserves its draft on Terminal return');
 assert.equal(await tree.locator('.file-listing-details').count(),1);
 assert.equal(await tree.locator('input[type="checkbox"]').count(),0);
 assert.equal(await page.locator('#adaptive-footer-dock').isVisible(),false);
 assert.ok((await nav.boundingBox()).height<60);
 result.cases.push('First use shows a dense details list, one location bar, no selection checkboxes or terminal footer');
 await row('README.md').click();assert.equal(await preview.isVisible(),false);
 assert.equal(await row('README.md').evaluate(e=>getComputedStyle(e).cursor),'default');
 await row('README.md').press('Enter');await preview.locator('.file-document-markdown').waitFor();
 await root.locator('.file-browser-back').click();assert.equal(await preview.isVisible(),false);
 assert.equal(await row('README.md').evaluate(e=>e===document.activeElement),true);
 result.cases.push('Single click selects, Enter opens, preview close returns focus to the selected file');
 await row('README.md').dblclick();await preview.locator('.file-document-markdown').waitFor();
 await preview.locator('.file-document-mode[data-mode="edit"]').click();
 const editor=preview.locator('textarea');await editor.fill('# Unsaved remote draft\n');
 await editor.evaluate(e=>e.setSelectionRange(7,13));await editor.press('Escape');
 assert.equal(await preview.isVisible(),false);await row('README.md').press('Enter');await editor.waitFor();
 assert.equal(await editor.inputValue(),'# Unsaved remote draft\n');
 assert.deepEqual(await editor.evaluate(e=>[e.selectionStart,e.selectionEnd]),[7,13]);
 result.cases.push('Escape hides the preview without discarding its draft or caret; reopening restores the same editor');
 await nav.locator('.file-browser-edit-address').click();await nav.locator('.file-browser-address-form input').fill(a);await nav.locator('.file-browser-address-form input').press('Enter');
 const dialog=page.locator('.file-unsaved-overlay');await dialog.waitFor();await dialog.locator('[data-file-decision="cancel"]').click();
 assert.equal(await editor.inputValue(),'# Unsaved remote draft\n');await waitPath(fixture);
 await nav.locator('.file-browser-address-form input').fill(a);await nav.locator('.file-browser-address-form input').press('Enter');await dialog.locator('[data-file-decision="save"]').click();await waitPath(a);
 assert.equal(fs.readFileSync(readme,'utf8'),'# Unsaved remote draft\n');
 result.cases.push('Address navigation still protects dirty files; Cancel retains the draft and Save writes only the fixture');
 await row('nested').click();assert.equal(await nav.locator('.file-browser-address-form input').inputValue(),a);
 await row('nested').dblclick();await waitPath(nested);
 await tree.locator('.tree-empty').waitFor();await page.screenshot({path:path.join(out,'empty-folder.png')});
 await nav.locator('[data-browser-navigation="up"]').click();await waitPath(a);
 await page.keyboard.press('Alt+ArrowLeft');await waitPath(nested);
 await page.keyboard.press('Alt+ArrowRight');await waitPath(a);
 await page.goBack();await waitPath(nested);
 result.cases.push('Folder double click, Up, Alt Back/Forward and browser Back use actual folder history');
 await page.keyboard.press('Control+l');await nav.locator('.file-browser-address-form input').waitFor();assert.equal(await nav.locator('.file-browser-address-form input').evaluate(e=>document.activeElement===e),true);
 await nav.locator('.file-browser-address-form input').fill('discard this address');await nav.locator('.file-browser-address-form input').press('Escape');
 assert.equal(await nav.locator('.file-browser-address-form input').inputValue(),nested);assert.equal(await nav.locator('.file-browser-address-form input').isVisible(),false);
 await go(fixture);await row('source-00.ts').click();await row('source-01.ts').click({modifiers:['Control']});
 assert.equal(await tree.locator('.tree-node[aria-selected="true"]').count(),2);
 result.cases.push('Editable full paths cancel predictably and Ctrl selection remains available without clutter');
 await row('source-00.ts').dblclick();await preview.locator('.file-document-view').waitFor();
 await preview.locator('.file-preview-actions-menu summary').click();await preview.locator('[data-path-details]').click();
 await page.locator('.file-operation-overlay').waitFor();assert.ok((await page.locator('.file-operation-overlay').innerText()).includes(path.join(fixture,'source-00.ts')));
 await page.locator('.file-operation-overlay [data-operation-choice="cancel"]').click();
 result.cases.push('Preview overflow exposes labeled actions and the full remote path');
 for(const width of [1912,1440,1024,900]){
  await page.setViewportSize({width,height:900});await page.waitForTimeout(100);
  const boxes=await root.evaluate(e=>{const t=e.querySelector('.file-browser-tree'),d=e.querySelector('.file-browser-detail');return {width:e.clientWidth,tree:t.getBoundingClientRect().width,detail:d.getBoundingClientRect().width,overflow:e.scrollWidth>e.clientWidth+1};});
  assert.equal(boxes.overflow,false);
  if(boxes.width>768){assert.ok(boxes.tree>=320);assert.ok(boxes.detail>=350);}
  await page.screenshot({path:path.join(out,`desktop-${width}.png`)});
 }
 result.cases.push('Full screenshots at four desktop widths retain usable list and preview space without document overflow');
 await root.locator('.file-browser-back').click();await row('long-source.ts').dblclick();
 await preview.locator('.file-document-view').waitFor();
 assert.ok((await preview.innerText()).includes('export const line_199 = 199;'));
 await page.screenshot({path:path.join(out,'long-source.png')});
 result.cases.push('Empty-folder and long-source screenshots expose complete workspace states, including navigation and headers');
 await page.setViewportSize({width:1440,height:900});await root.locator('.file-browser-back').click();
 await tree.locator('.file-listing-options summary').click();await tree.locator('.file-listing-views [data-mode="tree"]').click();await page.keyboard.press('Escape');
 await row('A').locator('.tree-expand').click();await row('source.ts').waitFor();
 result.cases.push('Tree mode remains a deliberate alternative with explicit disclosure controls');
 await stop();
 for(const width of [390,768]){
  wrapper=await start(width,true);root=wrapper.locator('.file-browser');tree=root.locator('.file-browser-tree');preview=root.locator('.file-browser-preview');
  const file=tree.locator('.tree-node').filter({has:page.locator('.tree-name',{hasText:/^source-00.ts$/})});
  await file.tap();await preview.locator('.file-document-view').waitFor();
  assert.equal(await tree.isVisible(),false);assert.equal(await preview.locator('.preview-toolbar-name').innerText(),'source-00.ts');
  const nameBox=await preview.locator('.preview-toolbar-name').boundingBox();assert.ok(nameBox.width>=90);
  assert.equal(await page.locator('#adaptive-footer-dock').isVisible(),false);
  assert.ok((await root.locator('.file-browser-back').boundingBox()).height>=44);
  await root.locator('.file-browser-back').tap();assert.equal(await tree.isVisible(),true);
  assert.equal(await file.getAttribute('aria-selected'),'true');
  await page.screenshot({path:path.join(out,`touch-${width}.png`)});
  result.cases.push(`Touch ${width}: one tap opens, filename and 44px Back remain usable, selection survives return`);
  await stop();
 }
 assert.deepEqual(result.errors,[]);result.ok=true;
}catch(e){result.failure=String(e.stack).replaceAll(cookie,'<redacted>');if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});process.exitCode=1;}
finally{
if(savedSettings){
 if(!context){context=await browser.newContext({ignoreHTTPSErrors:true});const eq=cookie.indexOf('=');await context.addCookies([{name:cookie.slice(0,eq),value:cookie.slice(eq+1),url}]);}
 await api('PATCH','/api/settings',{inputMode:savedSettings.inputMode,managerBarEnabled:savedSettings.managerBarEnabled}).catch(e=>{result.cleanup=String(e);result.ok=false;process.exitCode=1;});
}
if(context)await stop().catch(e=>{result.cleanup=String(e);});await browser?.close();chrome?.kill();fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
