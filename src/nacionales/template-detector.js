import { norm } from './normalize.js';
// Structural signatures: IPS names and filenames are never parser selectors.
const templates = [
  ['worker-table', ['DATOS DEL TRABAJADOR ASPIRANTE', 'APELLIDOS Y NOMBRES', 'CONCEPTO DE APTITUD']],
  ['clinical-certificate', ['CERTIFICADO HISTORIA CLINICA', 'IDENTIFICACION DEL PACIENTE', 'EXAMENES REALIZADOS']],
  ['osteomuscular-sections', ['CONCEPTO MEDICO OCUPACIONAL CON ENFASIS', 'APELLIDO', 'EXAMENES REALIZADOS']],
  ['patient-admission', ['DATOS DEL PACIENTE', 'FECHA INGRESO', 'CERTIFICADO DE APTITUD']],
  ['attention-sections', ['DATOS DEL CLIENTE', 'DATOS DE LA ATENCION']],
  ['diagnostic-aids', ['IDENTIFICACION DEL ASPIRANTE', 'AYUDAS DIAGNOSTICAS']],
  ['labor-certificate', ['CERTIFICADO MEDICO LABORAL', 'EXAMENES COMPLEMENTARIOS']],
  ['compact-aptitude', ['IDENTIFICACION NOMBRE COMPLETO', 'CONCEPTO']],
  ['physical-aptitude', ['INFORME MEDICO OCUPACIONAL DE APTITUD', 'DATOS DEL PACIENTE']],
  ['aptitude-sections', ['CONCEPTO DE APTITUD', 'EXAMENES REALIZADOS']]
];
export function detectTemplate(text) {
  const n = norm(text);
  return templates.find(([, labels]) => labels.every(label => n.includes(label)))?.[0] || 'generic';
}
