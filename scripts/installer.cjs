const path = require('node:path');
const fs = require('node:fs/promises');
const { build, Platform, Arch } = require('electron-builder');
const { buildPortable } = require('./package.cjs');
const { generateIcon } = require('./icon.cjs');

(async () => {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the Windows installer on Windows x64.');
  const root = path.resolve(__dirname, '..');
  // Reuse the pinned npm dependency's Windows 7-Zip; avoid a redundant tool download.
  if (!process.env.ELECTRON_BUILDER_7ZIP_PATH) {
    const sevenZip = path.join(path.dirname(require.resolve('electron-winstaller/package.json')), 'vendor', '7z-x64.exe');
    await fs.access(sevenZip);
    process.env.ELECTRON_BUILDER_7ZIP_PATH = sevenZip;
  }
  const cache = path.join(root, '.cache');
  await fs.mkdir(cache, { recursive: true });
  const staging = await fs.mkdtemp(path.join(cache, 'installer-build-'));
  const prepackaged = path.join(staging, 'app');
  try {
    await generateIcon();
    await buildPortable(prepackaged);
    const artifacts = await build({
      projectDir: root,
      prepackaged,
      targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
      config: require('../electron-builder.cjs'),
      publish: 'never',
    });
    console.log('Installer built:\n' + artifacts.join('\n'));
  } finally {
    // Only remove the exact temporary build directory created by this invocation.
    if (path.dirname(path.resolve(staging)) !== cache || !path.basename(staging).startsWith('installer-build-')) throw new Error('Unsafe cleanup path');
    await fs.rm(staging, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
