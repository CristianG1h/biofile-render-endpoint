import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, examList, repairStoredConcept } from '../src/nacionales/parser.js';
import { date, evaluation, splitNames, canonicalCity } from '../src/nacionales/normalize.js';
import { applyDefaults } from '../src/nacionales/defaults.js';
import { validateConcept } from '../src/nacionales/validators.js';
import { mapProducts, catalog, automaticProductMapping } from '../src/nacionales/product-mapper.js';
import { validateFile } from '../src/nacionales/file-service.js';
import { canRead, sanitizeEdit } from '../src/nacionales/index.js';
import { money, BiofileProducts, needsMinimumUnitPrice } from '../src/biofile-products.js';
import { textoBusquedaAutocomplete } from '../src/autocomplete-biofile.js';

test('product reconciliation checks exact product and quantity without changing BIOFILE commercial fields',()=>{
  assert.equal(money('64,500'),64500);assert.equal(money('$ 64.500,00'),64500);assert.equal(money('64,500.00'),64500);
  const p={cantidad:1,biofileProduct:'AUDIOMETRÍA'};
  const rows=[['1','AUDIOMETRÍA','Seleccione','64,500','CRÉDITO']];
  const products=new BiofileProducts({config:{selectors:{}}});
  assert(products.matches(rows,p));
  assert(!products.matches([['2','AUDIOMETRÍA','Seleccione','64,500','CRÉDITO']],p));
});
test('labelled digital certificate preserves identity and does not collect diagnoses',()=>{
  const c=parseDocument('CERTIFICADO HISTORIA CLINICA\nIDENTIFICACION DEL PACIENTE\nIdentificación: CC - 987654321\nPrimer Nombre: ANA\nPrimer Apellido: PRUEBA\nFecha de Nacimiento: 1990-01-02\nCiudad del Examen: MEDELLIN\nTIPO EXAMEN: PERIODICO\nEXAMENES REALIZADOS\nAUDIOMETRIA TAMIZ\nCONSENTIMIENTO INFORMADO\nRECOMENDACIONES GENERALES\nDiagnóstico privado');
  assert.equal(c.patient.numeroDocumento,'987654321');assert.equal(c.patient.primerNombre,'ANA');assert.equal(c.cityExam,'MEDELLÍN');assert.equal(c.employment.tipoEvaluacion,'PERIÓDICO');assert(!JSON.stringify(c).includes('Diagnóstico privado'));assert(!c.exams.includes('CONSENTIMIENTO INFORMADO'));
});
test('new structures use generic parser and missing identity stays missing',()=>{const c=parseDocument('Formato desconocido\nAUDIOMETRIA');assert.equal(c.templateDetected,'generic');assert.equal(c.patient.numeroDocumento,'');assert(validateConcept(c).length>0);});
test('normalization validates dates, named months, cities and evaluations',()=>{assert.equal(date('31/02/2000'),'');assert.equal(date('02/01/1990'),'1990-01-02');assert.equal(date('27/Sep/1989'),'1989-09-27');assert.equal(date('27 DE JULIO 2026'),'2026-07-27');assert.equal(canonicalCity('NOR. SANTANDER / CÚCUTA'),'CÚCUTA');assert.equal(canonicalCity('BARRANQUILLA (ATLÁNTICO, COLOMBIA)'),'BARRANQUILLA');assert.equal(evaluation('retiro'),'EGRESO');assert.equal(evaluation('PRE-INGRESO'),'INGRESO');assert.equal(evaluation('POST-INCAPACIDAD'),'POST INCAPACIDAD');assert.equal(evaluation('no identificado'),'');assert.equal(splitNames('ANA MARIA PRUEBA DEMO').primerApellido,'PRUEBA');});
test('controlled defaults complete Nacionales operational fields and mark estimates',()=>{const c=applyDefaults(parseDocument('Ciudad del Examen: CALI'));assert.equal(c.patient.numeroDocumento,'');assert.equal(c.patient.correo,'');assert.match(c.patient.fechaNacimiento,/^\d{4}-\d{2}-\d{2}$/);assert.equal(c.patient.municipioResidencia,'CALI');assert.equal(c.patient.ciudadNacimiento,'CALI');assert.equal(c.patient.genero,'MASCULINO');assert.equal(c.patient.estadoCivil,'SOLTERO(A)');assert.equal(c.patient.nivelEducativo,'SECUNDARIA');assert.equal(c.employment.tipoEvaluacion,'INGRESO');assert(c.autoFilledFields.some(f=>f.campo==='fechaNacimiento'));assert(c.autoFilledFields.some(f=>f.campo==='genero'));assert(c.autoFilledFields.some(f=>f.campo==='tipoEvaluacion'));assert.equal(c.employment.eps,'NO REFIERE');});
test('canonical exams exclude consent and preserve distinct visual tests',()=>{assert.deepEqual(examList('EXAMENES REALIZADOS\nAUDIOMETRIA TAMIZ\nVISIOMETRIA\nOPTOMETRIA\nCONSENTIMIENTO INFORMADO\nRECOMENDACIONES'),['AUDIOMETRÍA','VISIOMETRÍA','OPTOMETRÍA']);});
test('city product catalog maps Nacionales exams automatically',()=>{
  const cali=mapProducts({cityExam:'CALI',exams:['AUDIOMETRÍA','VISIOMETRÍA','OPTOMETRÍA','EXAMEN MÉDICO OCUPACIONAL']},[]);
  assert.equal(cali.errors.length,0);
  assert.deepEqual(cali.products.map(p=>p.productId),['207','163','184','179','2']);
  assert.equal(automaticProductMapping('CÚCUTA','AUDIOMETRÍA').productId,'492');
  assert.equal(automaticProductMapping('MEDELLÍN','EXAMEN MÉDICO OCUPACIONAL').productId,'699');
  assert.equal(automaticProductMapping('BUCARAMANGA','VISIOMETRÍA').productId,'702');
  assert.equal(automaticProductMapping('PEREIRA','EXAMEN MÉDICO OCUPACIONAL').productId,'408');
  const pereira=mapProducts({cityExam:'PEREIRA',exams:['AUDIOMETRÍA','VISIOMETRÍA','EXAMEN MÉDICO OCUPACIONAL']},[]);
  assert.deepEqual(pereira.products.map(p=>p.biofileProduct),['AUDIOMETRIA // PEREIRA','VISIOMETRIA // PEREIRA','ANEXO OSTEOMUSCULAR //PEREIRA','EXAMEN MEDICO OSTEOMUSCULAR // PEREIRA']);
  assert.equal(automaticProductMapping('SOPÓ','AUDIOMETRÍA').biofileProduct,'AUDIOMETRIA // SOPO');
  assert.equal(automaticProductMapping('SOPÓ','VISIOMETRÍA').biofileProduct,'VISIOMETRIA // SOPO');
  assert.equal(automaticProductMapping('SOPÓ','EXAMEN MÉDICO OCUPACIONAL').biofileProduct,'EXAMEN MEDICO OCUPACIONAL // SOPO');
  assert.equal(catalog.length,1008);
  assert.equal(new Set(catalog.map(p=>p.id)).size,1008);
});
test('file signatures, MIME, extension and duplicate hashes are enforced',()=>{const b=Buffer.from('%PDF-1.7 synthetic');const a=validateFile('../unsafe.pdf','application/pdf',b);assert.equal(a.sourceFile,'unsafe.pdf');assert.equal(a.fileHash,validateFile('copy.pdf','application/pdf',b).fileHash);assert.throws(()=>validateFile('bad.png','image/png',b));assert.throws(()=>validateFile('bad.exe','application/pdf',b));});
test('all roles can read own jobs, only superadmin can read another owner',()=>{for(const rol of ['user','admin','superadmin'])assert(canRead({id:'a',rol},{usuarioId:'a'}));assert(!canRead({id:'b',rol:'admin'},{usuarioId:'a'}));assert(canRead({id:'b',rol:'superadmin'},{usuarioId:'a'}));});
test('client cannot overwrite server identity, file hash or products',()=>{const source={id:'original',fileHash:'hash',patient:{numeroDocumento:'123456'},employment:{cargo:''}};const c=sanitizeEdit({id:'evil',fileHash:'evil',products:[{}],patient:{numeroDocumento:'999999',secret:'evil'},companyAgreement:'  CENTU  ',reviewed:true},source);assert.equal(c.id,'original');assert.equal(c.fileHash,'hash');assert.equal(c.patient.numeroDocumento,'999999');assert.equal(c.patient.secret,undefined);assert.equal(c.products,undefined);assert.equal(c.companyAgreement,'CENTU');});

