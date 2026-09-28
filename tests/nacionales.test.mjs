import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, examList } from '../src/nacionales/parser.js';
import { date, evaluation, splitNames } from '../src/nacionales/normalize.js';
import { applyDefaults } from '../src/nacionales/defaults.js';
import { validateConcept } from '../src/nacionales/validators.js';
import { mapProducts, catalog } from '../src/nacionales/product-mapper.js';
import { validateFile } from '../src/nacionales/file-service.js';
import { canRead, sanitizeEdit } from '../src/nacionales/index.js';
import { money, BiofileProducts } from '../src/biofile-products.js';

test('product reconciliation checks configured prices across display formats',()=>{
  assert.equal(money('64,500'),64500);assert.equal(money('$ 64.500,00'),64500);assert.equal(money('64,500.00'),64500);
  const p={cantidad:1,biofileProduct:'AUDIOMETRÍA',prestador:'No Aplica',formaPago:'CONTADO',valor:64500};
  const rows=[['1','AUDIOMETRÍA','No Aplica','64,500','CONTADO']];
  const products=new BiofileProducts({config:{selectors:{}}});assert(products.matches(rows,p));assert(!products.matches(rows,{...p,valor:100}));
});
test('labelled digital certificate preserves identity and does not collect diagnoses',()=>{
  const c=parseDocument('CERTIFICADO HISTORIA CLINICA\nIDENTIFICACION DEL PACIENTE\nIdentificación: CC - 987654321\nPrimer Nombre: ANA\nPrimer Apellido: PRUEBA\nFecha de Nacimiento: 1990-01-02\nCiudad del Examen: MEDELLIN\nTIPO EXAMEN: PERIODICO\nEXAMENES REALIZADOS\nAUDIOMETRIA TAMIZ\nCONSENTIMIENTO INFORMADO\nRECOMENDACIONES GENERALES\nDiagnóstico privado');
  assert.equal(c.patient.numeroDocumento,'987654321');assert.equal(c.patient.primerNombre,'ANA');assert.equal(c.cityExam,'MEDELLIN');assert.equal(c.employment.tipoEvaluacion,'PERIÓDICO');assert(!JSON.stringify(c).includes('Diagnóstico privado'));assert(!c.exams.includes('CONSENTIMIENTO INFORMADO'));
});
test('new structures use generic parser and missing identity stays missing',()=>{const c=parseDocument('Formato desconocido\nAUDIOMETRIA');assert.equal(c.templateDetected,'generic');assert.equal(c.patient.numeroDocumento,'');assert(validateConcept(c).length>0);});
test('normalization validates dates and distinguishes evaluations',()=>{assert.equal(date('31/02/2000'),'');assert.equal(date('02/01/1990'),'1990-01-02');assert.equal(evaluation('retiro'),'EGRESO');assert.equal(evaluation('PRE-INGRESO'),'INGRESO');assert.equal(evaluation('POST-INCAPACIDAD'),'POST INCAPACIDAD');assert.equal(evaluation('no identificado'),'');assert.equal(splitNames('ANA MARIA PRUEBA DEMO').primerApellido,'PRUEBA');});
test('controlled defaults never invent identity and annotate birth city',()=>{const c=applyDefaults(parseDocument('Ciudad del Examen: CALI'));assert.equal(c.patient.numeroDocumento,'');assert.equal(c.patient.correo,'');assert.equal(c.patient.ciudadNacimiento,'CALI');assert(c.autoFilledFields.some(f=>f.campo==='ciudadNacimiento'));assert.equal(c.employment.eps,'NO REFIERE');});
test('canonical exams exclude consent and preserve distinct visual tests',()=>{assert.deepEqual(examList('EXAMENES REALIZADOS\nAUDIOMETRIA TAMIZ\nVISIOMETRIA\nOPTOMETRIA\nCONSENTIMIENTO INFORMADO\nRECOMENDACIONES'),['AUDIOMETRÍA','VISIOMETRÍA','OPTOMETRÍA']);});
test('unmapped products block submission',()=>{assert.equal(mapProducts({cityExam:'CALI',exams:['AUDIOMETRÍA']},[]).errors.length,1);assert.equal(catalog.length,1008);assert.equal(new Set(catalog.map(p=>p.id)).size,1008);});
test('file signatures, MIME, extension and duplicate hashes are enforced',()=>{const b=Buffer.from('%PDF-1.7 synthetic');const a=validateFile('../unsafe.pdf','application/pdf',b);assert.equal(a.sourceFile,'unsafe.pdf');assert.equal(a.fileHash,validateFile('copy.pdf','application/pdf',b).fileHash);assert.throws(()=>validateFile('bad.png','image/png',b));assert.throws(()=>validateFile('bad.exe','application/pdf',b));});
test('all roles can read own jobs, only superadmin can read another owner',()=>{for(const rol of ['user','admin','superadmin'])assert(canRead({id:'a',rol},{usuarioId:'a'}));assert(!canRead({id:'b',rol:'admin'},{usuarioId:'a'}));assert(canRead({id:'b',rol:'superadmin'},{usuarioId:'a'}));});
test('client cannot overwrite server identity, file hash or products',()=>{const source={id:'original',fileHash:'hash',patient:{numeroDocumento:'123456'},employment:{cargo:''}};const c=sanitizeEdit({id:'evil',fileHash:'evil',products:[{}],patient:{numeroDocumento:'999999',secret:'evil'},reviewed:true},source);assert.equal(c.id,'original');assert.equal(c.fileHash,'hash');assert.equal(c.patient.numeroDocumento,'999999');assert.equal(c.patient.secret,undefined);assert.equal(c.products,undefined);});
