const { createPackage } = require('@electron/asar');
const path = require('node:path');
const fs = require('node:fs/promises');
const { editWindowsResources } = require('app-builder-lib/out/util/resEdit');
async function buildPortable(destination) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此打包脚本需在 Windows x64 上运行。');
  const root = path.resolve(__dirname, '..');
  const manifest = require('../package.json');
  const output = destination || path.join(root, 'release', process.env.DESKMATE_BUILD_NAME || `DeskMate-${manifest.version}-win32-x64`);
  const releaseRoot = path.join(root, 'release') + path.sep, cacheRoot = path.join(root, '.cache') + path.sep;
  if (![releaseRoot, cacheRoot].some(base => path.resolve(output).startsWith(base))) throw new Error('Build output must stay inside release or .cache');
  try { await fs.access(output); throw new Error('输出目录已存在；请另设 DESKMATE_BUILD_NAME，避免覆盖现有版本。'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const runtime = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
  const expected = require('electron/package.json').version;
  if ((await fs.readFile(path.join(runtime, 'version'), 'utf8')).trim().replace(/^v/, '') !== expected) throw new Error('Electron 运行时版本不匹配，请先运行 npx install-electron。');
  console.log('Copying verified Electron ' + expected + ' runtime…');
  await fs.cp(runtime, output, { recursive: true, filter: source => !['electron.exe', 'default_app.asar', 'version'].includes(path.basename(source)) });
  await fs.copyFile(path.join(runtime, 'electron.exe'), path.join(output, 'DeskMate.exe'));
  // Edit the copied runtime only; the installed Electron runtime stays intact.
  await editWindowsResources({ file: path.join(output, 'DeskMate.exe'), iconPath: path.join(root, 'build/icon.ico'),
    versionStrings: { FileDescription: 'DeskMate', ProductName: 'DeskMate', InternalName: 'DeskMate', OriginalFilename: 'DeskMate.exe' },
    fileVersion: manifest.version, productVersion: manifest.version });
  await fs.mkdir(path.join(root, '.cache'), { recursive: true });
  const staging = await fs.mkdtemp(path.join(root, '.cache/app-package-'));
  for (const file of ['src', 'assets', 'build', 'README.md', 'README.en.md', 'README.ja.md']) await fs.cp(path.join(root, file), path.join(staging, file), { recursive: true });
  await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, main: manifest.main, description: manifest.description }));
  await createPackage(staging, path.join(output, 'resources', 'app.asar'));
  for (const doc of ['README.md','README.en.md','README.ja.md']) await fs.copyFile(path.join(root, doc), path.join(output, 'resources', doc));
  await fs.copyFile(path.join(__dirname, 'claude-statusline.cjs'), path.join(output, 'resources', 'claude-statusline.cjs'));
  await fs.copyFile(path.join(root, 'src/core/data-directory.cjs'), path.join(output, 'resources', 'data-directory.cjs'));
  await fs.writeFile(path.join(output, 'resources', 'build-info.json'), JSON.stringify({ version: manifest.version, electron: expected, builtAt: new Date().toISOString(), artworkCommit: require('../assets/catalog.json').revision, artworkSkins: require('../assets/catalog.json').skins }, null, 2));
  console.log('Built: ' + path.join(output, 'DeskMate.exe'));
  if (path.dirname(staging) !== path.join(root, '.cache') || !path.basename(staging).startsWith('app-package-')) throw new Error('Unsafe cleanup path');
  await fs.rm(staging, { recursive: true, force: true });
  return output;
}
module.exports = { buildPortable };
if (require.main === module) require('./icon.cjs').generateIcon().then(() => buildPortable()).catch(e => { console.error(e); process.exitCode = 1; });
