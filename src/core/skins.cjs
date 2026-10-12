const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const catalog = require('../../assets/catalog.json');
const builtins = catalog.skins.map(id => ({
  ...require(`../../assets/${id}/skin.json`), id,
  directory: path.resolve(__dirname, '../../assets', id)
}));
const builtin = builtins[0];
async function importSkin(store, manifestPath) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (typeof manifest.name !== 'string' || !manifest.name.trim() || !manifest.states?.idle) throw new Error('资源包需要 name 和 states.idle。');
  const root = await fs.realpath(path.dirname(manifestPath)), states = {}, files = [];
  for (const [key, file] of Object.entries(manifest.states)) {
    if (!['idle', 'happy', 'attention', 'error', 'reminder', 'working'].includes(key)) continue;
    if (typeof file !== 'string' || !/\.(gif|webp|png|apng)$/i.test(file)) throw new Error('动画支持 GIF、WebP、PNG、APNG。');
    const source = await fs.realpath(path.resolve(root, file));
    const relative = path.relative(root, source);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('动画文件必须位于资源包目录内。');
    const stat = await fs.stat(source);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('单个动画文件须小于 20 MB。');
    const target = key + path.extname(file).toLowerCase(); states[key] = target; files.push({ source, target });
  }
  const id = randomUUID(), directory = path.join(store.directory, 'skins', id);
  await fs.mkdir(directory, { recursive: true });
  for (const f of files) await fs.copyFile(f.source, path.join(directory, f.target));
  const skin = { id, name: manifest.name.trim().slice(0, 60), author: String(manifest.author || '自定义').slice(0, 100), source: String(manifest.source || '').slice(0, 500), license: String(manifest.license || '').slice(0, 200), states, directory };
  await fs.writeFile(path.join(directory, 'skin.json'), JSON.stringify(skin, null, 2));
  store.update(s => s.skins.push(skin)); return skin;
}
function allSkins(store) {
  return [...builtins, ...store.state.skins].map(s => ({ ...s, states: Object.fromEntries(Object.entries(s.states).map(([k, f]) => [k, pathToFileURL(path.join(s.directory, f)).href])) }));
}
module.exports = { importSkin, allSkins, builtin, builtins };