test('worker-table does not confuse age with names and derives birth date',()=>{const c=parseDocument('CONCEPTO MÉDICO OCUPACIONAL PERIODICO\nFECHA Y CIUDAD DE REALIZACIÓN DEL EXÁMEN\nBARRANQUILLA (ATLÁNTICO, COLOMBIA)\n30       07       2026\nDATOS DEL TRABAJADOR / ASPIRANTE\nApellidos y Nombres                                                   Género                   Edad                      Documento de Identificación\n\n32 AÑOS 11           CC                  1101817403\nESPINOZA CAUSADO BAIRON JOSE                                                       MASCULINO                 MESES 0 DÍAS\nCargo\nASESOR DE VENTAS\nEPS                                                                 AFP                                                                 ARL\nMUTUALSER                                                         COLPENSIONES                                                                  SURA\nCONCEPTO DE APTITUD\nEXAMENES REALIZADOS\nAUDIOMETRIA TAMIZ VISIOMETRIA EXAMEN MEDICO OCUPACIONAL');assert.equal(c.patient.numeroDocumento,'1101817403');assert.equal(c.patient.primerNombre,'BAIRON');assert.equal(c.patient.segundoNombre,'JOSE');assert.equal(c.patient.primerApellido,'ESPINOZA');assert.equal(c.patient.segundoApellido,'CAUSADO');assert.equal(c.patient.fechaNacimiento,'1993-08-30');assert.equal(c.patient.genero,'MASCULINO');assert.equal(c.cityExam,'BARRANQUILLA');assert.equal(c.employment.cargo,'ASESOR DE VENTAS');assert.equal(c.employment.tipoEvaluacion,'PERIÓDICO');});
test('Cali named-month format extracts patient and city',()=>{const c=parseDocument('CONCEPTO MEDICO OCUPACIONAL CON ENFASIS OSTEOMUSCULAR PERIODICO\nFecha: 28/Jul/2026                                                      Edad: 36 años\nApellido: CARMONA CHACON                                                Nombre: DIEGO ALEJANDRO\nTipo Doc: CC                     Nro Identidad: 1143928053              Sexo: Masculino\nNacim: 27/Sep/1989\nEstado Civil: UNION LIBRE        EPS: COMFENALCO                        ARL:                      AFP: PORVENIR\nCargo: ASESOR DE VENTAS                                                 Ciudad: CALI -VALLE\nEXAMENES REALIZADOS\nAUDIOMETRIA TAMIZ VISIOMETRIA EXAMEN MEDICO OCUPACIONAL');assert.equal(c.patient.fechaNacimiento,'1989-09-27');assert.equal(c.patient.primerNombre,'DIEGO');assert.equal(c.patient.segundoNombre,'ALEJANDRO');assert.equal(c.patient.primerApellido,'CARMONA');assert.equal(c.patient.segundoApellido,'CHACON');assert.equal(c.cityExam,'CALI');});

