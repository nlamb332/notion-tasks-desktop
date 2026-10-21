import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
const size = 256;
const pixels = Buffer.alloc(size * (size * 4 + 1));
function distance(x, y, ax, ay, bx, by) {
  const t = Math.max(0, Math.min(1, ((x-ax)*(bx-ax)+(y-ay)*(by-ay))/((bx-ax)**2+(by-ay)**2)));
  return Math.hypot(x-ax-t*(bx-ax), y-ay-t*(by-ay));
}
for (let y=0; y<size; y++) for(let x=0; x<size; x++) {
  const offset = y*(size*4+1)+1+x*4;
  const corner = Math.hypot(Math.max(0, Math.abs(x-127.5)-83.5), Math.max(0, Math.abs(y-127.5)-83.5));
  const inside = corner <= 36;
  const check = Math.min(distance(x,y,67,130,109,170),distance(x,y,109,170,191,84)) < 13;
  pixels[offset] = check ? 255 : 47;
  pixels[offset+1] = check ? 255 : 108;
  pixels[offset+2] = check ? 255 : 229;
  pixels[offset+3] = inside ? 255 : 0;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for(let b=0;b<8;b++) crc = (crc>>>1)^((crc&1)?0xedb88320:0); }
  return (crc^0xffffffff)>>>0;
}
function chunk(name, data) {
  const type=Buffer.from(name); const out=Buffer.alloc(data.length+12);
  out.writeUInt32BE(data.length,0); type.copy(out,4); data.copy(out,8);
  out.writeUInt32BE(crc32(Buffer.concat([type,data])),out.length-4); return out;
}
const header=Buffer.alloc(13); header.writeUInt32BE(size,0); header.writeUInt32BE(size,4); header[8]=8; header[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
const ico=Buffer.alloc(22); ico.writeUInt16LE(1,2); ico.writeUInt16LE(1,4); ico.writeUInt16LE(1,10); ico.writeUInt16LE(32,12); ico.writeUInt32LE(png.length,14); ico.writeUInt32LE(22,18);
mkdirSync('assets',{recursive:true}); writeFileSync('assets/icon.png',png); writeFileSync('assets/icon.ico',Buffer.concat([ico,png]));
