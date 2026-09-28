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

  // Nacionales usa estos valores operativos cuando el concepto no los informa.
  // Se guardan con los textos que BIOFILE reconoce en sus selectores.
  set(p, 'genero', 'MASCULINO', 'Predeterminado de Nacionales: hombre');
  set(p, 'estadoCivil', 'SOLTERO(A)', 'Predeterminado de Nacionales: soltero');
  set(p, 'nivelEducativo', 'SECUNDARIA', 'Predeterminado de Nacionales: secundaria');
  set(e, 'tipoEvaluacion', 'INGRESO', 'Predeterminado de Nacionales: ingreso');

  if (/^\d{5,15}$/.test(p.numeroDocumento)) set(p, 'correo', `nn+${p.numeroDocumento}@gmail.com`);
  set(p, 'direccion', 'NN');
  set(p, 'barrio', 'NN');
  set(p, 'estrato', '1');
  set(p, 'zona', 'URBANA');
  for (const k of ['eps', 'afp', 'arl', 'cargo']) set(e, k, 'NO REFIERE');
  set(p, 'ciudadNacimiento', c.cityExam, 'Autocompletado con la ciudad del examen');
  return c;
}
