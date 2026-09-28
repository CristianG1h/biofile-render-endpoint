import { date, evaluation, norm } from './normalize.js';

const REQUIRED_PATIENT = {
  tipoDocumento: 'tipo de documento',
  numeroDocumento: 'número de documento',
  primerNombre: 'primer nombre',
  primerApellido: 'primer apellido',
  fechaNacimiento: 'fecha de nacimiento',
  genero: 'género',
  estadoCivil: 'estado civil',
  nivelEducativo: 'nivel educativo',
  ciudadNacimiento: 'ciudad de nacimiento',
  municipioResidencia: 'municipio de residencia'
};

export function validateConcept(c) {
  const errors = [], p = c.patient || {}, e = c.employment || {};
  for (const [key, label] of Object.entries(REQUIRED_PATIENT)) {
    if (!String(p[key] || '').trim()) errors.push(`Falta ${label}.`);
  }
  if (p.numeroDocumento && !/^[A-Z0-9]{5,20}$/i.test(p.numeroDocumento)) errors.push('El número de documento no tiene un formato válido.');
  if (p.tipoDocumento && !['CC','CE','TI','PT','PA','PEP','PPT','RC'].includes(norm(p.tipoDocumento))) errors.push('El tipo de documento no es reconocido por BIOFILE.');
  if (p.fechaNacimiento && !date(p.fechaNacimiento)) errors.push('La fecha de nacimiento no es válida.');
  if (!evaluation(e.tipoEvaluacion)) errors.push('El tipo de evaluación no es válido.');
  if (!c.cityExam) errors.push('Falta la ciudad donde se realizó el examen.');
  if (!c.exams?.length) errors.push('Confirme los exámenes realizados.');
  if (!c.reviewed) errors.push('Abra “Editar / revisar” y guarde la revisión antes de enviar.');
  return errors;
}
