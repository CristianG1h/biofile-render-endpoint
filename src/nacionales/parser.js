import { clean, norm, date, evaluation, splitNames, approximateBirthDate, canonicalCity } from './normalize.js';
import { detectTemplate } from './template-detector.js';
const fields = {
  primerNombre: ['PRIMER NOMBRE'], segundoNombre: ['SEGUNDO NOMBRE', 'OTROS NOMBRES'],
  primerApellido: ['PRIMER APELLIDO'], segundoApellido: ['SEGUNDO APELLIDO'],
  fullName: ['APELLIDOS Y NOMBRES', 'NOMBRES Y APELLIDOS', 'PACIENTE', 'NOMBRE'],
  birth: ['FECHA DE NACIMIENTO', 'FECHA NACIMIENTO', 'F.NACIMIENTO', 'NACIMIENTO'],
  genero: ['SEXO', 'GENERO'], estadoCivil: ['ESTADO CIVIL'], nivelEducativo: ['ESCOLARIDAD', 'NIVEL EDUCATIVO'],
  correo: ['CORREO ELECTRONICO', 'CORREO', 'EMAIL'], direccion: ['DIRECCION ACTUAL', 'DIRECCION'],
  barrio: ['BARRIO'], municipioResidencia: ['CIUDAD RESIDENCIA', 'MUNICIPIO RESIDENCIA', 'RESIDENCIA'],
  ciudadNacimiento: ['CIUDAD DE NACIMIENTO', 'LUGAR DE NACIMIENTO'], celular: ['CELULAR', 'TELEFONO', 'TELEFONOS'],
  cargo: ['CARGO', 'OCUPACION'], eps: ['EPS'], afp: ['AFP', 'FONDO DE PENSIONES'], arl: ['ARL'],
  examType: ['TIPO DE EVALUACION', 'TIPO DE EXAMEN', 'TIPO EXAMEN'],
  cityExam: ['CIUDAD DE ATENCION', 'CIUDAD DEL EXAMEN', 'DPTO/CIUDAD DE ATENCION', 'CIUDAD DE REALIZACION', 'LUGAR DE ATENCION', 'LUGAR DE REALIZACION', 'REALIZADO EN'],
  empresa: ['EMPRESA EN MISION', 'EMPRESA']
};
const fold = t => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
function readFields(text) {
  const result = {}, lines = text.split(/\r?\n/);
  // Read the patient section, never a doctor signature or clinical recommendations.
  for (const [key, labels] of Object.entries(fields)) {
    for (const line of lines) {
      const upper = fold(line);
      for (const label of labels) {
        const pattern = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = new RegExp('(?:^|\\s{2,})' + pattern + '\\s*:?\\s+(.+)$').exec(upper);
        if (!match) continue;
        const value = line.slice(match.index + match[0].length - match[1].length).split(/\s{2,}/)[0].trim();
        if (value && value.length <= 150 && !/^(DATOS|NIT|IDENTIFICACION DEL|FIRMA)/.test(fold(value))) { result[key] = value; break; }
      }
      if (result[key]) break;
    }
  }
  return result;
}

