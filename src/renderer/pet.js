let state,usage,anim='idle',restore;
const $=id=>document.getElementById(id),lang=()=>state?.settings.language||'zh-CN',tr=(k,v)=>i18n.t(k,lang(),v);
function render(){
 if(!state)return;document.documentElement.lang=lang();document.title=tr('appTitle');
 const agent=state.settings.agent,skin=state.skins.find(s=>s.id===state.settings.skins[agent])||state.skins[0],source=skin.states[anim]||skin.states.idle;
 if($('character').src!==source)$('character').src=source;$('character').alt=tr('petAlt');$('pet').ariaLabel=tr('openApp');$('pet').title=tr('openApp');$('status').title=tr('usage');document.querySelector('.drag').title=tr('drag');
 $('agent').textContent=state.agents.find(a=>a.id===agent).name;
 const data=usage?.agent===agent?usage:null;const quota=$('quota');quota.replaceChildren();
 const row=(label,value)=>{const line=document.createElement('span');line.className='quota-row';const text=document.createElement('span');text.textContent=label;const amount=document.createElement('b');amount.textContent=value;line.append(text,amount);quota.append(line);};
 if(!data)row(tr('loading'),'');else if(data.status!=='ok')row(tr('connecting'),'');else{
   // Keep the five-hour window visible before longer windows; never combine them.
   const windows=[...data.windows].sort((a,b)=>(a.minutes===300?-1:b.minutes===300?1:(a.minutes||0)-(b.minutes||0)));
   for(const w of windows)row((windows.filter(x=>x.minutes===w.minutes).length>1?(w.bucket||'')+' ':'')+i18n.duration(w,lang(),true),`${w.remainingPercent.toFixed(0)}%`);
   if(!windows.length)row(Number.isFinite(data.tokens?.today)?tr('todayTokens'):tr('noQuota'),Number.isFinite(data.tokens?.today)?data.tokens.today.toLocaleString(lang()):'');
   quota.title=windows.map(w=>`${i18n.duration(w,lang())}: ${w.remainingPercent.toFixed(0)}% · ${tr('nextReset')} ${w.resetsAt?new Date(w.resetsAt).toLocaleString(lang()):'—'}`).join('\n');
 }
 $('status').classList.toggle('stale',Boolean(data?.stale));$('agent').title=data?.stale?tr('stale'):tr('remaining');
 $('bubble').hidden=!state.lastReminder;if(state.lastReminder)$('bubble').textContent='🔔 '+state.lastReminder.title;
}
function onUsage(v){usage=v;if(!restore)anim=v.status!=='ok'||v.windows.some(w=>w.remainingPercent<=10)?'attention':'idle';render();}
$('pet').onclick=()=>{anim='happy';render();clearTimeout(restore);restore=setTimeout(()=>{restore=null;onUsage(usage||{status:'ok',windows:[]});},2500);window.assistant.call('panel');};
$('status').onclick=()=>window.assistant.call('panel',{page:'usage'});$('bubble').onclick=()=>window.assistant.call('panel',{page:'agenda'});
document.oncontextmenu=e=>{e.preventDefault();window.assistant.call('menu');};window.assistant.on('changed',v=>{state=v;render();});window.assistant.on('usage',onUsage);window.assistant.on('reminder',v=>{state.lastReminder=v;anim='reminder';render();});
window.assistant.call('state').then(v=>{state=v;render();return window.assistant.call('usage');}).then(onUsage).catch(()=>$('quota').textContent=tr('connecting'));
