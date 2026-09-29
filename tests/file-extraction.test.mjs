import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFile } from '../src/nacionales/file-service.js';
const pdf=Buffer.from('%PDF-synthetic');
const metadata={mime:'application/pdf'};
test('OCR failure preserves digital text, safe diagnostic, and review warning',async()=>{
  const result=await extractFile(pdf,metadata,()=>true,async command=>{
    if(command.endsWith('pdfinfo'))return {stdout:'Pages: 1'};
    if(command.endsWith('pdftotext'))return {stdout:'IDENTIDAD SINTETICA'};
    throw Object.assign(new Error('private stderr'),{cmd:'private command',killed:true});
  });
  assert.equal(result.text,'IDENTIDAD SINTETICA');
  assert.equal(result.method,'pdf-text-ocr-incomplete');
  assert.match(result.warnings[0],/tiempo.*convertir la página 1/);
  assert(!result.warnings[0].includes('private'));
});
test('image OCR failure remains an actionable error without clinical stderr',async()=>{
  await assert.rejects(extractFile(Buffer.from('synthetic'),{mime:'image/png'},()=>true,async()=>{
    throw Object.assign(new Error('private stderr'),{code:'ENOENT'});
  }),/No está disponible el motor para leer por OCR la página 1/);
});
test('blank supplementary OCR retains digital text with a warning',async()=>{
  const r=await extractFile(pdf,metadata,()=>true,async command=>({stdout:command.endsWith('pdfinfo')?'Pages: 1':command.endsWith('pdftotext')?'DIGITAL':''}));
  assert.equal(r.text,'DIGITAL');assert.equal(r.warnings.length,1);
});
test('OCR processes pages sequentially and keeps digital identity source separate',async()=>{
  const calls=[];
  const r=await extractFile(pdf,metadata,text=>!text.includes('OCR'),async(command,args)=>{
    calls.push([command,...args]);
    return {stdout:command.endsWith('pdfinfo')?'Pages: 2':command.endsWith('pdftotext')?'DIGITAL':command.endsWith('tesseract')?'OCR':''};
  });
  assert.equal(r.method,'pdf-text+ocr');assert.equal(r.digitalText,'DIGITAL');assert.equal(r.text,'OCR\nOCR\n');
  assert.deepEqual(calls.slice(2).map(c=>c[0]),['pdftoppm','tesseract','pdftoppm','tesseract']);
  assert.deepEqual(calls.filter(c=>c[0]==='pdftoppm').map(c=>c.slice(1,6)),[['-f','1','-l','1','-singlefile'],['-f','2','-l','2','-singlefile']]);
});
test('invalid page count fails before rendering',async()=>{
  let calls=0;
  await assert.rejects(extractFile(pdf,metadata,()=>true,async()=>{calls++;return {stdout:'Pages: 100'};}),/límite de páginas/);
  assert.equal(calls,1);
});

test('unresolved small footer gets a larger sparse OCR pass',async()=>{
  const calls=[];
  const result=await extractFile(pdf,metadata,text=>!text.includes('PEREIRA'),async(command,args)=>{
    calls.push([command,...args]);
    return {stdout:command.endsWith('pdfinfo')?'Pages: 1':command.endsWith('pdftotext')?'DIGITAL':command.endsWith('tesseract')?(args.includes('11')?'PEREIRA':'TEXTO') :''};
  });
  assert.match(result.text,/PEREIRA/);assert.equal(result.warnings.length,0);
  assert(calls.some(c=>c.includes('3300')));
  assert(calls.some(c=>c.includes('min_orientation_margin=0')));
});
