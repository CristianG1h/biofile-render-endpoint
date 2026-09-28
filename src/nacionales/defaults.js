import { approximateBirthDate, canonicalCity } from './normalize.js';

export function applyDefaults(concept) {
  const c = structuredClone(concept);
  c.autoFilledFields ||= [];
  const set = (group, key, value, reason = 'No aparece en el concepto') => {
    if (!group[key] && value) {
      group[key] = value;
      c.autoFilledFields.push({ campo: key, valor: value, motivo: reason });
    }
  };
  const p = c.patient ||= {};
  const e = c.employment ||= {};
  const city = canonicalCity(c.cityExam);

  set(p, 'genero', 'MASCULINO', 'Predeterminado de Nacionales: hombre');
  set(p, 'estadoCivil', 'SOLTERO(A)', 'Predeterminado de Nacionales: soltero');
  set(p, 'nivelEducativo', 'SECUNDARIA', 'Predeterminado de Nacionales: secundaria');
  set(e, 'tipoEvaluacion', 'INGRESO', 'Predeterminado de Nacionales: ingreso');

  if (!p.fechaNacimiento) {
    set(
      p,
      'fechaNacimiento',
      approximateBirthDate(c.examDate, { years: 35 }),
      'Fecha estimada equivalente a 35 años porque el concepto no informa fecha de nacimiento ni edad. Debe revisarse antes del envío.'
    );
  }

  if (/^\d{5,15}$/.test(p.numeroDocumento)) set(p, 'correo', 'nn+' + p.numeroDocumento + '@gmail.com');
  set(p, 'direccion', 'NN');
  set(p, 'barrio', 'NN');
  set(p, 'estrato', '1');
  set(p, 'zona', 'URBANA');
  for (const k of ['eps', 'afp', 'arl', 'cargo']) set(e, k, 'NO REFIERE');
  set(p, 'municipioResidencia', city, 'Autocompletado con la ciudad del examen');
  set(p, 'ciudadNacimiento', city, 'Autocompletado con la ciudad del examen');
  c.cityExam = city || c.cityExam;
  return c;
}
