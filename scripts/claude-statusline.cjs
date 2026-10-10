// Optional Claude Code statusLine command; only persists normalized quota numbers.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { dataDirectory } = require(require('node:fs').existsSync(path.join(__dirname, '../src/core/data-directory.cjs')) ? '../src/core/data-directory.cjs' : './data-directory.cjs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => { input += data; if (input.length > 1024 * 1024) process.exit(1); });
process.stdin.on('end', () => {
  try {
    const value = JSON.parse(input), rate_limits = {};
    for (const key of ['five_hour', 'seven_day']) {
      const w = value.rate_limits?.[key];
      if (w && Number.isFinite(w.used_percentage)) rate_limits[key] = { used_percentage: Math.max(0, Math.min(100, w.used_percentage)), resets_at: Number.isFinite(w.resets_at) ? w.resets_at : null };
    }
    const base = process.platform === 'win32' ? process.env.APPDATA : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support') : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const directory = dataDirectory(base);
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, 'claude-usage.json'), tmp = target + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), rate_limits })); fs.renameSync(tmp, target);
    console.log(Object.keys(rate_limits).length ? Object.entries(rate_limits).map(([k,w]) => `${k === 'five_hour' ? '5h' : '7d'}: ${w.used_percentage.toFixed(0)}%`).join(' | ') : '桌伴 · 额度暂不可用');
  } catch { console.log('桌伴 · 等待额度数据'); }
});
