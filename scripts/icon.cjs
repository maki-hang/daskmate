const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
function crc32(bytes) { let crc = 0xffffffff; for (const b of bytes) { crc ^= b; for (let j=0;j<8;j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, bytes) { const name=Buffer.from(type), size=Buffer.alloc(4), crc=Buffer.alloc(4); size.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([name,bytes]))); return Buffer.concat([size,name,bytes,crc]); }
function png(size) {
  const pixels=Buffer.alloc((size*4+1)*size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
    const u=(x+.5)/size,v=(y+.5)/size,dx=Math.max(Math.abs(u-.5)-.29,0),dy=Math.max(Math.abs(v-.5)-.29,0);
    const inside=dx*dx+dy*dy<=.18*.18;
    const outer=((u-.46)/.25)**2+((v-.5)/.29)**2<=1;
    const inner=((u-.46)/.135)**2+((v-.5)/.17)**2<1;
    const letter=(u>=.27&&u<=.39&&v>=.21&&v<=.79)||(u>=.37&&outer&&!inner);
    const dot=(u-.76)**2+(v-.24)**2<.006;
    const rgba=!inside?[0,0,0,0]:dot?[183,213,154,255]:letter?[248,250,238,255]:[58,120,93,255];
    pixels.set(rgba,y*(size*4+1)+1+x*4);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
async function generateIcon() {
  const images=[16,32,48,256].map(size=>({size,bytes:png(size)})),header=Buffer.alloc(6+16*images.length);header.writeUInt16LE(1,2);header.writeUInt16LE(images.length,4);let offset=header.length;
  images.forEach(({size,bytes},i)=>{const p=6+i*16;header[p]=size===256?0:size;header[p+1]=header[p];header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);header.writeUInt32LE(bytes.length,p+8);header.writeUInt32LE(offset,p+12);offset+=bytes.length;});
  const folder=path.resolve(__dirname,'../build');await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'icon.ico'),Buffer.concat([header,...images.map(i=>i.bytes)]));await fs.writeFile(path.join(folder,'icon.png'),png(256));
}
module.exports={generateIcon};
if(require.main===module)generateIcon().catch(e=>{console.error(e);process.exitCode=1;});
