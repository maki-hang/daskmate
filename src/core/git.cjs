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
  constructor(store) { this.store = store; this.busy = null; this.disposed = false; }
  async add(directory) {
    const bare = await git(directory, ['rev-parse', '--is-bare-repository']);
    const root = await fs.realpath(bare === 'true' ? directory : await git(directory, ['rev-parse', '--show-toplevel']));
    const id = createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 20);
    this.store.update(s => { if (!s.repositories.some(r => r.id === id)) s.repositories.push({ id, path: root, name: path.basename(root), count: 0, syncedAt: null }); });
    return id;
  }
  async records(repo) {
    return this.store.database.records(repo.id);
  }
  async sync() {
    if (this.busy) return this.busy;
    this.busy = this.performSync().finally(() => { this.busy = null; });
    return this.busy;
  }
  async performSync() {
    for (const repo of [...this.store.state.repositories]) {
      if (this.disposed) break;
      try {
        const identity = { email: await git(repo.path, ['config', 'user.email']).catch(() => ''), name: await git(repo.path, ['config', 'user.name']).catch(() => '') };
        const current = await readCommits(repo.path);
        if (!this.disposed) this.store.saveCommits(repo.id, current, identity);
      } catch (e) { if (!this.disposed) this.store.update(s => { const r = s.repositories.find(x => x.id === repo.id); if (r) r.error = e.message.slice(0, 300); }); }
    }
    return this.store.state.repositories;
  }
  async query({ repoId = '', query = '', date = '', page = 0, mineOnly = true } = {}) {
    return this.store.database.queryCommits({ repoId, query, date, page, mineOnly });
  }
  dispose() { this.disposed = true; }
}
module.exports = { GitIndex, discover, readCommits, disposeGit };
