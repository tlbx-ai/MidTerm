import assert from 'node:assert/strict';
import path from 'node:path';

export async function exerciseGitTexts({page,dock,git,fixture,relative,out,result,api,session,url}) {
  const settings=await api('GET','/api/settings');
  const hash=git(['rev-parse','HEAD']).trim();
  const metadata=await api('GET','/api/git/commit?'+new URLSearchParams({sessionId:session,repoRoot:fixture,hash}));
  const open=async()=>{
    await page.goto(url);await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();await page.locator(`.session-wrapper[data-session-id="${session}"] .git-indicator`).click();await dock.locator('.git-dock-resize-grip').press('Home');
  };
  try {
    for(const language of ['en','de','long']) {
      if(language==='long') await page.route('**/locales/de.json*',async route=>{
        try {
        const response=await route.fetch(), locale=JSON.parse((await response.text()).replace(/^\uFEFF/,''));
        for(const key of Object.keys(locale)) if(key.startsWith('git.')) locale[key]='Ausführliche Übersetzung: '+locale[key]+' mit weiterführender Bezeichnung';
        await route.fulfill({response,json:locale});
        } catch(error) { result.errors.push('Translation response: '+String(error));await route.abort().catch(()=>{}); }
      });
      await api('PATCH','/api/settings',{language:language==='en'?'en':'de'});await open();
      if(await dock.locator(`.git-commit-entry[data-hash="${hash}"]`).count()===0)await dock.locator('[data-action="toggle-section"][data-section="commits"]').click();
      await dock.locator(`.git-commit-entry[data-hash="${hash}"]`).click();
      const details=dock.locator('.git-commit-metadata');await details.locator('summary').press('Enter');
      assert.equal(await details.locator('[data-git-full-subject]').innerText(),metadata.subject);
      assert.ok((await details.innerText()).includes(hash));for(const parent of metadata.parentHashes)assert.ok((await details.innerText()).includes(parent));
      assert.ok((await details.locator('dt').allTextContents()).includes(language==='en'?'Author':language==='de'?'Autor':'Ausführliche Übersetzung: Autor mit weiterführender Bezeichnung'));
      assert.equal(await dock.locator('.git-command-section').getAttribute('open'),null);
      await dock.locator('.git-command-section > summary').press('Enter');
      const copy=dock.locator('[data-action="copy-command"]').first();await copy.press('Enter');assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),await copy.getAttribute('data-command'));
      const inspector=dock.locator('.git-panel-inspector');assert.ok(await inspector.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
      await page.screenshot({path:path.join(out,`commit-details-${language}-250.png`),animations:'disabled'});
      await inspector.locator('[data-action="show-list"]').click();await dock.locator(`.git-tree-file[data-path="${relative}"]`).click();await dock.locator('.git-diff-lines').waitFor();
      assert.equal(await inspector.locator('.git-inspector-file-header').count(),0);
      assert.equal(await inspector.locator('.git-inspector-title').textContent(),path.basename(relative));
      assert.ok((await inspector.locator('.git-summary-pill').first().innerText()).includes(language==='en'?'Working tree':'Arbeitskopie'));
      await inspector.locator('.git-path-details').click();const pathDialog=page.locator('.file-operation-overlay');assert.ok((await pathDialog.innerText()).includes(path.join(fixture,relative)));await pathDialog.locator('[data-operation-choice="cancel"]').click();
      assert.ok(await inspector.evaluate(el=>el.scrollWidth<=el.clientWidth+1));await page.screenshot({path:path.join(out,`file-details-${language}-250.png`),animations:'disabled'});
      result.cases.push(`${language}: localized scope/metadata/commands, full Unicode subject/path/hash/parents reachable with keyboard in narrow controls, no duplicate file header`);
    }
    await page.unroute('**/locales/de.json*');await api('PATCH','/api/settings',{language:'en'});await open();
    await dock.locator('.git-commit-message').fill('Retained language draft ä');await dock.locator(`.git-tree-file[data-path="${relative}"]`).click();await dock.locator('.git-diff-lines').waitFor();
    await page.locator('#btn-settings').click();await page.locator('.settings-tab[data-tab="appearance"]').click();await page.locator('#setting-language').selectOption('de');await page.waitForFunction(()=>document.documentElement.lang==='de');
    await page.locator(`.session-item[data-session-id="${session}"] .session-title`).click();
    if(!await dock.isVisible())await page.locator(`.session-wrapper[data-session-id="${session}"] .git-indicator`).click();
    assert.equal(await dock.locator('.git-commit-message').inputValue(),'Retained language draft ä');
    await dock.locator('.git-diff-lines').waitFor();assert.ok((await dock.locator('.git-panel-inspector .git-summary-pill').first().innerText()).includes('Arbeitskopie'));
    result.cases.push('Actual Settings language change updates the open Git review and retains the draft and selected file');
  } finally { await page.unroute('**/locales/de.json*').catch(()=>{});await api('PATCH','/api/settings',{language:settings.language}); }
}
