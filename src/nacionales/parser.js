import { clean, norm, date, evaluation, splitNames } from './normalize.js';
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
  cityExam: ['CIUDAD DE ATENCION', 'CIUDAD DEL EXAMEN', 'DPTO/CIUDAD DE ATENCION'],
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
export function examList(text) {
  const n = norm(text), exams = [];
  const section = n.match(/(?:EXAMENES REALIZADOS|EXAMENES PRACTICADOS|AYUDAS DIAGNOSTICAS|EXAMENES COMPLEMENTARIOS|PARACLINICOS)([\s\S]*?)(?:RECOMENDACIONES|CONCEPTO DE APTITUD|CONCEPTO GENERAL|$)/)?.[1];
  const source = section || n.split(/RECOMENDACIONES|CONSENTIMIENTO|FIRMA/)[0];
  for (const [name, regex] of [['AUDIOMETRÍA', /AUDIOMETR/], ['VISIOMETRÍA', /VISIOMETR/], ['OPTOMETRÍA', /OPTOMETR/], ['EXAMEN MÉDICO OCUPACIONAL', /EXAMEN (?:MEDICO|FISICO)|VALORACION MEDICA OCUPACIONAL|EVALUACION MEDICA OCUPACIONAL/], ['ESPIROMETRÍA', /ESPIROMETR/], ['ELECTROCARDIOGRAMA', /ELECTROCARDIOGRAMA/]]) if (regex.test(source)) exams.push(name);
  return exams;
}
export function parseDocument(text) {
  const templateDetected = detectTemplate(text);
  const head = text.split(/RECOMENDACIONES GENERALES|FIRMA DEL|ATENDIDO POR/i)[0];
  const f = readFields(head), warnings = [], fieldConfidence = {};
  const patient = Object.fromEntries(['tipoDocumento','numeroDocumento','primerNombre','segundoNombre','primerApellido','segundoApellido','fechaNacimiento','genero','estadoCivil','nivelEducativo','correo','direccion','barrio','municipioResidencia','ciudadNacimiento','celular'].map(k => [k, clean(f[k])]));
  const id = fold(head).match(/(?:IDENTIFICACI[ÓO]N|IDENTIDAD|DOCUMENTO|\bID)\s*:?\s*(CC|CE|TI|PT|PA|PEP|PPT)\s*[-.:]?\s*([\d.]{5,16})/);
  const splitId = fold(head).match(/IDENTIFICACION\s*:\s*(CC|CE|TI|PT|PA|PEP|PPT)\s+N[UÚ]MERO\s*:\s*([\d.]{5,16})/);
  const identity = id || splitId;
  if (identity) { patient.tipoDocumento = identity[1]; patient.numeroDocumento = identity[2].replace(/\D/g, ''); }
  if (templateDetected === 'worker-table') {
    const lines = head.split(/\r?\n/), ix = lines.findIndex(l => /Apellidos y Nombres/i.test(l));
    const previous = lines.slice(ix + 1).find(l => l.trim()) || '';
    const columns = previous.trim().split(/\s{2,}/);
    if (ix > 0 && columns.length >= 3) {
      f.fullName = columns[0];
      const m = previous.match(/\b(CC|CE|TI|PT|PA|PEP|PPT)\b\s+(\d{5,15})\b/);
      if (m) { patient.tipoDocumento = m[1]; patient.numeroDocumento = m[2]; }
      patient.genero = /FEMENINO/i.test(previous) ? 'FEMENINO' : /MASCULINO/i.test(previous) ? 'MASCULINO' : '';
      const cityIx = lines.findIndex(l => /FECHA Y CIUDAD DE REALIZACI/i.test(l));
      if (cityIx >= 0) f.cityExam = clean(lines[cityIx + 1]).split('(')[0].trim();
      const insuranceIx = lines.findIndex(l => /EPS\s{2,}AFP\s{2,}ARL/.test(l));
      if (insuranceIx >= 0) { const values = (lines[insuranceIx + 1] || '').trim().split(/\s{2,}/); [f.eps,f.afp,f.arl] = values; }
      const cargoIx = lines.findIndex(l => /^\s*Cargo\s*$/i.test(l));
      if (cargoIx >= 0) f.cargo = clean(lines[cargoIx + 1]);
    }
  }
  if (templateDetected === 'osteomuscular-sections') {
    const surname = head.match(/Apellido:\s*([^\n]+?)(?=\s{2,}Nombre:)/i)?.[1];
    if (surname && f.fullName) { const names=clean(f.fullName).split(' '), surnames=clean(surname).split(' '); patient.primerNombre=names[0];patient.segundoNombre=names.slice(1).join(' ');patient.primerApellido=surnames[0];patient.segundoApellido=surnames.slice(1).join(' '); }
    const id = head.match(/Tipo Doc:\s*(CC|CE|TI|PA|PPT)\s+Nro Identidad:\s*([\d.]+)/i);
    if(id){patient.tipoDocumento=id[1].toUpperCase();patient.numeroDocumento=id[2].replace(/\D/g,'');}
  }
  if (templateDetected === 'compact-aptitude') {
    const line=head.split(/\r?\n/).find(l=>/^\s*(CC|CE|TI)\s+\d{5,15}\s{2,}/.test(l));
    const m=line?.match(/^\s*(CC|CE|TI)\s+(\d{5,15})\s{2,}(.+)$/);
    if(m){patient.tipoDocumento=m[1];patient.numeroDocumento=m[2];f.fullName=m[3].split(/\s{2,}/)[0];}
  }
  if (!patient.primerNombre || !patient.primerApellido) {
    Object.assign(patient, splitNames(f.fullName, ['worker-table','patient-admission','diagnostic-aids'].includes(templateDetected)));
    warnings.push('Verifique la separación de nombres y apellidos del documento.');
  }
  patient.fechaNacimiento = date(f.birth);
  patient.genero = ({ M:'MASCULINO', F:'FEMENINO' })[norm(patient.genero)] || patient.genero;
  patient.celular = patient.celular.replace(/\D/g, '');
  const employment = Object.fromEntries(['cargo','eps','afp','arl'].map(k => [k, clean(f[k])]));
  employment.tipoEvaluacion = evaluation(f.examType || head.slice(0, 2000));
  const cityExam = clean(f.cityExam).split('/').pop().trim();
  if (!cityExam) warnings.push('Confirme la ciudad donde se realizó el examen; no se usó la ciudad del membrete.');
  for (const [k, v] of Object.entries(patient)) fieldConfidence[k] = { level: !v ? 'missing' : /Nombre|Apellido/.test(k) && warnings.length ? 'review' : 'extracted', reason: !v ? 'No identificado en el documento' : 'Valor extraído; confirmar en vista previa' };
  return { templateDetected, confidence: 'REQUIERE_REVISION', patient, employment, cityExam, company: { alias: clean(f.empresa), acuerdoBiofile: '', empresaMisionBiofile: '' }, exams: examList(text), warnings, fieldConfidence, autoFilledFields: [] };
}
