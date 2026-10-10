const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {Store,saveAgenda}=require('../src/core/store.cjs');
const {collectDue}=require('../src/core/reminders.cjs');
const {GitIndex}=require('../src/core/git.cjs');
const {tokensFrom,resetCreditsFrom,windowsFrom}=require('../src/core/usage.cjs');
const {UpdateService,newer,translatedUrl}=require('../src/core/updates.cjs');
const {messages,locales}=require('../src/renderer/i18n.js');
const {promisify}=require('node:util'),exec=promisify(require('node:child_process').execFile);
const temp=()=>fs.mkdtemp(path.join(os.tmpdir(),'deskmate-v2-'));
test('legacy notes and reminders migrate once without losing pause, recurrence or unread state',async()=>{
 const dir=await temp();const legacy={version:1,settings:{agent:'codex'},notes:[{id:'old-note',date:'2026-10-10',content:'legacy',updatedAt:'2026-10-10'}],reminders:[{id:'old-reminder',title:'keep me',dueAt:'2026-10-10T12:34:56+08:00',repeat:'weekly',enabled:false,unread:true,lastFiredAt:'2026-10-01T00:00:00Z'}],repositories:[],skins:[]};
 await fs.writeFile(path.join(dir,'assistant.json'),JSON.stringify(legacy));const store=new Store(dir);assert.equal(store.state.notes.length,2);assert.equal(store.state.notes[0].time,'00:00:00');const r=store.state.reminders[0];assert.equal(r.enabled,false);assert.equal(r.unread,true);assert.equal(r.repeat,'weekly');assert.equal(store.state.notes.find(n=>n.id===r.noteId).content,'keep me');assert.ok(store.state.notes[1].time.endsWith(':56'));assert.equal(new Store(dir).state.notes.length,2);
});
test('one note owns a seconds-precision reminder; content edits preserve completion; disabling removes reminder',async()=>{
 const store=new Store(await temp()),input={date:'2026-10-10',time:'12:34:56',content:'hello',remind:true,repeat:'none'};const note=saveAgenda(store,input);const due=new Date('2026-10-10T12:34:56');assert.equal(collectDue(store,new Date(+due-1)).length,0);assert.equal(collectDue(store,due).length,1);saveAgenda(store,{...input,id:note.id,content:'edited'});assert.equal(collectDue(store,new Date(+due+1000)).length,0);assert.equal(store.state.reminders[0].title,'edited');assert.throws(()=>saveAgenda(store,{...input,time:'25:00:00'}));assert.throws(()=>saveAgenda(store,{...input,date:'2026-02-30'}));saveAgenda(store,{...input,id:note.id,remind:false});assert.equal(store.state.reminders.length,0);assert.equal(new Store(store.directory).state.notes.length,1);
});
test('local author filter is repository-specific and does not omit the archive',async()=>{
 const root=await temp(),store=new Store(path.join(root,'data')),index=new GitIndex(store);
 for(const [name,email] of [['one','one@example.invalid'],['two','two@example.invalid']]){const repo=path.join(root,name);await fs.mkdir(repo);const git=(...args)=>exec('git',['-C',repo,...args],{windowsHide:true});await git('init');await git('config','user.name','Local');await git('config','user.email',email);await git('commit','--allow-empty','-m','mine');await git('commit','--allow-empty','--author','Other <other@example.invalid>','-m','other');await index.add(repo);}
 await index.sync();assert.equal((await index.query()).total,2);assert.equal((await index.query({mineOnly:false})).total,4);assert.equal((await index.query({query:'two@example.invalid'})).total,1);
});
test('account tokens and reset credits preserve missing versus zero, authoritative counts and 5h metadata',()=>{
 assert.equal(tokensFrom({}).today,null);assert.equal(tokensFrom({dailyUsageBuckets:[]}).today,null);const t=tokensFrom({summary:{lifetimeTokens:0},dailyUsageBuckets:[{startDate:'2026-10-10',tokens:0}]},new Date('2026-10-10T12:00:00'));assert.equal(t.today,0);assert.equal(t.total,0);assert.equal(resetCreditsFrom({}),null);assert.equal(resetCreditsFrom({rateLimitResetCredits:{availableCount:3,credits:[]}}).availableCount,3);assert.equal(resetCreditsFrom({rateLimitResetCredits:{availableCount:0,credits:null}}).availableCount,0);assert.equal(windowsFrom({rateLimits:{primary:{usedPercent:20,windowDurationMins:300}}})[0].minutes,300);
});
test('release checks compare versions, cache originals and retain stale results offline',async()=>{
 assert.equal(newer('rust-v0.200.0','0.199.9'),true);assert.equal(newer('v2.1.1','2.2.0'),false);assert.equal(newer('0.1.0','0.1.0-alpha.1'),true);assert.equal(newer('v1.0.0',null),null);
 const store=new Store(await temp());let calls=0;const service=new UpdateService(store,async()=>{calls++;return{ok:true,json:async()=>({tag_name:'v1.2.3',body:'changes',published_at:'2026-10-10'})};});service.installed=async()=> '1.2.0';const release=await service.read('codex');assert.equal(release.available,true);await service.read('codex');assert.equal(calls,1);service.fetcher=async()=>{throw new Error('offline');};assert.equal((await service.read('codex',true)).stale,true);assert.equal(translatedUrl(release.url,'en'),release.url);assert.equal(new URL(translatedUrl(release.url,'ja')).searchParams.get('tl'),'ja');assert.equal(new URL(translatedUrl(release.url,'zh-CN')).searchParams.get('u'),release.url);assert.throws(()=>translatedUrl('https://example.com','ja'));
});
test('all application strings have complete Chinese, English and Japanese translations',()=>{for(const [key,values] of Object.entries(messages)){assert.equal(values.length,locales.length,key);assert.ok(values.every(v=>typeof v==='string'&&v.length),key);}});
