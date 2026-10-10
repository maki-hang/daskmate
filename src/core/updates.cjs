const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { findCodex } = require('./usage.cjs');
const exec = promisify(execFile);
const repositories = { codex: 'openai/codex', claude: 'anthropics/claude-code' };
function version(value) { return String(value || '').match(/(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?/)?.slice(1); }
function newer(latest, installed) {
  const a = version(latest), b = version(installed); if (!a || !b) return null;
  for (let i=0;i<3;i++) if (+a[i] !== +b[i]) return +a[i] > +b[i];
  return !a[3] && Boolean(b[3]);
}
function releaseUrl(agent, tag) {
  if (!repositories[agent]) throw new Error('unknownAgent');
  return `https://github.com/${repositories[agent]}/releases/tag/${encodeURIComponent(tag)}`;
}
function translatedUrl(url, language) {
  if (!/^https:\/\/github\.com\/(openai\/codex|anthropics\/claude-code)\/releases\/tag\//.test(url)) throw new Error('invalidLink');
  if (language === 'en') return url;
  return 'https://translate.google.com/translate?' + new URLSearchParams({ sl: 'auto', tl: language === 'ja' ? 'ja' : 'zh-CN', u: url });
}
class UpdateService {
  constructor(store, fetcher = fetch) { this.store=store; this.fetcher=fetcher; this.pending={}; }
  async installed(agent) {
    try {
      let executable;
      if (agent === 'codex') executable = await findCodex(this.store.state.settings.codexPath);
      else executable = (await exec(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? 'claude.exe' : 'claude'], {windowsHide:true,timeout:5000})).stdout.trim().split(/\r?\n/)[0];
      const output=(await exec(executable,['--version'],{windowsHide:true,timeout:10000,maxBuffer:10000})).stdout;
      return output.match(/\d+\.\d+\.\d+(?:-[\w.-]+)?/)?.[0] || null;
    } catch { return null; }
  }
  async read(agent, force=false) {
    if (!repositories[agent]) throw new Error('unknownAgent');
    if (this.pending[agent]) return this.pending[agent];
    this.pending[agent]=this.load(agent,force).finally(()=>delete this.pending[agent]); return this.pending[agent];
  }
  async load(agent,force) {
    const file=path.join(this.store.directory,`release-${agent}.json`);
    let cached; try { cached=JSON.parse(await fs.readFile(file,'utf8')); } catch {}
    const installed=await this.installed(agent);
    if (!force && cached && Date.now()-cached.checkedAt < 6*3600000) return {...cached,installed,available:newer(cached.version,installed)};
    try {
      const response=await this.fetcher(`https://api.github.com/repos/${repositories[agent]}/releases/latest`,{headers:{Accept:'application/vnd.github+json','User-Agent':'DeskMate-PC-Assistant'},signal:AbortSignal.timeout(20000)});
      if (!response.ok) throw new Error('releaseUnavailable');
      const data=await response.json();
      if (!version(data.tag_name) || data.prerelease || data.draft) throw new Error('releaseUnavailable');
      const result={agent,version:data.tag_name,body:String(data.body||'').slice(0,100000),url:releaseUrl(agent,data.tag_name),publishedAt:data.published_at,checkedAt:Date.now(),installed,available:newer(data.tag_name,installed),stale:false};
      await fs.writeFile(file+'.tmp',JSON.stringify(result));await fs.rename(file+'.tmp',file);return result;
    } catch { return cached ? {...cached,installed,available:newer(cached.version,installed),stale:true} : {agent,installed,error:'releaseUnavailable',available:null}; }
  }
}
module.exports={UpdateService,newer,releaseUrl,translatedUrl};
