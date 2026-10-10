const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {dataDirectory}=require('../src/core/data-directory.cjs');
test('DeskMate keeps existing data across rename and supports both environment variable names',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'deskmate-data-'));
 assert.equal(dataDirectory(root,{}),path.join(root,'DeskMate'));
 await fs.mkdir(path.join(root,'Longling PC Assistant'));await fs.writeFile(path.join(root,'Longling PC Assistant/assistant.json'),'{}');
 assert.equal(dataDirectory(root,{}),path.join(root,'Longling PC Assistant'));
 await fs.mkdir(path.join(root,'DeskMate'));await fs.writeFile(path.join(root,'DeskMate/assistant.json'),'{}');
 assert.equal(dataDirectory(root,{}),path.join(root,'DeskMate'));
 assert.equal(dataDirectory(root,{LONGLING_DATA_DIR:root}),root);
 assert.equal(dataDirectory(root,{LONGLING_DATA_DIR:root,DESKMATE_DATA_DIR:path.join(root,'custom')}),path.join(root,'custom'));
});
