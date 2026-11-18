require('./load.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');
const {officeTarget,columnLabel}=require('../src/office-content.ts');
const {allowedConversation,conversationResponse}=require('../src/conversation-contract.js');
const {fileKind}=require('../src/file-content.ts');
const id='0f8fad5b-d9cb-469f-a165-70867728950e';
test('Office relationships resolve package members only, never URLs or escape paths',()=>{
  assert.equal(officeTarget('word/document.xml','media/image1.png'),'word/media/image1.png');
  assert.equal(officeTarget('xl/workbook.xml','worksheets/sheet1.xml'),'xl/worksheets/sheet1.xml');
  assert.equal(officeTarget('xl/worksheets/sheet1.xml','../sharedStrings.xml'),'xl/sharedStrings.xml');
  for(const x of ['https://remote.invalid/a','//remote.invalid/a?x','../../escape','file:///secret','media/%2e%2e/x','x\\y'])assert.equal(officeTarget('word/document.xml',x),null);
  assert.equal(columnLabel(1),'A');assert.equal(columnLabel(26),'Z');assert.equal(columnLabel(27),'AA');assert.equal(columnLabel(100),'CV');
});
test('DOCX/XLSX use the existing file pane and bounded office wire; scripts and document MIME types cannot cross as images',()=>{
  assert.equal(fileKind('letter.DOCX'),'office');assert.equal(fileKind('book.xlsx'),'office');assert.notEqual(fileKind('old.doc'),'office');
  const path=`/api/chat/projects/${id}/office?path=letter.docx`;
  assert.equal(allowedConversation('GET',path),true);assert.equal(allowedConversation('POST',path),false);
  const payload={path:'letter.docx',kind:'docx',parts:[{name:'word/document.xml',text:'<document/>'}],images:[],truncated:false,extra:'stripped'};
  const clean=conversationResponse(path,200,payload);assert.equal(clean.extra,undefined);assert.deepEqual(conversationResponse(path,200,clean),clean);
  for(const patch of [{parts:[{name:'../secret',text:'x'}]},{parts:[{name:'word/document.xml',text:'<!DOCTYPE x><x/>'}]},{images:[{name:'word/media/a',mime:'text/html',base64:'YQ=='}]}])assert.throws(()=>conversationResponse(path,200,{...payload,...patch}));
});

test('PPTX follows the same bounded read-only file route',()=>{
 assert.equal(fileKind('deck.PPTX'),'office');
 const path=`/api/chat/projects/${id}/office?path=deck.pptx`;
 assert.equal(allowedConversation('GET',path),true);
 assert.equal(conversationResponse(path,200,{path:'deck.pptx',kind:'pptx',parts:[{name:'ppt/presentation.xml',text:'<presentation/>'}],images:[],truncated:false}).kind,'pptx');
});
