const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const env = Object.fromEntries(Object.entries(process.env).map(([key,value]) => [process.platform === 'win32' ? key.toUpperCase() : key,value]));
const localCargo = path.join(root, '.cache/cargo');
if (fs.existsSync(path.join(localCargo, 'bin/cargo.exe'))) {
  env.CARGO_HOME = localCargo;
  env.RUSTUP_HOME = path.join(root, '.cache/rustup');
  env.PATH = path.join(localCargo, 'bin') + path.delimiter + env.PATH;
}
const vcvars = path.join(root, '.cache/buildtools/VC/Auxiliary/Build/vcvars64.bat');
if (process.platform === 'win32' && fs.existsSync(vcvars)) {
  const output = execFileSync(env.COMSPEC || 'cmd.exe', ['/d','/s','/c', `call "${vcvars}" >nul && set`], { env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
  for (const line of output.split(/\r?\n/)) {
    const split = line.indexOf('=');
    if (split > 0) env[line.slice(0, split).toUpperCase()] = line.slice(split + 1);
  }
}
const temporary = path.join(root, '.cache/rust-tests');
fs.mkdirSync(temporary, { recursive: true });
env.TEMP = temporary;
env.TMP = temporary;
const mode = process.argv[2] || 'dev';
const args = process.argv.slice(3);
if (mode !== 'fetch' && mode !== 'fmt') {
  const prepare = spawnSync(process.execPath, [path.join(__dirname,'prepare-tauri.cjs')], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (prepare.status !== 0) process.exit(prepare.status ?? 1);
}
let command, parameters;
if (['test', 'check', 'fetch', 'fmt', 'clippy'].includes(mode)) {
  command = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  parameters = [mode, '--manifest-path', path.join(root, 'src-tauri/Cargo.toml'), ...args];
} else {
  command = process.execPath;
  parameters = [require.resolve('@tauri-apps/cli/tauri.js'), mode, ...args];
}
const result = spawnSync(command, parameters, { cwd: root, env, stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