test('stored worker-table identities corrupted by age are repaired from filename',()=>{
  const old={templateDetected:'worker-table',sourceFile:'BERMEJO CARO OMAR HABIB.pdf',reviewed:true,patient:{primerNombre:'10',segundoNombre:'28',primerApellido:'AÑOS',segundoApellido:''},autoFilledFields:[],warnings:[]};
  const c=repairStoredConcept(old);
  assert.equal(c.patient.primerNombre,'OMAR');
  assert.equal(c.patient.segundoNombre,'HABIB');
  assert.equal(c.patient.primerApellido,'BERMEJO');
  assert.equal(c.patient.segundoApellido,'CARO');
  assert.equal(c.reviewed,false);
  assert(c.warnings.some(x=>/Identidad recuperada/i.test(x)));
});
test('stored worker-table filename supports compound given names',()=>{
  const old={templateDetected:'worker-table',sourceFile:'DIAZ ROCHA MARIA DE LOS ANGELES-CONCEPTO MEDICO.pdf',patient:{primerNombre:'7',segundoNombre:'24',primerApellido:'AÑOS',segundoApellido:''},autoFilledFields:[],warnings:[]};
  const c=repairStoredConcept(old);
  assert.equal(c.patient.primerNombre,'MARIA');
  assert.equal(c.patient.segundoNombre,'DE LOS ANGELES');
  assert.equal(c.patient.primerApellido,'DIAZ');
  assert.equal(c.patient.segundoApellido,'ROCHA');
});

