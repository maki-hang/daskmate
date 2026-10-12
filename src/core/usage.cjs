const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createReadStream } = require('node:fs');
const readline = require('node:readline');
const exec = promisify(execFile);
const children = new Set();
function disposeUsage() { for (const child of children) child.kill(); children.clear(); }
const AGENTS = [{ id: 'codex', name: 'Codex', description: '账户额度 · 官方本地接口' }, { id: 'claude', name: 'Claude Code', description: '本地 Token · 可接状态行额度' }];
function windowsFrom(data) {
  const groups = data.rateLimitsByLimitId && Object.keys(data.rateLimitsByLimitId).length ? Object.entries(data.rateLimitsByLimitId) : [['codex', data.rateLimits]];
  const windows = [];
  for (const [id, bucket] of groups) {
    if (!bucket) continue;
    for (const key of ['primary', 'secondary']) {
      const w = bucket[key]; if (!w || !Number.isFinite(w.usedPercent)) continue;
      const minutes = w.windowDurationMins;
      const duration = minutes ? minutes % 1440 === 0 ? `${minutes / 1440} 天` : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟` : key === 'primary' ? '当前窗口' : '长期窗口';
      windows.push({ id: id + '-' + key, bucket: bucket.limitName || id, minutes, label: (bucket.limitName || id) + ' · ' + duration, usedPercent: Math.max(0, Math.min(100, w.usedPercent)), remainingPercent: Math.max(0, Math.min(100, 100 - w.usedPercent)), resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null });
    }
  }
  return windows;
}
async function findCodex(custom) {
  if (custom) { await fs.access(custom); return custom; }
  try { const r = await exec(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? 'codex.exe' : 'codex'], { windowsHide: true }); return r.stdout.trim().split(/\r?\n/)[0]; } catch {}
  if (process.platform === 'win32') {
    const root = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
    try {
      const dirs = await fs.readdir(root, { withFileTypes: true });
      const candidates = [];
      for (const dir of dirs.filter(d => d.isDirectory())) {
        const file = path.join(root, dir.name, 'codex.exe');
        try { candidates.push({ file, mtime: (await fs.stat(file)).mtimeMs }); } catch {}
      }
      if (candidates.length) return candidates.sort((a, b) => b.mtime - a.mtime)[0].file;
    } catch {}
  }
  throw new Error('未找到 Codex CLI。请安装并登录 Codex，或在设置中选择 codex 可执行文件。');
}
function resetCreditsFrom(data) {
  const value = data.rateLimitResetCredits;
  if (!value || !Number.isFinite(value.availableCount)) return null;
  return { availableCount: Math.max(0, value.availableCount), credits: Array.isArray(value.credits) ? value.credits.map(c => ({ id: c.id, status: c.status, expiresAt: c.expiresAt ? new Date(c.expiresAt * 1000).toISOString() : null })) : null };
}
function tokensFrom(data, now = new Date()) {
  const key = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const valid = v => Number.isFinite(v) && v >= 0 ? v : null;
  const buckets = data?.dailyUsageBuckets;
  return { total: valid(data?.summary?.lifetimeTokens), today: Array.isArray(buckets) ? valid(buckets.find(b => b.startDate === key)?.tokens) : null, peak: valid(data?.summary?.peakDailyTokens), source: 'account', daily: Array.isArray(buckets) ? buckets : null };
}
async function codexUsage(custom) {
  const command = await findCodex(custom);
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['app-server', '--listen', 'stdio://'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let buffer = '', settled = false, limits, tokenData, limitsDone = false, tokensDone = false;
    const complete = () => {
      if (!limitsDone || !tokensDone) return;
      if (!limits) return finish(new Error('usageUnavailable'));
      finish(null, { agent: 'codex', status: 'ok', source: 'account', updatedAt: new Date().toISOString(), windows: windowsFrom(limits), resetCredits: resetCreditsFrom(limits), tokens: tokensFrom(tokenData), plan: limits.rateLimits?.planType || null });
    };
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); child.stdin.end(); child.kill(); children.delete(child); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { if (limitsDone && limits) { tokensDone = true; complete(); } else finish(new Error('usageTimeout')); }, 25000);
    const send = value => { if (!settled) child.stdin.write(JSON.stringify(value) + '\n'); };
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new Error('无法启动 Codex CLI，请检查可执行文件。')));
    child.on('close', () => { if (!settled) finish(new Error('Codex 接口提前关闭，请检查 Codex 登录与配置。')); });
    child.stderr.resume(); // Do not log account credentials or CLI diagnostics.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) return finish(new Error('Codex 接口返回数据过大'));
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) return finish(new Error('当前 Codex 版本不支持初始化，请更新 Codex。'));
          send({ method: 'initialized' }); send({ id: 2, method: 'account/rateLimits/read' }); send({ id: 3, method: 'account/usage/read' });
        }
        if (msg.id === 2) {
          limitsDone = true; limits = msg.error ? null : msg.result; complete();
        }
        if (msg.id === 3) { tokensDone = true; tokenData = msg.error ? null : msg.result; complete(); }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'deskmate_pc_assistant', title: 'DeskMate', version: '0.4.1' }, capabilities: {} } });
  });
}
async function listJsonl(root) {
  const files = [], stack = [root];
  while (stack.length) {
    const dir = stack.pop(); let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p); else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  }
  return files;
}
class UsageService {
  constructor(store) { this.store = store; this.cache = {}; this.pending = {}; this.claudeFiles = new Map(); }
  async read(agent, force = false) {
    if (!AGENTS.some(a => a.id === agent)) throw new Error('未知 Agent');
    if (this.pending[agent]) return this.pending[agent];
    if (!force && this.cache[agent] && Date.now() - this.cache[agent].checkedAt < 60000) return this.cache[agent];
    this.pending[agent] = (async () => {
      try {
        const result = agent === 'codex' ? await codexUsage(this.store.state.settings.codexPath) : await this.claude();
        this.cache[agent] = { ...result, checkedAt: Date.now() };
      } catch (e) {
        this.cache[agent] = { agent, status: 'unavailable', windows: [], source: agent === 'codex' ? 'Codex 官方本地接口' : 'Claude 本地数据', message: e.message, checkedAt: Date.now(), updatedAt: null };
      }
      return this.cache[agent];
    })().finally(() => { delete this.pending[agent]; });
    return this.pending[agent];
  }
  async claude() {
    const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
    const files = await listJsonl(root);
    // Deduplicate streaming assistant records by message/request identity.
    for (const file of files) {
      const stat = await fs.stat(file); const old = this.claudeFiles.get(file);
      if (old?.mtime === stat.mtimeMs) continue;
      const records = new Map();
      const lines = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of lines) {
        try {
          const v = JSON.parse(line), u = v.message?.usage;
          if (v.type !== 'assistant' || !u) continue;
          const key = v.message.id || v.uuid; if (!key) continue;
          const tokens = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((n, k) => n + (Number(u[k]) || 0), 0);
          const previous = records.get(key);
          if (!previous || tokens >= previous.tokens) records.set(key, { tokens, at: v.timestamp });
        } catch {}
      }
      this.claudeFiles.set(file, { mtime: stat.mtimeMs, records });
    }
    for (const key of this.claudeFiles.keys()) if (!files.includes(key)) this.claudeFiles.delete(key);
    const messages = new Map();
    for (const entry of this.claudeFiles.values()) for (const [key, r] of entry.records) if (!messages.has(key) || r.tokens > messages.get(key).tokens) messages.set(key, r);
    let total = 0, today = 0;
    for (const r of messages.values()) { total += r.tokens; if (new Date(r.at).toDateString() === new Date().toDateString()) today += r.tokens; }
    let snapshot = null;
    try { snapshot = JSON.parse(await fs.readFile(path.join(this.store.directory, 'claude-usage.json'), 'utf8')); } catch {}
    const windows = [];
    if (snapshot?.rate_limits) for (const [key, label] of [['five_hour', '5 小时'], ['seven_day', '7 天']]) {
      const w = snapshot.rate_limits[key]; if (!w || !Number.isFinite(w.used_percentage)) continue;
      windows.push({ id: key, label, minutes: key === 'five_hour' ? 300 : 10080, usedPercent: w.used_percentage, remainingPercent: Math.max(0, 100 - w.used_percentage), resetsAt: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null });
    }
    const stale = Boolean(snapshot && (!Number.isFinite(Date.parse(snapshot.updatedAt)) || Date.now() - Date.parse(snapshot.updatedAt) > 10 * 60000 || windows.some(w => w.resetsAt && Date.parse(w.resetsAt) < Date.now())));
    return { agent: 'claude', status: files.length || snapshot ? 'ok' : 'unavailable', stale, source: 'Claude Code 本地日志' + (snapshot ? ' + 状态行快照' : ''), updatedAt: snapshot?.updatedAt || (files.length ? new Date().toISOString() : null), windows, tokens: { today: files.length ? today : null, total: files.length ? total : null, source: 'local' }, message: windows.length ? '额度为最近一次 Claude 状态行快照，非主动联网查询。' : '订阅额度尚未接入。可在设置中查看状态行接入说明；Token 来自本机日志，含缓存。' };
  }
}
module.exports = { AGENTS, UsageService, windowsFrom, resetCreditsFrom, tokensFrom, codexUsage, findCodex, disposeUsage };
