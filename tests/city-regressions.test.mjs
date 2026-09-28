import test from 'node:test';
import assert from 'node:assert/strict';
import { resolverMunicipioColombia } from '../src/autocomplete-biofile.js';
import { parseDocument } from '../src/nacionales/parser.js';
import { canonicalCity } from '../src/nacionales/normalize.js';

test('Cartago selects exact Colombian municipality, not foreign or compound names',()=>{
  const options=['CARTAGO (VALLE DEL CAUCA, COLOMBIA)','CARTAGO (COSTA RICA, CARTAGO)','SAN PEDRO DE CARTAGO (NARIÑO, COLOMBIA)'];
  assert.equal(resolverMunicipioColombia(options,'CARTAGO'),options[0]);
  assert.equal(resolverMunicipioColombia(options.slice(1),'CARTAGO'),'');
  assert.equal(resolverMunicipioColombia([...options,'CARTAGO (OTRO DEPARTAMENTO, COLOMBIA)'],'CARTAGO'),'');
});
test('city placeholders do not prevent extraction from an explicit exam location',()=>{
  assert.equal(canonicalCity('.:: NO APLICA ::.'),'');
  const c=parseDocument('CIUDAD DEL EXAMEN: NO APLICA\nREALIZADO EN: PEREIRA\nEXAMENES REALIZADOS\nAUDIOMETRIA');
  assert.equal(c.cityExam,'PEREIRA');
});
test('exam location in footer takes priority over residence elsewhere',()=>{
  const c=parseDocument('Ciudad residencia: BOGOTA\nRECOMENDACIONES GENERALES\nRealizado en: CARTAGO');
  assert.equal(c.cityExam,'CARTAGO');
});
test('verified location address identifies Pereira without a patient or filename rule',()=>{
  const c=parseDocument('Concepto de Aptitud Laboral\nCalle 19 N° 5-13 · Clínica Risaralda · Consultorio 803');
  assert.equal(c.cityExam,'PEREIRA');
  assert.equal(parseDocument('Clínica Risaralda').cityExam,'');
});
