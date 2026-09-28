export function applyDefaults(concept) {
  const c = structuredClone(concept); c.autoFilledFields ||= [];
  const set = (group, key, value, reason = 'No aparece en el concepto') => {
    if (!group[key] && value) { group[key] = value; c.autoFilledFields.push({ campo: key, valor: value, motivo: reason }); }
  };
  const p = c.patient, e = c.employment;
  if (/^\d{5,15}$/.test(p.numeroDocumento)) set(p, 'correo', `nn+${p.numeroDocumento}@gmail.com`);
  set(p, 'direccion', 'NN'); set(p, 'barrio', 'NN'); set(p, 'estrato', '1'); set(p, 'zona', 'URBANA');
  for (const k of ['eps','afp','arl','cargo']) set(e, k, 'NO REFIERE');
  set(p, 'ciudadNacimiento', c.cityExam, 'AUTOCOMPLETADO — CIUDAD DEL EXAMEN');
  return c;
}
