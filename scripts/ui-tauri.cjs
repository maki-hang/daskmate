const { chromium } = require('playwright');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Store } = require('../src/core/store.cjs');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const day = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const port = () => new Promise(resolve => { const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));}); });
(async () => {
  const executable=process.env.DESKMATE_TEST_EXE || path.join(root,'src-tauri/target/debug/DeskMate.exe');
  const fixture=path.join(root,'src-tauri/target/debug/deskmate-protocol-fixture.exe');
  await fs.access(executable);await fs.access(fixture);
  await fs.mkdir(path.join(root,'.cache'),{recursive:true});
  const folder=await fs.mkdtemp(path.join(root,'.cache/tauri-ui-')),data=path.join(folder,'data'),repo=path.join(folder,'repo 中文'),output=path.join(root,'test-output/rust');
  await fs.mkdir(data);await fs.mkdir(repo);await fs.mkdir(output,{recursive:true});
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{windowsHide:true,encoding:'utf8'}).trim();
  git('init','-b','main');git('config','user.name','Local Author');git('config','user.email','local@example.invalid');git('commit','--allow-empty','-m','My local commit');git('commit','--allow-empty','--author','Teammate <other@example.invalid>','-m','Another author');
  const repoId=createHash('sha256').update(repo.toLowerCase()).digest('hex').slice(0,20);
  const legacy=JSON.stringify({version:1,agendaVersion:2,settings:{language:'zh-CN',agent:'codex',skins:{},codexPath:fixture},notes:[{id:'legacy',date:day(new Date()),time:'00:00:00',content:'Migrated legacy note 🐉'}],reminders:[],repositories:[{id:repoId,name:'repo 中文',path:repo,count:0}],skins:[]});
  await fs.writeFile(path.join(data,'assistant.json'),legacy);
  for(const agent of ['codex','claude'])await fs.writeFile(path.join(data,`release-${agent}.json`),JSON.stringify({agent,version:'999.0.0',body:'Fixture',url:`https://github.com/${agent==='codex'?'openai/codex':'anthropics/claude-code'}/releases/tag/v999.0.0`,checkedAt:Date.now()}));
  let child,browser,page,pet;const errors=[];let nativeOutput='';
  const launch=async()=>{
    const debugPort=await port();
    child=spawn(executable,[],{cwd:path.dirname(executable),env:{...process.env,DESKMATE_DATA_DIR:data,CLAUDE_CONFIG_DIR:path.join(folder,'claude'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${debugPort}`},windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',data=>nativeOutput+=data);child.stderr.on('data',data=>nativeOutput+=data);
    child.on('error',error=>errors.push(error.message));
    for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error(`DeskMate exited ${child.exitCode}: ${nativeOutput}`);try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`,{timeout:300});break;}catch{await sleep(200);}}
    if(!browser)throw new Error('No WebView2 debugging endpoint: '+nativeOutput);
    for(let i=0;i<100;i++){const pages=browser.contexts().flatMap(context=>context.pages());page=pages.find(page=>page.url().endsWith('/index.html')||/^https?:\/\/tauri\.localhost\/?$/.test(page.url()));pet=pages.find(page=>page.url().endsWith('/pet.html'));if(page&&pet)break;await sleep(100);}
    assert.ok(page&&pet,'both native windows are available: '+browser.contexts().flatMap(context=>context.pages()).map(page=>page.url()).join(', ')+' '+nativeOutput);
    for(const view of [page,pet])view.on('pageerror',error=>errors.push(error.message));
    await page.locator('#agent-select').waitFor();
  };
  const stop=async()=>{if(browser){await browser.close().catch(()=>{});browser=null;}if(child&&child.exitCode===null){child.kill();for(let i=0;i<50&&child.exitCode===null;i++)await sleep(50);}child=null;};
  try{
    await launch();
    assert.equal((await fs.readFile(path.join(data,'assistant.sqlite'))).subarray(0,16).toString(),'SQLite format 3\0');assert.equal(await fs.readFile(path.join(data,'assistant.json'),'utf8'),legacy);
    await page.waitForFunction(()=>document.getElementById('today-tokens')?.textContent.includes('123,456'));
    assert.equal(await page.locator('#reset-count').innerText(),'2');await pet.waitForFunction(()=>document.querySelector('progress')?.value===64);
    await page.screenshot({path:path.join(output,'usage-zh.png')});
    for(const locale of ['en','ja','zh-CN']){await page.locator('#language-select').selectOption(locale);await pet.waitForFunction(locale=>document.documentElement.lang===locale,locale);}
    await page.locator('nav [data-page=agenda]').click();await page.locator('.note-item').filter({hasText:'Migrated legacy note 🐉'}).waitFor();
    await page.locator('#note-content').fill('Draft persists 🐉');await page.locator('#note-second').fill('37');await page.locator('#language-select').selectOption('en');assert.equal(await page.locator('#note-content').inputValue(),'Draft persists 🐉');
    await page.locator('#note-form [type=submit]').click();await page.locator('.note-item').filter({hasText:'Draft persists 🐉'}).waitFor();
    const due=new Date(Date.now()-60000);await page.evaluate(value=>window.assistant.call('agenda.save',value),{date:day(due),time:[due.getHours(),due.getMinutes(),due.getSeconds()].map(v=>String(v).padStart(2,'0')).join(':'),content:'Rust background reminder',remind:true,repeat:'none'});
    await pet.waitForFunction(()=>document.getElementById('bubble').textContent.includes('Rust background reminder'));
    await page.locator('[data-snooze]').click();await page.locator('[data-toggle-reminder]').click();await page.getByText('◷ Paused',{exact:true}).waitFor();
    await page.screenshot({path:path.join(output,'agenda-en.png')});
    await page.locator('nav [data-page=git]').click();await page.getByText('My local commit',{exact:true}).waitFor();assert.equal(await page.locator('.commit').count(),1);await page.locator('#git-author').selectOption('all');await page.waitForFunction(()=>document.querySelectorAll('.commit').length===2);await page.locator('#git-search').fill('Another');await page.waitForFunction(()=>document.querySelectorAll('.commit').length===1);await page.screenshot({path:path.join(output,'git-en.png')});
    await page.locator('.settings-nav').click();assert.equal(await page.locator('.skin-card').count(),8);
    await page.locator('.skin-card').nth(3).click();await page.evaluate(()=>window.assistant.call('settings',{agent:'claude'}));await page.locator('.skin-card').nth(1).click();await page.evaluate(()=>window.assistant.call('settings',{agent:'codex'}));
    const decoded=await page.locator('.skin-card img').evaluateAll(images=>Promise.all(images.map(image=>image.decode().then(()=>true,()=>false))));assert.ok(decoded.every(Boolean),'all eight WebP skins decode through the scoped asset protocol');
    await page.locator('[name=pet-quota-display][value=hover]').check();await pet.waitForFunction(()=>document.body.dataset.quotaDisplay==='hover');
    // The native pointer worker follows the OS cursor, so CDP mouse coordinates
    // cannot reliably exercise hover while the user moves their real mouse.
    // Use the keyboard accessibility path for deterministic quota-card checks.
    await pet.evaluate(()=>document.activeElement.blur());
    await pet.evaluate(()=>document.getElementById('pet').focus());await pet.keyboard.press('Shift+Tab');await pet.keyboard.press('Tab');await pet.waitForFunction(()=>document.getElementById('status').getAttribute('aria-hidden')==='false');await pet.keyboard.press('Escape');await pet.waitForFunction(()=>document.getElementById('status').getAttribute('aria-hidden')==='true');
    await pet.evaluate(()=>document.getElementById('pet').focus());await pet.keyboard.press('Shift+Tab');await pet.keyboard.press('Tab');await pet.waitForFunction(()=>document.getElementById('status').getAttribute('aria-hidden')==='false');assert.equal(await pet.locator('#status').evaluate(el=>el.getBoundingClientRect().width),180);await pet.screenshot({path:path.join(output,'pet-quota.png'),omitBackground:true});await pet.keyboard.press('Escape');
    const denied=await page.evaluate(()=>window.assistant.call('pet.drag.start').then(()=>false,e=>e.message));assert.ok(denied,'panel cannot control pet-only native commands');
    const before=await page.evaluate(()=>window.assistant.call('state'));assert.equal(before.notes.length,3);assert.equal(before.settings.skins.codex,'star-cat');assert.equal(before.settings.skins.claude,'orange-scholar');
    await page.screenshot({path:path.join(output,'settings-en.png')});await stop();await launch();
    const after=await page.evaluate(()=>window.assistant.call('state'));assert.equal(after.notes.length,3);assert.equal(after.reminders.length,1);assert.deepEqual(after.settings.skins,before.settings.skins);assert.equal(after.settings.petQuotaDisplay,'hover');assert.equal(after.settings.language,'en');
    await stop();const verification=new Store(data);assert.equal(verification.state.notes.length,3);assert.equal(verification.database.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');verification.close();
    assert.deepEqual(errors,[]);console.log('PASS Rust/Tauri UI: legacy import, SQLite compatibility, Codex stdio, 8 WebP skins, three languages, notes and reminder state, SQL Git filtering, pet quota keyboard access, IPC scope, bindings and restart persistence.');console.log('Screenshots: '+output);
  }catch(error){if(page){console.error('UI state:',await page.locator('body').innerText().catch(()=>''));await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}throw error;}finally{await stop();}
})().catch(error=>{console.error(error);process.exitCode=1;});
