const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, '.cache/tauri-web');
  await fs.mkdir(output, { recursive: true });
  const messages = JSON.stringify(require('../src/renderer/i18n.js').messages, null, 2) + '\n';
  const translations = path.join(root, 'src-tauri/i18n.json');
  if (await fs.readFile(translations, 'utf8').catch(() => '') !== messages) await fs.writeFile(translations, messages);
  for (const file of await fs.readdir(path.join(root, 'src/renderer'))) {
    if (!/\.(html|js|css)$/.test(file)) continue;
    let content = await fs.readFile(path.join(root, 'src/renderer', file), 'utf8');
    if (file.endsWith('.html')) {
      content = content.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
      content = content.replace('<script src="i18n.js">', '<script src="tauri-bridge.js"></script><script src="i18n.js">');
    }
    await fs.writeFile(path.join(output, file), content);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
