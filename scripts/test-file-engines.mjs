import assert from 'node:assert/strict';
import { extractFile, validateFile } from '../src/nacionales/file-service.js';
// Synthetic document: validates the real Poppler/Tesseract pipeline without patient files.
const stream='BT /F1 22 Tf 50 750 Td (CIUDAD DEL EXAMEN: PEREIRA) Tj ET';
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
let pdf='%PDF-1.4\n', offsets=[0];
objects.forEach((body,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${body}\nendobj\n`;});
const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const bytes=Buffer.from(pdf), metadata=validateFile('synthetic.pdf','application/pdf',bytes);
const digital=await extractFile(bytes,metadata,()=>false);
assert.equal(digital.method,'pdf-text');assert.match(digital.text,/PEREIRA/);
const ocr=await extractFile(bytes,metadata,()=>true);
assert.equal(ocr.method,'pdf-text+ocr');assert.match(ocr.digitalText,/PEREIRA/);assert.match(ocr.text,/PEREIRA/i);
console.log('Poppler y OCR español: extracción real y conservación de texto digital verificadas.');
