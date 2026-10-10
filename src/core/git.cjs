const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const exec = promisify(execFile);
const children = new Set();
function disposeGit() { for (const child of children) child.kill(); children.clear(); }
const skip = new Set(['.git', 'node_modules', '$RECYCLE.BIN', 'System Volume Information', '.venv', 'venv']);
async function git(cwd, args) {
  return (await exec('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args], { windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30000 })).stdout.trim();
}
async function discover(root) {
  const stack = [path.resolve(root)], found = [], warnings = [];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { warnings.push(dir); continue; }
    if (entries.some(e => e.name === '.git') || (entries.some(e => e.name === 'HEAD') && entries.some(e => e.name === 'objects'))) found.push(dir);
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && !skip.has(e.name)) stack.push(path.join(dir, e.name));
  }
  return { found, warnings };
}
function readCommits(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, 'log', '--all', '--reflog', '--date-order', '--format=%H%x00%aI%x00%an%x00%ae%x00%B%x00'], { windowsHide: true });
    children.add(child);
    const records = []; let fields = [], buffer = '', errors = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('仓库索引超时，请稍后重试')); }, 180000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let pos;
      while ((pos = buffer.indexOf('\0')) >= 0) {
        fields.push(buffer.slice(0, pos)); buffer = buffer.slice(pos + 1);
        if (fields.length === 5) {
          const [rawHash, date, author, email, message] = fields; fields = [];
          const hash = rawHash.trim();
          if (/^[a-f0-9]{40,64}$/.test(hash)) records.push({ hash, date, author, email, message: message.trimEnd(), subject: message.split('\n')[0] });
        }
      }
    });
    child.stderr.on('data', d => { errors = (errors + d).slice(-2000); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); children.delete(child); code === 0 ? resolve(records) : reject(new Error(errors || '无法读取 Git 仓库')); });
  });
}
class GitIndex {
  constructor(store) { this.store = store; this.busy = null; this.cache = new Map(); }
  async add(directory) {
    const bare = await git(directory, ['rev-parse', '--is-bare-repository']);
    const root = await fs.realpath(bare === 'true' ? directory : await git(directory, ['rev-parse', '--show-toplevel']));
    const id = createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 20);
    this.store.update(s => { if (!s.repositories.some(r => r.id === id)) s.repositories.push({ id, path: root, name: path.basename(root), count: 0, syncedAt: null }); });
    return id;
  }
  async records(repo) {
    if (this.cache.has(repo.id)) return this.cache.get(repo.id);
    try { const rows = JSON.parse(await fs.readFile(path.join(this.store.directory, 'git-' + repo.id + '.json'), 'utf8')); this.cache.set(repo.id, rows); return rows; }
    catch (e) { if (e.code === 'ENOENT') return []; throw new Error('提交缓存损坏，请保留备份并重新索引'); }
  }
  async sync() {
    if (this.busy) return this.busy;
    this.busy = this.performSync().finally(() => { this.busy = null; });
    return this.busy;
  }
  async performSync() {
    for (const repo of [...this.store.state.repositories]) {
      try {
        const identity = { email: await git(repo.path, ['config', 'user.email']).catch(() => ''), name: await git(repo.path, ['config', 'user.name']).catch(() => '') };
        this.store.update(s => { const r = s.repositories.find(x => x.id === repo.id); if (r) r.identity = identity; });
        const current = await readCommits(repo.path);
        const records = new Map((await this.records(repo)).map(c => [c.hash, c]));
        for (const c of current) records.set(c.hash, c);
        const rows = [...records.values()].sort((a, b) => b.date.localeCompare(a.date));
        const file = path.join(this.store.directory, 'git-' + repo.id + '.json');
        await fs.writeFile(file + '.tmp', JSON.stringify(rows)); await fs.rename(file + '.tmp', file);
        this.cache.set(repo.id, rows);
        this.store.update(s => { const r = s.repositories.find(x => x.id === repo.id); if (r) Object.assign(r, { count: rows.length, syncedAt: new Date().toISOString(), error: null }); });
      } catch (e) { this.store.update(s => { const r = s.repositories.find(x => x.id === repo.id); if (r) r.error = e.message.slice(0, 300); }); }
    }
    return this.store.state.repositories;
  }
  async query({ repoId = '', query = '', date = '', page = 0, mineOnly = true } = {}) {
    const all = [], term = String(query).toLowerCase().slice(0, 300);
    for (const repo of this.store.state.repositories) {
      if (repoId && repo.id !== repoId) continue;
      for (const c of await this.records(repo)) {
        if (mineOnly && !(repo.identity?.email ? c.email.toLowerCase() === repo.identity.email.toLowerCase() : repo.identity?.name && c.author === repo.identity.name)) continue;
        const local = new Date(c.date), key = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
        if (date && key !== date) continue;
        if (term && ![c.message, c.author, c.email, c.hash, repo.name].some(x => x.toLowerCase().includes(term))) continue;
        all.push({ ...c, repoId: repo.id, repository: repo.name });
      }
    }
    all.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    const start = Math.max(0, Math.floor(Number(page) || 0)) * 40;
    return { total: all.length, rows: all.slice(start, start + 40) };
  }
}
module.exports = { GitIndex, discover, readCommits, disposeGit };
