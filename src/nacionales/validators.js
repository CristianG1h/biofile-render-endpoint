import { date, evaluation, norm } from './normalize.js';
export function validateConcept(c) {
  const errors = [], p = c.patient || {}, e = c.employment || {};
  for (const k of ['tipoDocumento','numeroDocumento','primerNombre','primerApellido','fechaNacimiento','genero','estadoCivil','nivelEducativo','ciudadNacimiento','municipioResidencia']) if (!String(p[k] || '').trim()) errors.push(`Falta ${k}`);
  if (p.numeroDocumento && !/^[A-Z0-9]{5,20}$/i.test(p.numeroDocumento)) errors.push('Documento inválido');
  if (p.tipoDocumento && !['CC','CE','TI','PT','PA','PEP','PPT','RC'].includes(norm(p.tipoDocumento))) errors.push('Tipo de documento no reconocido');
  if (p.fechaNacimiento && !date(p.fechaNacimiento)) errors.push('Fecha de nacimiento inválida');
  if (!evaluation(e.tipoEvaluacion)) errors.push('Tipo de evaluación desconocido');
  if (!c.cityExam) errors.push('Falta ciudad del examen');
  if (!c.exams?.length) errors.push('Confirme los exámenes realizados');
  if (!c.reviewed) errors.push('Confirme la revisión de la vista previa');
  return errors;
}
