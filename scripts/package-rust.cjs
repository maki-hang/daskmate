const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
(async () => {
  const root=path.resolve(__dirname,'..'), manifest=require('../package.json');
  if (process.platform!=='win32' || process.arch!=='x64') throw Error('Portable packaging requires Windows x64');
  const name=process.env.DESKMATE_BUILD_NAME || `DeskMate-${manifest.version}-rust-win32-x64`;
  if (path.basename(name)!==name || name==='.' || name==='..') throw Error('Invalid portable build name');
  const directory=path.join(root,'release',name);
  try{await fs.access(directory);throw Error('输出目录已存在；请另设 DESKMATE_BUILD_NAME，避免覆盖现有版本。');}catch(error){if(error.code!=='ENOENT')throw error;}
  const result=spawnSync(process.execPath,[path.join(__dirname,'rust.cjs'),'build','--no-bundle'],{cwd:root,stdio:'inherit',windowsHide:true});
  if(result.status!==0)throw Error('Rust build failed');
  await fs.mkdir(directory,{recursive:true});
  await fs.copyFile(path.join(root,'src-tauri/target/release/DeskMate.exe'),path.join(directory,'DeskMate.exe'));
  for(const file of ['assets','README.md','README.en.md','README.ja.md','LICENSE'])await fs.cp(path.join(root,file),path.join(directory,file),{recursive:true});
  await fs.mkdir(path.join(directory,'docs'),{recursive:true});
  for(const file of ['rust-migration.md','database-migration.md'])await fs.copyFile(path.join(root,'docs',file),path.join(directory,'docs',file));
  await fs.writeFile(path.join(directory,'build-info.json'),JSON.stringify({version:manifest.version,runtime:'Tauri 2 / Rust / WebView2',builtAt:new Date().toISOString()},null,2));
  console.log('Built: '+path.join(directory,'DeskMate.exe'));
})().catch(error=>{console.error(error);process.exitCode=1;});
