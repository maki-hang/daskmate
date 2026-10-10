const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { Store, saveNote, saveReminder } = require('../src/core/store.cjs');
const { collectDue } = require('../src/core/reminders.cjs');
const { GitIndex, discover } = require('../src/core/git.cjs');
const { windowsFrom, UsageService } = require('../src/core/usage.cjs');
const { importSkin, allSkins } = require('../src/core/skins.cjs');
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'deskmate-test-'));

test('notes persist Unicode and distinct dates; invalid date cannot corrupt stored content', async () => {
  const dir=await temp(), store=new Store(dir);
  const note=saveNote(store,{date:'2026-10-09',content:'第一条\n<不要执行的内容> 中文 🐉'});
  saveNote(store,{date:'2026-10-10',content:'明天的想法'});
  saveNote(store,{id:note.id,date:'2026-10-09',content:'更新后的内容'});
  assert.throws(()=>saveNote(store,{date:'2026-02-30',content:'无效日期'}));
  const reloaded=new Store(dir);assert.equal(reloaded.state.notes.length,2);assert.equal(reloaded.state.notes[0].content,'更新后的内容');
  await fs.writeFile(store.file,'invalid-json');
  const recovered=new Store(dir);assert.equal(recovered.recovered,true);assert.equal(recovered.state.notes.length,2);
});
test('reminders catch up after restart once, handle recurring occurrences and paused reminders',async()=>{
  const dir=await temp(),store=new Store(dir);
  const now=new Date('2026-10-09T10:00:00Z');
  saveReminder(store,{title:'一次',dueAt:'2026-10-08T08:00:00Z',repeat:'none'});
  saveReminder(store,{title:'每天',dueAt:'2026-10-01T08:00:00Z',repeat:'daily'});
  saveReminder(store,{title:'每周',dueAt:'2026-10-01T08:00:00Z',repeat:'weekly'});
  const paused=saveReminder(store,{title:'暂停',dueAt:'2026-10-01T08:00:00Z',repeat:'none'});
  store.update(s=>{s.reminders.find(r=>r.id===paused.id).enabled=false;});
  assert.equal(collectDue(store,now).length,3);assert.equal(collectDue(new Store(dir),now).length,0);
  assert.equal(store.state.reminders[0].completed,true);
  assert.ok(store.state.reminders.slice(1,3).every(r=>new Date(r.dueAt)>now));
  assert.equal(collectDue(store,new Date('2026-10-10T10:00:00Z')).length,1);
});
test('Git indexes every branch, keeps deleted-branch records, deduplicates refresh and supports search',async()=>{
  const root=await temp(),repo=path.join(root,'repo with space 中文');await fs.mkdir(repo);
  const git=(...args)=>exec('git',['-C',repo,...args],{windowsHide:true});
  await git('init','-b','main');await git('config','user.name','测试作者');await git('config','user.email','test@example.invalid');
  await fs.writeFile(path.join(repo,'one.txt'),'one');await git('add','.');await git('commit','-m','首次提交\n\n多行说明 🐉');
  await git('checkout','-b','feature');await fs.writeFile(path.join(repo,'two.txt'),'two');await git('add','.');await git('commit','-m','功能分支记录');await git('checkout','main');
  const store=new Store(path.join(root,'data')),index=new GitIndex(store);await index.add(repo);await index.add(repo);assert.equal(store.state.repositories.length,1);
  await index.sync();assert.equal((await index.query()).total,2);assert.equal((await index.query({query:'功能'})).total,1);
  await git('branch','-D','feature');await git('reflog','expire','--expire=now','--all');await index.sync();await index.sync();assert.equal((await index.query()).total,2);
  const reload=new GitIndex(new Store(path.join(root,'data')));assert.equal((await reload.query({query:'测试作者'})).total,2);
  const found=await discover(root);assert.ok(found.found.includes(repo));
});
test('Git pagination does not truncate the archived history',async()=>{
  const root=await temp(),repo=path.join(root,'repository');await fs.mkdir(repo);
  const git=(...args)=>exec('git',['-C',repo,...args],{windowsHide:true});
  await git('init','-b','main');await git('config','user.name','Pagination');await git('config','user.email','test@example.invalid');
  for(let i=0;i<43;i++)await git('commit','--allow-empty','-m','commit '+i);
  const store=new Store(path.join(root,'data')),index=new GitIndex(store);await index.add(repo);await index.sync();
  const first=await index.query({page:0}),second=await index.query({page:1});assert.equal(first.total,43);assert.equal(first.rows.length,40);assert.equal(second.rows.length,3);assert.equal(new Set([...first.rows,...second.rows].map(x=>x.hash)).size,43);
});
test('usage preserves zero, missing windows and distinct buckets without inventing quotas',()=>{
  assert.deepEqual(windowsFrom({rateLimits:{primary:{usedPercent:null}}}),[]);
  const w=windowsFrom({rateLimits:{primary:{usedPercent:99}},rateLimitsByLimitId:{codex:{primary:{usedPercent:0,windowDurationMins:300,resetsAt:1900000000}},other:{secondary:{usedPercent:100,windowDurationMins:10080}}}});
  assert.equal(w.length,2);assert.equal(w[0].remainingPercent,100);assert.equal(w[1].remainingPercent,0);assert.match(w[0].label,/5 小时/);
});
test('Claude local logs deduplicate streamed and copied messages; statusline quota remains independent',async()=>{
  const root=await temp(), projects=path.join(root,'projects','demo');await fs.mkdir(projects,{recursive:true});
  const old=process.env.CLAUDE_CONFIG_DIR;process.env.CLAUDE_CONFIG_DIR=root;
  try {
    const message={type:'assistant',timestamp:new Date().toISOString(),message:{id:'same-id',usage:{input_tokens:50,output_tokens:10,cache_read_input_tokens:20}}};
    await fs.writeFile(path.join(projects,'session.jsonl'),JSON.stringify(message)+'\n'+JSON.stringify(message)+'\n{unfinished');
    const store=new Store(path.join(root,'data')),service=new UsageService(store);let r=await service.read('claude',true);assert.equal(r.tokens.total,80);assert.equal(r.windows.length,0);
    await fs.writeFile(path.join(store.directory,'claude-usage.json'),JSON.stringify({updatedAt:new Date().toISOString(),rate_limits:{five_hour:{used_percentage:0,resets_at:1900000000}}}));
    r=await service.read('claude',true);assert.equal(r.windows[0].remainingPercent,100);
  }finally{old===undefined?delete process.env.CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR=old;}
});
test('custom skin imports copy assets and reject paths outside the pack',async()=>{
  const root=await temp(),source=path.join(root,'pack'),store=new Store(path.join(root,'data'));await fs.mkdir(source);
  await fs.copyFile(path.resolve(__dirname,'../assets/white-dragon/idle.webp'),path.join(source,'idle.webp'));
  const manifest=path.join(source,'skin.json');await fs.writeFile(manifest,JSON.stringify({name:'我的桌宠',states:{idle:'idle.webp'}}));
  const skin=await importSkin(store,manifest);assert.equal(allSkins(store).length,2);assert.ok(allSkins(store)[1].states.idle.startsWith('file:'));assert.ok((await fs.stat(path.join(skin.directory,'idle.webp'))).size>0);
  await fs.writeFile(manifest,JSON.stringify({name:'越界',states:{idle:'../pack/../../outside.webp'}}));await assert.rejects(()=>importSkin(store,manifest));
});
