import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { officeMembers, officeCrc32 } from '../src/services/office-archive.ts';
import { readFolderOffice, MAX_OFFICE_BYTES } from '../src/repositories/project-files.ts';

function zip(entries, deflate = true) {
  const locals=[],central=[];let offset=0;
  for(const [name,value] of entries){
    const n=Buffer.from(name),data=Buffer.from(value),packed=deflate?deflateRawSync(data):data,crc=officeCrc32(data);
    const l=Buffer.alloc(30);l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt16LE(deflate?8:0,8);l.writeUInt32LE(crc,14);l.writeUInt32LE(packed.length,18);l.writeUInt32LE(data.length,22);l.writeUInt16LE(n.length,26);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(deflate?8:0,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(packed.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);
    locals.push(l,n,packed);central.push(c,n);offset+=30+n.length+packed.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,directory,end]);
}
const xml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>مرحبا &amp; Hello</w:t></w:r></w:p></w:body></w:document>';

test('bounded archive reader supports stored/deflated members and validates a known CRC vector',()=>{
  assert.equal(officeCrc32(Buffer.from('123456789')),0xcbf43926);
  for(const compressed of [true,false]){const a=officeMembers(zip([['word/document.xml',xml]],compressed));assert.equal(a.length,1);assert.equal(a[0].read().toString(),xml);}
});
test('archive reader rejects traversal, duplicate names, encryption, corrupt CRC, split archives and inflated-size lies',()=>{
  assert.throws(()=>officeMembers(zip([['../outside','x']])));
  assert.throws(()=>officeMembers(zip([['word/document.xml','a'],['word/document.xml','b']])));
  const encrypted=zip([['word/document.xml',xml]]);encrypted.writeUInt16LE(1,6);assert.throws(()=>officeMembers(encrypted));
  const split=zip([['a','a']]);split.writeUInt16LE(1,split.length-18);assert.throws(()=>officeMembers(split));
  const damaged=zip([['a','abc']]);const directory=damaged.readUInt32LE(damaged.length-6);damaged.writeUInt32LE(0,directory+16);assert.throws(()=>officeMembers(damaged)[0].read());
  const bomb=zip([['a','X'.repeat(1000000)]]);const at=bomb.readUInt32LE(bomb.length-6);bomb.writeUInt32LE(3,at+24);assert.throws(()=>officeMembers(bomb)[0].read());
  assert.throws(()=>officeMembers(zip([['a','a']]).subarray(0,-2)));
});
test('Office project reads return only preview parts, refuse DTDs, secret aliases, external paths and oversize files',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'girru-office-')),folder=path.join(root,'project');await fs.mkdir(folder);t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(folder,'sample.docx'),zip([['word/document.xml',xml],['word/vbaProject.bin','not exposed'],['word/embeddings/active.bin','not exposed']]));
  const r=await readFolderOffice(folder,'sample.docx');assert.equal(r.kind,'docx');assert.deepEqual(r.parts,[{name:'word/document.xml',text:xml}]);assert.equal(JSON.stringify(r).includes('not exposed'),false);
  await fs.writeFile(path.join(folder,'entity.docx'),zip([['word/document.xml','<!DOCTYPE doc [<!ENTITY x SYSTEM "file:///private">]><doc>&x;</doc>']]));assert.equal((await readFolderOffice(folder,'entity.docx')).reason,'unsupported');
  await fs.writeFile(path.join(folder,'book.xlsx'),zip([['xl/workbook.xml','<workbook/>'],['xl/worksheets/sheet1.xml','<worksheet/>'],['xl/externalLinks/externalLink1.xml','not exposed']]));assert.deepEqual((await readFolderOffice(folder,'book.xlsx')).parts.map(x=>x.name),['xl/workbook.xml','xl/worksheets/sheet1.xml']);
  await fs.writeFile(path.join(folder,'.env'),'synthetic only');
  if(process.platform!=='win32'){
    await fs.symlink('.env',path.join(folder,'secret.docx'));assert.equal((await readFolderOffice(folder,'secret.docx')).reason,'hidden');
    await fs.writeFile(path.join(root,'outside.docx'),zip([['word/document.xml',xml]]));await fs.symlink('../outside.docx',path.join(folder,'outside.docx'));await assert.rejects(readFolderOffice(folder,'outside.docx'));
  }
  await assert.rejects(readFolderOffice(folder,'../outside.docx'));
  const huge=await fs.open(path.join(folder,'huge.docx'),'w');await huge.truncate(MAX_OFFICE_BYTES+1);await huge.close();assert.equal((await readFolderOffice(folder,'huge.docx')).reason,'too_large');
  await fs.writeFile(path.join(folder,'budget.docx'),zip([['word/document.xml','X'.repeat(2*1024*1024+1)]]));assert.equal((await readFolderOffice(folder,'budget.docx')).reason,'too_large');
});

test('PPTX previews expose slide XML and embedded raster data, not embedded programs', async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'girru-slide-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'deck.pptx'),zip([['ppt/presentation.xml','<presentation/>'],['ppt/slides/slide1.xml','<slide/>'],['ppt/slides/_rels/slide1.xml.rels','<Relationships/>'],['ppt/media/chart.png',Buffer.from([1,2,3])],['ppt/embeddings/object.bin','not exposed']]));
  const r=await readFolderOffice(root,'deck.pptx');assert.equal(r.kind,'pptx');assert.deepEqual(r.parts.map(x=>x.name),['ppt/presentation.xml','ppt/slides/slide1.xml','ppt/slides/_rels/slide1.xml.rels']);assert.equal(r.images[0].mime,'image/png');assert.equal(JSON.stringify(r).includes('not exposed'),false);
});