test('source workflow creates the order before checking product controls',async()=>{
  const fs=await import('node:fs/promises');
  const source=await fs.readFile(new URL('../src/nacionales/processing-service.js',import.meta.url),'utf8');
  const fill=source.indexOf('client.llenarOrden');
  const save=source.indexOf('client.guardarYCerrarExito()',fill);
  const order=source.indexOf("etapa: 'Orden creada'",save);
  const products=source.indexOf('products.available({ timeoutMs: 20000 })',order);
  assert(fill>=0&&save>fill&&order>save&&products>order,'Nacionales debe crear la O.S. antes de validar/agregar productos');
});

test('product autocomplete searches the full name and city to avoid truncated suggestion lists',()=>{
  assert.equal(textoBusquedaAutocomplete('Nombre del Producto o Servicio','EXAMEN MEDICO OCUPACIONAL // CARTAGENA'),'EXAMEN MEDICO OCUPACIONAL // CARTAGENA');
  assert.equal(textoBusquedaAutocomplete('Nombre del Producto o Servicio','AUDIOMETRIA // CUCUTA'),'AUDIOMETRIA // CUCUTA');
  assert.equal(textoBusquedaAutocomplete('Nombre del Producto o Servicio','VISIOMETRIA // MEDELLIN'),'VISIOMETRIA // MEDELLIN');
  assert.equal(textoBusquedaAutocomplete('Nombre del Producto o Servicio','OPTOMETRIA // CALI'),'OPTOMETRIA // CALI');
});

test('generic city inference identifies Pereira without requiring a labelled city field',()=>{
  const c=parseDocument('CENTRO MEDICO OCUPACIONAL PEREIRA\nPaciente: PRUEBA TEST\nCC 123456789\nEXAMENES REALIZADOS\nAUDIOMETRIA\nVISIOMETRIA\nEXAMEN MEDICO OCUPACIONAL\nRECOMENDACIONES');
  assert.equal(c.cityExam,'PEREIRA');
});

test('missing city does not create repeated product mapping warnings',()=>{
  const result=mapProducts({cityExam:'',exams:['AUDIOMETRÍA','VISIOMETRÍA','EXAMEN MÉDICO OCUPACIONAL']},[]);
  assert.deepEqual(result.products,[]);
  assert.deepEqual(result.errors,[]);
});

test('zero unit price must be corrected before saving any BIOFILE product',()=>{
  assert.equal(needsMinimumUnitPrice('0'),true);
  assert.equal(needsMinimumUnitPrice('0,00'),true);
  assert.equal(needsMinimumUnitPrice(''),true);
  assert.equal(needsMinimumUnitPrice('1'),false);
  assert.equal(needsMinimumUnitPrice('24,700'),false);
});
test('product workflow only forces Vr. Unitario when BIOFILE leaves it at zero',async()=>{
  const fs=await import('node:fs/promises');
  const source=await fs.readFile(new URL('../src/biofile-products.js',import.meta.url),'utf8');
  const select=source.indexOf('seleccionarProductoExacto');
  const unit=source.indexOf('#ensurePositiveUnitPrice(cells)',select);
  const save=source.indexOf("activity('Guardando producto en BIOFILE'",unit);
  assert(select>=0&&unit>select&&save>unit,'Vr. Unitario debe validarse después de seleccionar el producto y antes de guardarlo');
  assert(source.includes("await unit.fill('1')"));
  assert(source.includes('Prestador y Forma de Pago se conservan'));
});
