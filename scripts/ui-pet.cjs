const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {Store}=require('../src/core/store.cjs');
const {PET_BOUNDS}=require('../src/core/pet-drag.cjs');
const root=path.resolve(__dirname,'..');
(async()=>{
  const folder=await fs.mkdtemp(path.join(root,'.cache/pet-ui-')),data=path.join(folder,'data');
  const store=new Store(data);store.update(s=>{s.settings.language='zh-CN';s.settings.codexPath=path.join(folder,'missing-codex.exe');});
  for(const agent of ['codex','claude'])await fs.writeFile(path.join(data,`release-${agent}.json`),JSON.stringify({agent,version:'0.0.0',body:'Fixture',url:`https://github.com/${agent==='codex'?'openai/codex':'anthropics/claude-code'}/releases/tag/v0.0.0`,checkedAt:Date.now()}));
  const output=path.join(root,'test-output/v4.1');await fs.mkdir(output,{recursive:true});
  const env={...process.env,DESKMATE_DATA_DIR:data,CLAUDE_CONFIG_DIR:path.join(folder,'claude')};delete env.ELECTRON_RUN_AS_NODE;
  let app,page,pet;const errors=[];
  const launch=async()=>{
    app=await electron.launch({args:process.env.DESKMATE_TEST_EXE?[]:[root],executablePath:process.env.DESKMATE_TEST_EXE||undefined,env,timeout:30000});
    app.on('window',w=>w.on('pageerror',e=>errors.push(e.message)));
    for(let i=0;i<100;i++){page=app.windows().find(w=>w.url().endsWith('/index.html'));pet=app.windows().find(w=>w.url().endsWith('/pet.html'));if(page&&pet)break;await new Promise(r=>setTimeout(r,50));}
    await page.locator('.settings-nav').click();await page.locator('[name=pet-quota-display]').first().waitFor();
    await page.evaluate(()=>window.assistant.call('usage'));
    await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/pet.html'));const original=w.setIgnoreMouseEvents.bind(w);global.pointerIgnored=null;global.dragStarts=0;w.setIgnoreMouseEvents=(ignore,options)=>{global.pointerIgnored=ignore;if(!ignore&&options===undefined)global.dragStarts++;original(ignore,options);};});
  };
  const send=async data=>{await app.evaluate(({BrowserWindow},data)=>{for(const w of BrowserWindow.getAllWindows())w.webContents.send('assistant:usage',data);},data);};
  const fixture={agent:'codex',status:'ok',windows:[{minutes:10080,remainingPercent:82,usedPercent:18,resetsAt:'2027-01-01T00:00:00Z'},{minutes:300,remainingPercent:64,usedPercent:36,resetsAt:'2027-01-01T00:00:00Z'}],resetCredits:{availableCount:2,credits:[]},tokens:{today:123456}};
  const mode=async value=>{await page.locator(`[name=pet-quota-display][value=${value}]`).check();await pet.waitForFunction(value=>document.body.dataset.quotaDisplay===value,value);};
  const visible=async value=>pet.waitForFunction(value=>document.getElementById('status').getAttribute('aria-hidden')===String(!value),value);
  const screenshot=async name=>{await pet.screenshot({path:path.join(output,name+'.png'),omitBackground:true});};
  const pointerIgnored=async expected=>{for(let i=0;i<40;i++){if(await app.evaluate(()=>global.pointerIgnored)===expected)return;await new Promise(r=>setTimeout(r,25));}assert.equal(await app.evaluate(()=>global.pointerIgnored),expected,'native mouse handling follows the visible hit target');};
  try{
    await launch();await send(fixture);await pet.waitForFunction(()=>document.querySelector('progress')?.value===64);
    assert.equal(await page.locator('[name=pet-quota-display][value=always]').isChecked(),true,'existing settings default to always');
    await pet.locator('#pet').hover();await pointerIgnored(false);await pet.mouse.move(2,355);await pointerIgnored(true);await visible(true);
    const strip=await pet.locator('#status').boundingBox();assert.ok(strip.width===180&&strip.height<65,JSON.stringify(strip));
    assert.deepEqual(await pet.locator('progress').evaluateAll(nodes=>nodes.map(n=>n.value)),[64,82]);
    assert.doesNotMatch(await pet.locator('#status').innerText(),/重置卡/);
    await screenshot('always-zh');
    await mode('hover');await visible(false);await pet.waitForFunction(()=>getComputedStyle(document.getElementById('status')).visibility==='hidden');
    assert.equal(await pet.locator('#status').evaluate(el=>el.inert),true);
    await pet.mouse.move(80,310);await pointerIgnored(true);
    await screenshot('hover-hidden');
    await pet.locator('#pet').hover();await visible(true);
    await pet.waitForFunction(()=>Number(getComputedStyle(document.getElementById('status')).opacity)===1);
    await pointerIgnored(false);
    await screenshot('hover-zh');
    const hoverStrip=await pet.locator('#status').boundingBox();assert.deepEqual({width:hoverStrip.width,height:hoverStrip.height},{width:strip.width,height:strip.height},'both modes use the same compact strip');
    assert.equal(await pet.locator('.drag').count(),0,'separate drag handle removed');
    await pet.mouse.move(100,270,{steps:5});await new Promise(r=>setTimeout(r,250));await visible(true);
    await pointerIgnored(false);await pet.locator('#status').click();await page.locator('#agent-select').waitFor({timeout:5000});
    assert.equal(await page.locator('nav [data-page=usage]').getAttribute('class'),'active','card opens usage panel');
    await page.locator('.settings-nav').click();await pet.mouse.move(2,355);await visible(false);
    await pet.evaluate(()=>{document.activeElement.blur();document.getElementById('pet').focus();});await pet.keyboard.press('Shift+Tab');await pet.keyboard.press('Tab');await visible(true);
    await pet.keyboard.press('Escape');await visible(false);
    for(const locale of ['en','ja','zh-CN']){
      await page.locator('#settings-language').selectOption(locale);await pet.waitForFunction(locale=>document.documentElement.lang===locale,locale);
      await page.screenshot({path:path.join(output,`settings-${locale}.png`)});
      await pet.locator('#pet').hover();await visible(true);
      await pet.waitForFunction(()=>Number(getComputedStyle(document.getElementById('status')).opacity)===1);
      const card=await pet.locator('#status').boundingBox();assert.ok(card.y+card.height<=360,'hover card fits the native window');
      assert.equal(await pet.locator('#status').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
      await screenshot(`hover-${locale}`);await pet.mouse.move(2,355);await visible(false);
    }
    await mode('always');await send({...fixture,windows:[{minutes:300,remainingPercent:0},{minutes:10080,remainingPercent:100}],stale:true});
    await pet.waitForFunction(()=>document.querySelector('progress')?.value===0);
    assert.deepEqual(await pet.locator('progress').evaluateAll(nodes=>nodes.map(n=>n.value)),[0,100]);assert.equal(await pet.locator('.critical').count(),1);assert.equal(await pet.locator('#status.stale').count(),1);await screenshot('always-low-stale');
    await send({...fixture,windows:[],tokens:{today:null}});await pet.waitForFunction(()=>document.querySelectorAll('progress').length===0);assert.match(await pet.locator('#status').innerText(),/未取得额度数据/);
    await send({...fixture,status:'unavailable',windows:[]});await pet.waitForFunction(()=>document.getElementById('quota').textContent.includes('等待连接'));assert.equal(await pet.locator('progress').count(),0);
    await send({...fixture,windows:Array.from({length:7},(_,i)=>({minutes:i===0?300:10080,bucket:'long-bucket-'+i,remainingPercent:90-i}))});
    await pet.waitForFunction(()=>document.querySelectorAll('progress').length===7);
    assert.equal(await pet.locator('#quota').evaluate(el=>el.scrollHeight>el.clientHeight),true,'multiple windows remain scrollable');
    await mode('hover');await pet.locator('#pet').hover();await visible(true);assert.ok((await pet.locator('#status').boundingBox()).height<131);
    const invalid=await page.evaluate(()=>window.assistant.call('settings',{petQuotaDisplay:'invalid'}).then(()=>false,e=>e.message));assert.equal(invalid,'invalidQuotaDisplay');
    const denied=await page.evaluate(()=>window.assistant.call('pet.pointer',{interactive:false}).then(()=>false,e=>e.message));assert.ok(denied,'panel cannot change native pet mouse handling');
    await pet.mouse.move(2,355);await visible(false);
    await page.evaluate(()=>window.assistant.call('settings',{agent:'claude'}));await page.evaluate(()=>window.assistant.call('usage'));
    await send({...fixture,agent:'claude'});await pet.waitForFunction(()=>document.getElementById('agent').textContent==='Claude Code');await pet.locator('#pet').hover();await visible(true);await screenshot('hover-claude');
    await page.evaluate(()=>window.assistant.call('settings',{agent:'codex'}));await page.evaluate(()=>window.assistant.call('usage'));await send(fixture);
    // Use Electron screen DIP coordinates to test native movement without moving the user's cursor.
    await app.evaluate(({BrowserWindow,screen})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/pet.html')),area=screen.getPrimaryDisplay().workArea;w.setPosition(area.x+100,area.y+100);global.realCursor=screen.getCursorScreenPoint;global.dragCursor={x:area.x+200,y:area.y+200};screen.getCursorScreenPoint=()=>({...global.dragCursor});BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).hide();});
    const position=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/pet.html')).getPosition());
    const panelVisible=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).isVisible());
    const startPosition=await position();
    await pet.locator('#pet').hover();await pet.mouse.down();await new Promise(r=>setTimeout(r,120));
    assert.equal(await pet.locator('body').evaluate(el=>el.classList.contains('dragging')),false,'short hold must not start a drag');
    assert.deepEqual(await position(),startPosition);
    await pet.waitForFunction(()=>document.body.classList.contains('dragging'));
    for(let i=0;i<40&&(await app.evaluate(()=>global.dragStarts))===0;i++)await new Promise(r=>setTimeout(r,25));
    assert.ok(await app.evaluate(()=>global.dragStarts)>0,'native drag starts after long press');
    await app.evaluate(()=>{global.dragCursor.x+=48;global.dragCursor.y+=32;});
    for(let i=0;i<40&&(await position())[0]===startPosition[0];i++)await new Promise(r=>setTimeout(r,25));
    let dropped=[startPosition[0]+48,startPosition[1]+32];assert.deepEqual(await position(),dropped);
    await pet.mouse.up();await pet.waitForFunction(()=>!document.body.classList.contains('dragging'));
    await new Promise(r=>setTimeout(r,100));assert.equal(await panelVisible(),false,'drag release must not open the panel');
    await app.evaluate(()=>{global.dragCursor.x+=30;});await new Promise(r=>setTimeout(r,80));assert.deepEqual(await position(),dropped,'release stops tracking the mouse');
    const savedPosition=await pet.evaluate(()=>window.assistant.call('state').then(s=>s.settings.position));assert.deepEqual(savedPosition,{x:dropped[0],y:dropped[1]});
    await pet.locator('#pet').click();assert.equal(await panelVisible(),true,'ordinary left click still opens panel after dragging');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).hide());
    await pet.locator('#pet').hover();await pet.mouse.down();await pet.waitForFunction(()=>document.body.classList.contains('dragging'));await pet.mouse.up();await new Promise(r=>setTimeout(r,100));assert.equal(await panelVisible(),false,'long press without movement does not act as a click');
    await pet.locator('#pet').hover();await pet.mouse.down();await pet.waitForFunction(()=>document.body.classList.contains('dragging'));await pet.keyboard.press('Escape');await pet.mouse.up();assert.equal(await pet.locator('body.dragging').count(),0);assert.equal(await panelVisible(),false,'cancelled drag does not open panel');
    await pet.locator('#pet').click({button:'right'});assert.equal(await pet.locator('body.dragging').count(),0);await pet.keyboard.press('Escape');
    const deniedDrag=await page.evaluate(()=>window.assistant.call('pet.drag.start').then(()=>false,e=>e.message));assert.ok(deniedDrag,'panel cannot start native dragging');
    const petRect=await pet.locator('#pet').boundingBox();
    assert.deepEqual(petRect,PET_BOUNDS,'native drag limits match the rendered pet rectangle');
    const area=await app.evaluate(({screen})=>screen.getPrimaryDisplay().workArea);
    const edgePositions=[
      [area.x-PET_BOUNDS.x,area.y-PET_BOUNDS.y],
      [area.x+area.width-PET_BOUNDS.x-PET_BOUNDS.width,area.y-PET_BOUNDS.y],
      [area.x+area.width-PET_BOUNDS.x-PET_BOUNDS.width,area.y+area.height-PET_BOUNDS.y-PET_BOUNDS.height],
      [area.x-PET_BOUNDS.x,area.y+area.height-PET_BOUNDS.y-PET_BOUNDS.height]
    ];
    // Keep the simulated pointer on this display, while requesting positions beyond each corner.
    for(const [x,y] of edgePositions){
      await app.evaluate(({BrowserWindow,screen},{x,y,area})=>{
        const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/pet.html'));
        const corner={x:x<area.x?area.x:area.x+area.width-1,y:y<area.y?area.y:area.y+area.height-1};
        global.dragCursor={x:area.x+Math.floor(area.width/2),y:area.y+Math.floor(area.height/2)};
        w.setPosition(x-(corner.x-global.dragCursor.x)+(x<area.x?-50:50),y-(corner.y-global.dragCursor.y)+(y<area.y?-50:50));
      },{x,y,area});
      await pet.evaluate(()=>window.assistant.call('pet.drag.start'));
      await app.evaluate((_,{x,y,area})=>{global.dragCursor={x:x<area.x?area.x:area.x+area.width-1,y:y<area.y?area.y:area.y+area.height-1};},{x,y,area});
      for(let i=0;i<40&&JSON.stringify(await position())!==JSON.stringify([x,y]);i++)await new Promise(r=>setTimeout(r,25));
      await pet.evaluate(()=>window.assistant.call('pet.drag.end'));
      assert.deepEqual(await position(),[x,y],'pet reaches each desktop corner without crossing its bounds');
      dropped=[x,y];
    }
    await app.evaluate(({screen})=>{screen.getCursorScreenPoint=global.realCursor;});
    await app.close();await launch();assert.equal(await page.locator('[name=pet-quota-display][value=hover]').isChecked(),true,'hover preference persists after restart');assert.deepEqual(await position(),dropped,'dragged position persists after restart');await pet.mouse.move(2,355);await visible(false);
    assert.deepEqual(errors,[]);
    console.log('PASS pet quota UI: unified 180px strip; short click; long-press drag/release/cancel; all four desktop edges and edge position persistence; hover reveal/bridge/dismiss/click; keyboard; pointer passthrough requests; three languages; 0/100/unknown/stale/multiple windows; agent switching; validated settings.');
  }finally{if(app)await app.close().catch(()=>{});}
})().catch(e=>{console.error(e);process.exitCode=1;});