function first(text, rx, group=1) {
  const m=String(text||'').match(rx);
  return m ? clean(m[group]) : '';
}
function nextNonEmpty(lines,start,limit=4) {
  for(let i=start;i<Math.min(lines.length,start+limit);i++) if(lines[i].trim()) return lines[i];
  return '';
}
function normalizeGender(value) {
  const n=norm(value);
  if(['M','MASCULINO','HOMBRE'].includes(n)) return 'MASCULINO';
  if(['F','FEMENINO','MUJER'].includes(n)) return 'FEMENINO';
  if(['OTRO','INDETERMINADO'].includes(n)) return 'INDETERMINADO';
  return '';
}
function parseExamDate(text) {
  const candidates=[
    /FECHA DE ATENCI[ÓO]N:\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/i,
    /FECHA EXAMEN:\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/i,
    /FECHA INGRESO:\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/i,
    /FECHA APERTURA:\s*(\d{8})/i,
    /FECHA\s*:\s*(\d{1,2}\/[A-Za-zÁÉÍÓÚÑáéíóúñ]+\/\d{4})/i,
    /FECHA\s+(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /FECHA DE REALIZACION DEL EXAMEN:\s*[\r\n]+\s*(\d{1,2}\s+DE\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+\s+\d{4})/i
  ];
  for(const rx of candidates){const m=text.match(rx),d=m&&date(m[1]);if(d)return d;}
  const header=text.split(/\r?\n/).slice(0,12).join('\n');
  const m=header.match(/^\s*(\d{1,2})\s{2,}(\d{1,2})\s{2,}(\d{4})\b/m);
  return m ? date(m[1]+'/'+m[2]+'/'+m[3]) : '';
}
function parseAge(value) {
  const n=fold(value);
  const m=n.match(/(\d{1,3})\s*ANOS?(?:\s+(\d{1,2})\s*MESES?)?(?:\s+(\d{1,2})\s*DIAS?)?/);
  return m ? {years:Number(m[1]),months:Number(m[2]||0),days:Number(m[3]||0)} : null;
}

const SUPPORTED_EXAM_CITIES = [
  ['BARRANQUILLA','BARRANQUILLA'],['BUCARAMANGA','BUCARAMANGA'],['VILLAVICENCIO','VILLAVICENCIO'],
  ['SANTA MARTA','SANTA MARTA'],['VALLEDUPAR','VALLEDUPAR'],['CARTAGENA','CARTAGENA'],
  ['MANIZALES','MANIZALES'],['MEDELLIN','MEDELLÍN'],['MONTERIA','MONTERÍA'],['CUCUTA','CÚCUTA'],
  ['BOGOTA','BOGOTÁ'],['PEREIRA','PEREIRA'],['CARTAGO','CARTAGO'],['CALI','CALI'],['TUNJA','TUNJA'],['SOPO','SOPÓ']
];
function inferSupportedExamCity(text) {
  const n=norm(text);
  const found=[];
  for(const [key,label] of SUPPORTED_EXAM_CITIES) {
    if(new RegExp('(?:^|\\s)'+key.replace(/ /g,'\\s+')+'(?:\\s|$)').test(n) && !found.includes(label)) found.push(label);
  }
  return found.length===1 ? found[0] : '';
}
const GIVEN_NAMES=new Set(['JUAN','JOSE','LUIS','CARLOS','DANIEL','ALEJANDRO','SANTIAGO','CAMILO','JHON','JHONNATAN','JONATHAN','HEVER','NICOLAS','MARIA','ANA','LAURA','DANIELA','CAMILA','ANDREA','PAOLA','VALENTINA','JULIANA','CAROLINA','ALEJANDRA','GABRIELA','SEBASTIAN','ANDRES','FELIPE','DAVID','MIGUEL','OMAR','ALEXIS','STIVEN','KEVIN']);
function splitWorkerName(value) {
  const parts=clean(value).split(' ').filter(Boolean);
  if(parts.length===3 && GIVEN_NAMES.has(norm(parts[1])) && GIVEN_NAMES.has(norm(parts[2]))) {
    return {primerApellido:parts[0],segundoApellido:'',primerNombre:parts[1],segundoNombre:parts[2]};
  }
  return splitNames(value,true);
}

function identityLooksCorrupt(patient={}) {
  const fields=['primerNombre','segundoNombre','primerApellido','segundoApellido'];
  const values=fields.map(k=>clean(patient[k])).filter(Boolean);
  if (!clean(patient.primerNombre) || !clean(patient.primerApellido)) return true;
  return values.some(v => /^\d+$/.test(v) || /\bAÑOS?\b/i.test(v) || /^(MESES?|D[IÍ]AS?)$/i.test(v));
}

export function repairStoredConcept(concept) {
  const c=structuredClone(concept || {});
  const p=c.patient ||= {};
  if (c.templateDetected!=='worker-table' || !identityLooksCorrupt(p) || !c.sourceFile) return c;
  let base=String(c.sourceFile)
    .replace(/\.[^.]+$/,'')
    .replace(/[ _-]+CONCEPTO(?:[ _-]+M[EÉ]DICO)?(?:[ _-].*)?$/i,'')
    .replace(/[ _-]+CERTIFICADO(?:[ _-].*)?$/i,'')
    .trim();
  if (!/^[\p{L} .'-]+$/u.test(base) || base.split(/\s+/).length < 3) return c;
  const repaired=splitWorkerName(base);
  if (!repaired.primerNombre || !repaired.primerApellido || identityLooksCorrupt(repaired)) return c;
  for (const k of ['primerNombre','segundoNombre','primerApellido','segundoApellido']) p[k]=clean(repaired[k]);
  c.autoFilledFields=(c.autoFilledFields||[]).filter(f=>!['primerNombre','segundoNombre','primerApellido','segundoApellido'].includes(f.campo));
  for (const k of ['primerNombre','segundoNombre','primerApellido','segundoApellido']) {
    if (p[k]) c.autoFilledFields.push({campo:k,valor:p[k],motivo:'Identidad recuperada del nombre del archivo porque una extracción anterior mezcló la edad con los nombres. Confirme antes de enviar.'});
  }
  c.warnings=[...(c.warnings||[]).filter(w=>!/identidad recuperada/i.test(w)),'Identidad recuperada del nombre del archivo. Confirme nombres y apellidos antes de enviar.'];
  c.reviewed=false;
  return c;
}
function setName(patient,value,surnameFirst=false,worker=false) {
  const parsed=worker?splitWorkerName(value):splitNames(value,surnameFirst);
  for(const k of ['primerNombre','segundoNombre','primerApellido','segundoApellido']) if(parsed[k]!==undefined) patient[k]=clean(parsed[k]);
}
export function examList(text) {
  const n=norm(text),exams=[];
  const section=n.match(/(?:EXAMENES REALIZADOS|EXAMENES PRACTICADOS|AYUDAS DIAGNOSTICAS|PRUEBAS DE APOYO DIAGNOSTICO|EXAMENES COMPLEMENTARIOS|PARACLINICOS REVISADOS|PARACLINICOS)([\s\S]*?)(?:RECOMENDACIONES|CONCEPTO DE APTITUD|CONCEPTO GENERAL|CERTIFICACION DE APTITUD|OBSERVACIONES|$)/)?.[1];
  const source=section||n.split(/RECOMENDACIONES|CONSENTIMIENTO|FIRMA/)[0];
  for(const [name,rx] of [
    ['AUDIOMETRÍA',/AUDIOMETR/],['VISIOMETRÍA',/VISIOMETR/],['OPTOMETRÍA',/OPTOMETR/],
    ['EXAMEN MÉDICO OCUPACIONAL',/EXAMEN (?:MEDICO|FISICO)|VALORACION MEDICA OCUPACIONAL|EVALUACION MEDICA OCUPACIONAL/],
    ['ESPIROMETRÍA',/ESPIROMETR/],['ELECTROCARDIOGRAMA',/ELECTROCARDIOGRAMA/]
  ]) if(rx.test(source)) exams.push(name);
  if(!exams.includes('EXAMEN MÉDICO OCUPACIONAL') && /(?:CERTIFICADO|CONCEPTO|INFORME) MEDICO.*(?:OCUPACIONAL|APTITUD)/.test(n)) exams.push('EXAMEN MÉDICO OCUPACIONAL');
  return exams;
}
export function parseDocument(text) {
  const templateDetected=detectTemplate(text);
  const head=text.split(/RECOMENDACIONES GENERALES|FIRMA DEL|ATENDIDO POR/i)[0];
  const lines=head.split(/\r?\n/),f=readFields(head),warnings=[],fieldConfidence={},autoFilledFields=[];
  const patient=Object.fromEntries(['tipoDocumento','numeroDocumento','primerNombre','segundoNombre','primerApellido','segundoApellido','fechaNacimiento','genero','estadoCivil','nivelEducativo','correo','direccion','barrio','municipioResidencia','ciudadNacimiento','celular'].map(k=>[k,clean(f[k])]));
  let age=parseAge(head),examDate=parseExamDate(head);

  let identity=fold(head).match(/(?:IDENTIFICACION|IDENTIDAD|DOCUMENTO|\bID)\s*:?\s*(CC|CE|TI|PT|PA|PEP|PPT|RC)\s*[-.:]?\s*([\d.]{5,16})/);
  if(!identity) identity=fold(head).match(/IDENTIFICACION\s*:\s*(CC|CE|TI|PT|PA|PEP|PPT|RC)\s+NUMERO\s*:\s*([\d.]{5,16})/);
  if(identity){patient.tipoDocumento=identity[1];patient.numeroDocumento=identity[2].replace(/\D/g,'');}

  if(templateDetected==='worker-table'){
    const ix=lines.findIndex(l=>/Apellidos y Nombres/i.test(l)),block=ix>=0?lines.slice(ix+1,ix+7):[];
    const idLine=block.find(l=>/\b(CC|CE|TI|PT|PA|PEP|PPT|RC)\b\s+\d{5,15}\b/i.test(l))||'';
    const nameLine=block.find(l=>/\b(MASCULINO|FEMENINO)\b/i.test(l))||'';
    const im=idLine.match(/\b(CC|CE|TI|PT|PA|PEP|PPT|RC)\b\s+(\d{5,15})\b/i);
    if(im){patient.tipoDocumento=im[1].toUpperCase();patient.numeroDocumento=im[2];}
    const nm=nameLine.match(/^\s*(.*?)\s{2,}(MASCULINO|FEMENINO)\b/i);
    if(nm){f.fullName=clean(nm[1]);patient.genero=normalizeGender(nm[2]);setName(patient,f.fullName,true,true);}
    const ay=idLine.match(/(\d{1,3})\s*AÑOS(?:\s+(\d{1,2}))?/i),md=nameLine.match(/MESES\s+(\d{1,2})\s+D[IÍ]AS/i);
    if(ay) age={years:Number(ay[1]),months:Number(ay[2]||0),days:Number(md?.[1]||0)};
    const cityIx=lines.findIndex(l=>/FECHA Y CIUDAD DE REALIZACI/i.test(l));
    for(let i=cityIx+1;i>=0&&i<Math.min(lines.length,cityIx+5);i++) if(/\([^)]+COLOMBIA/i.test(lines[i])){f.cityExam=canonicalCity(lines[i]);break;}
    const ins=lines.findIndex(l=>/EPS\s{2,}AFP\s{2,}ARL/.test(l));
    if(ins>=0){const v=nextNonEmpty(lines,ins+1,3).trim().split(/\s{2,}/).map(clean);[f.eps,f.afp,f.arl]=v;}
    const ci=lines.findIndex(l=>/^\s*Cargo\s*$/i.test(l));if(ci>=0)f.cargo=clean(nextNonEmpty(lines,ci+1,3));
    f.examType=evaluation(head.slice(0,1800));
  }

  if(templateDetected==='osteomuscular-sections'){
    const line=lines.find(l=>/Apellido:\s*/i.test(l)&&/\s{2,}Nombre:\s*/i.test(l))||'',m=line.match(/Apellido:\s*(.*?)\s{2,}Nombre:\s*(.*?)\s*$/i);
    if(m){const ap=clean(m[1]).split(' '),no=clean(m[2]).split(' ');patient.primerNombre=no[0]||'';patient.segundoNombre=no.slice(1).join(' ');patient.primerApellido=ap[0]||'';patient.segundoApellido=ap.slice(1).join(' ');}
    const id=head.match(/Tipo Doc:\s*(CC|CE|TI|PA|PPT)\s+Nro Identidad:\s*([\d.]+)/i);if(id){patient.tipoDocumento=id[1].toUpperCase();patient.numeroDocumento=id[2].replace(/\D/g,'');}
    f.birth=first(head,/Nacim:\s*([^\s]+)/i);f.genero=first(head,/Sexo:\s*([A-Za-zÁÉÍÓÚÑáéíóúñ]+)/i);
    const civil=head.match(/Estado Civil:\s*(.*?)\s{2,}EPS:\s*(.*?)\s{2,}ARL:\s*(.*?)\s{2,}AFP:\s*(.*?)\s*$/im);
    if(civil){f.estadoCivil=clean(civil[1]);f.eps=clean(civil[2]);f.arl=clean(civil[3]);f.afp=clean(civil[4]);}
    const cc=head.match(/Cargo:\s*(.*?)\s{2,}Ciudad:\s*([^\n]+)/i);if(cc){f.cargo=clean(cc[1]);f.cityExam=canonicalCity(cc[2]);}
  }

  if(templateDetected==='compact-aptitude'){
    const line=lines.find(l=>/^\s*(CC|CE|TI|PT|PA|PEP|PPT)\s+\d{5,15}\s{2,}/.test(l))||'',m=line.match(/^\s*(CC|CE|TI|PT|PA|PEP|PPT)\s+(\d{5,15})\s{2,}(.+)$/);
    if(m){patient.tipoDocumento=m[1];patient.numeroDocumento=m[2];f.fullName=m[3].split(/\s{2,}/)[0];setName(patient,f.fullName,false);}
    const ai=lines.findIndex(l=>/EDAD:/i.test(l));if(ai>=0)age=parseAge(nextNonEmpty(lines,ai+1,2))||age;
    const ati=lines.findIndex(l=>/ATENCI[ÓO]N:/i.test(l));if(ati>=0){const dm=nextNonEmpty(lines,ati+1,2).match(/(\d{4}-\d{2}-\d{2})\s*$/);if(dm)examDate=date(dm[1]);}
    const ti=lines.findIndex(l=>/TIPO DE CITA:/i.test(l)&&/OCUPACI[ÓO]N:/i.test(l));if(ti>=0){const v=nextNonEmpty(lines,ti+1,2).trim().split(/\s{2,}/).map(clean);f.examType=v[0]||'';f.cargo=v[1]||'';}
    f.direccion=first(head,/DIRECCI[ÓO]N:\s*[\r\n]+\s*([^\n]+)/i);
  }

  if(templateDetected==='clinical-certificate'){
    f.fullName=first(head,/Nombres y Apellidos:\s*(.*?)\s{2,}/i);setName(patient,f.fullName,false);
    f.birth=first(head,/Fecha de Nacimiento:\s*([0-9\/-]+)/i);f.genero=first(head,/G[ée]nero:\s*([A-Za-z]+)/i);
    f.estadoCivil=first(head,/Estado civil:\s*(.*?)\s{2,}/i);f.nivelEducativo=first(head,/Escolaridad:\s*(.*?)\s{2,}/i);
    const city=first(head,/Departamento:\s*.*?\s{2,}Ciudad:\s*([^\n]+)/i);if(city){f.municipioResidencia=canonicalCity(city);f.cityExam=canonicalCity(city);}
    f.cargo=first(head,/CARGO:\s*(.*?)\s{2,}FECHA EXAMEN:/i);f.examType=first(head,/TIPO EXAMEN:\s*(.*?)\s{2,}ENFASIS:/i);
  }

  if(templateDetected==='patient-admission'){
    const m=head.match(/Identificaci[óo]n:\s*(CC|CE|TI|PT|PA|PEP|PPT)\s*-\s*(\d{5,15})\s{2,}Paciente:\s*([^\n]+)/i);
    if(m){patient.tipoDocumento=m[1].toUpperCase();patient.numeroDocumento=m[2];f.fullName=clean(m[3]);setName(patient,f.fullName,true);}
    f.birth=first(head,/Fecha Nacimiento:\s*([0-9\/-]+)/i);
    const mun=first(head,/Municipio:\s*(.*?)\s{2,}Sexo:/i);if(mun){f.municipioResidencia=canonicalCity(mun);f.cityExam=canonicalCity(mun);}
    f.genero=first(head,/Sexo:\s*([MF]|MASCULINO|FEMENINO)/i);f.cargo=first(head,/Ocupaci[óo]n:\s*([^\n]+)/i);
    const patientSection=head.split(/Datos del Paciente/i)[1]?.split(/Empresa:/i)[0]||head;
    f.celular=first(patientSection,/Telefono:\s*(\d{7,15})\s{2,}Municipio:/i);f.direccion=first(patientSection,/Direcci[óo]n:\s*([^\n]+)/i);
    patient.correo='';patient.direccion='';patient.celular='';
    if(/TIPO DE EXAMEN[\s\S]{0,140}PERIODICO/i.test(head))f.examType='PERIÓDICO';else if(/TIPO DE EXAMEN[\s\S]{0,140}EGRESO/i.test(head))f.examType='EGRESO';else if(/TIPO DE EXAMEN[\s\S]{0,140}(?:INGRESO|PRE-INGRESO)/i.test(head))f.examType='INGRESO';
  }

  if(templateDetected==='attention-sections'){
    f.fullName=first(head,/NOMBRE:\s*(.*?)\s{2,}FECHA DE NACIMIENTO:/i);setName(patient,f.fullName,false);
    f.birth=first(head,/FECHA DE NACIMIENTO:\s*([0-9\/-]+)/i);patient.correo='';patient.direccion='';patient.celular='';
    f.genero=first(head,/SEXO:\s*(MASCULINO|FEMENINO|M|F)/i);f.afp=first(head,/FONDO DE PENSIONES:\s*([^\n]+)/i);
    f.eps=first(head,/EPS:\s*(.*?)\s{2,}ARL:/i);f.arl=first(head,/ARL:\s*([^\n]+)/i);f.examType=first(head,/TIPO DE EVALUACION:\s*([^\n]+)/i);
    f.cargo=first(head,/CARGO:\s*(.*?)\s{2,}FECHA DE ATENCI/i);f.cityExam=canonicalCity(first(head,/DPTO\/CIUDAD DE ATENCI[ÓO]N:\s*([^\n]+)/i));
  }

  if(templateDetected==='physical-aptitude'){
    const row=lines.find(l=>/Doc\.?\s*Identidad/i.test(l)&&/\sNombre\s/i.test(l))||'',m=row.match(/Doc\.?\s*Identidad\s*(CC|CE|TI|PT|PA|PEP|PPT)\s*(\d{5,15})\s+Nombre\s+(.*?)\s{2,}Sexo\s+([MF])/i);
    if(m){patient.tipoDocumento=m[1].toUpperCase();patient.numeroDocumento=m[2];f.fullName=clean(m[3]);setName(patient,f.fullName,false);f.genero=m[4];}
    f.cityExam=canonicalCity(first(head,/Fecha\s+[0-9\/:\s]+\s+Ciudad\s+([^\n]+)/i));patient.correo='';patient.direccion='';patient.celular='';
    const contact=lines.find(l=>/Tel[ée]fono\s+\d{7,15}\s{2,}Direcci[óo]n/i.test(l))||'',cm=contact.match(/Tel[ée]fono\s+(\d{7,15})\s{2,}Direcci[óo]n\s+([^\n]+)/i);if(cm){f.celular=cm[1];f.direccion=clean(cm[2]);}
    const ci=lines.findIndex(l=>/^\s*Cargo\s+/i.test(l)||/^\s*Cargo\s*$/i.test(l));if(ci>=0)f.cargo=clean(lines[ci].replace(/^\s*Cargo\s*/i,'')||nextNonEmpty(lines,ci+1,2));
    f.eps=first(head,/^\s*Eps\s+([^\n]+)$/im);const ins=lines.find(l=>/^\s*Arl\s+/i.test(l)&&/Fondo de pensi[óo]n/i.test(l))||'',im=ins.match(/^\s*Arl\s+(.*?)\s{2,}Fondo de pensi[óo]n\s+(.+)$/i);if(im){f.arl=clean(im[1]);f.afp=clean(im[2]);}
    const cert=lines.find(l=>/Tipo certificaci[óo]n/i.test(l))||'';if(/Peri[óo]dico\s+x/i.test(cert))f.examType='PERIÓDICO';else if(/Pre-?Ingreso\s+x/i.test(cert))f.examType='INGRESO';else if(/Egreso\s+x/i.test(cert))f.examType='EGRESO';
  }

  if(templateDetected==='labor-certificate'){
    const ni=lines.findIndex(l=>/^\s*Nombre:\s*/i.test(l));if(ni>=0){let full=clean(lines[ni].replace(/^\s*Nombre:\s*/i,'').split(/#N[úu]mero/i)[0]),nx=clean(lines[ni+1]||'').split(/identificaci[óo]n:/i)[0].trim();if(nx&&/^[A-ZÁÉÍÓÚÑ ]+$/i.test(nx))full=clean(full+' '+nx);f.fullName=full;setName(patient,full,false);}
    const id=head.match(/#N[úu]mero de\s*(CC|CE|TI|PT|PA|PEP|PPT)\s*(\d{5,15})/i);if(id){patient.tipoDocumento=id[1].toUpperCase();patient.numeroDocumento=id[2];}
    f.birth=first(head,/Nacimiento:\s*([0-9\/-]+)/i);f.genero=first(head,/Sexo:\s*(Masculino|Femenino|M|F)/i);patient.correo='';patient.direccion='';patient.celular='';
    const table=lines.find(l=>/EXAMEN\s+(?:PERIODICO|INGRESO|EGRESO)/i.test(l)&&/\s{2,}/.test(l))||'',cols=table.trim().split(/\s{2,}/);if(cols.length>=2)f.cargo=clean(cols[1]);
    f.examType=/PERIODICO/i.test(table)?'PERIÓDICO':/EGRESO/i.test(table)?'EGRESO':/INGRESO/i.test(table)?'INGRESO':f.examType;
    const ii=lines.findIndex(l=>/EPS\s{2,}ARL\s{2,}FONDO DE PENSIONES/i.test(l));if(ii>=0){const v=nextNonEmpty(lines,ii+1,3).trim().split(/\s{2,}/).map(clean);[f.eps,f.arl,f.afp]=v;}
    if(/Valle del Cauca,\s*Cartago/i.test(text)||/SPORTLINE\s+NUESTRO\s+CARTAGO/i.test(fold(text)))f.cityExam='CARTAGO';
  }

  if(templateDetected==='aptitude-sections'){
    f.fullName=first(head,/Paciente:\s*(.*?)\s{2,}Identificaci[óo]n:/i);setName(patient,f.fullName,false);
    f.birth=first(head,/Fecha de Nacimiento:\s*([0-9\/-]+)/i);f.genero=first(head,/G[ée]nero:\s*([MF]|MASCULINO|FEMENINO)/i);
    f.municipioResidencia=canonicalCity(first(head,/Residencia:\s*([^\n]+)/i));f.nivelEducativo=first(head,/Nivel Educativo:\s*(.*?)\s{2,}/i);f.estadoCivil=first(head,/Estado Civil:\s*([^\n]+)/i);
    f.eps=first(head,/EPS:\s*(.*?)\s{2,}ARL:/i);f.arl=first(head,/ARL:\s*(.*?)\s{2,}AFP:/i);f.afp=first(head,/AFP:\s*([^\n]+)/i);
    f.cityExam=canonicalCity(first(head,/Realizado en:\s*([^\n]+)/i))||f.municipioResidencia;f.cargo=first(head,/Cargo u Oficio:\s*([^\n]+)/i);f.examType=first(head,/Examen m[ée]dico ocupacional\s+([^\n]+)/i);
  }

  if(!patient.primerNombre||!patient.primerApellido){const surnameFirst=['worker-table','patient-admission','diagnostic-aids'].includes(templateDetected);setName(patient,f.fullName,surnameFirst,templateDetected==='worker-table');}
  if(!patient.primerNombre||!patient.primerApellido)warnings.push('Confirme los nombres y apellidos; no se pudieron separar con seguridad.');

  patient.fechaNacimiento=date(f.birth);
  const g0=normalizeGender(patient.genero),g1=normalizeGender(f.genero);patient.genero=['MASCULINO','FEMENINO','INDETERMINADO'].includes(g0)?g0:g1;
  patient.estadoCivil=clean(f.estadoCivil||patient.estadoCivil);patient.nivelEducativo=clean(f.nivelEducativo||patient.nivelEducativo);
  patient.correo=clean(f.correo||patient.correo);patient.direccion=clean(f.direccion||patient.direccion);patient.barrio=clean(f.barrio||patient.barrio);
  patient.municipioResidencia=canonicalCity(f.municipioResidencia||patient.municipioResidencia);patient.ciudadNacimiento=canonicalCity(f.ciudadNacimiento||patient.ciudadNacimiento);patient.celular=clean(f.celular||patient.celular).replace(/\D/g,'');

  if(!patient.fechaNacimiento&&age?.years>=14&&age.years<=100){const d=approximateBirthDate(examDate,age);patient.fechaNacimiento=d;autoFilledFields.push({campo:'fechaNacimiento',valor:d,motivo:'Calculada a partir de la edad informada en el concepto'+(examDate?' y la fecha del examen':'')+'. Revise antes del envío.'});}

  const employment={cargo:clean(f.cargo),eps:clean(f.eps),afp:clean(f.afp),arl:clean(f.arl),tipoEvaluacion:evaluation(f.examType||head.slice(0,2500))};
  let cityExam=canonicalCity(f.cityExam);if(!cityExam&&['clinical-certificate','patient-admission','aptitude-sections'].includes(templateDetected))cityExam=canonicalCity(patient.municipioResidencia);
  const explicitCity=text.match(/(?:CIUDAD (?:DEL EXAMEN|DE ATENCION|DE REALIZACION)|LUGAR DE (?:ATENCION|REALIZACION)|REALIZADO EN)\s*:\s*([^\n]+)/i)?.[1];
  if(explicitCity) cityExam=canonicalCity(explicitCity);
  if(!cityExam) cityExam=inferSupportedExamCity(text);
  // The user confirmed Pereira for the supplied location, identified by address,
  // never by the patient's identity or file name. Useful when the footer needs OCR.
  if(!cityExam && /CLINICA RISARALDA/.test(norm(text)) && /CALLE 19 (?:N |NO |NUMERO )?5 13/.test(norm(text))) {
    cityExam='PEREIRA';warnings.push('Ciudad identificada por la sede Clínica Risaralda, Calle 19 5-13, verificada para Pereira.');
  }
  if(!cityExam)warnings.push('Confirme la ciudad donde se realizó el examen.');
  for(const [k,v] of Object.entries(patient))fieldConfidence[k]={level:!v?'missing':autoFilledFields.some(x=>x.campo===k)?'review':'extracted',reason:!v?'No identificado en el documento':autoFilledFields.some(x=>x.campo===k)?'Valor calculado; confirmar en vista previa':'Valor extraído del concepto'};
  return {templateDetected,confidence:'REQUIERE_REVISION',patient,employment,cityExam,examDate,company:{alias:clean(f.empresa),acuerdoBiofile:'',empresaMisionBiofile:''},exams:examList(text),warnings,fieldConfidence,autoFilledFields};
}
