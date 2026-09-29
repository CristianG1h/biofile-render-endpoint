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

test('scanned diagnostic table keeps exam city separate from residence and labels out of identity',()=>{
  const c=parseDocument(`CONCEPTO DE APTITUD
TIPO DE EXAMEN: PERIODICO FECHA HORA EXAMEN: 27/07/2026 08:17:43 AM CIUDAD: SOPO
IDENTIFICACION DEL ASPIRANTE O TRABAJADOR
Nombre: PEREZ GOMEZ JUAN CARLOS Identificación: CC 123456789 Edad: 37 Sexo: M
Cargo: ASESOR COMERCIAL Sección: OPERATIVA F.Nacimiento:01/03/1989
Dirección Actual: CALLE PRUEBA Teléfono: 3001234567 Ciudad Residencia: TOCANCIPA
Estado Civil: Soltero (a) EPS:SANITAS Tipo de Usuario: SUBSIDIADO
AYUDAS DIAGNOSTICAS
EX.OSTEOMUSCULAR 27/07/2026 SIN ALTERACION
OPTOMETRIA 27/07/2026
AUDIOMETRIA 27/07/2026
RECOMENDACIONES GENERALES`);
  assert.equal(c.templateDetected,'diagnostic-aids');assert.equal(c.cityExam,'SOPÓ');
  assert.equal(c.patient.primerNombre,'JUAN');assert.equal(c.patient.segundoNombre,'CARLOS');
  assert.equal(c.patient.primerApellido,'PEREZ');assert.equal(c.patient.numeroDocumento,'123456789');
  assert.equal(c.patient.municipioResidencia,'TOCANCIPA');assert.equal(c.patient.fechaNacimiento,'1989-03-01');
  assert.equal(c.employment.cargo,'ASESOR COMERCIAL');assert.equal(c.examDate,'2026-07-27');
  assert.deepEqual(c.exams,['AUDIOMETRÍA','OPTOMETRÍA','EXAMEN MÉDICO OCUPACIONAL']);
});

test('blank clinical city cannot become the following section title',()=>{
  const c=parseDocument('CONCEPTO MEDICO OCUPACIONAL CON ENFASIS\nApellido: PRUEBA\nCiudad: .:: No Aplica ::.\nIPS que Atendio: , Ciudad de Atención:\nAYUDA DIAGNOSTICA\nExamenes Realizados\nAUDIOMETRIA');
  assert.equal(c.cityExam,'');
});
