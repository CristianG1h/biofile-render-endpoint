export const norm = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
export const clean = value => String(value || '').trim().replace(/\s+/g, ' ');
export function evaluation(value) {
  const n = norm(value);
  if (/POST.*INCAPACIDAD/.test(n)) return 'POST INCAPACIDAD';
  if (/RETIRO|EGRESO/.test(n)) return 'EGRESO';
  if (/PRE ?INGRESO|INGRESO/.test(n)) return 'INGRESO';
  if (/PERIODIC/.test(n)) return 'PERIÓDICO';
  return '';
}
export function date(value) {
  const m = clean(value).match(/^(\d{4})[-/](\d{2})[-/](\d{2})$|^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (!m) return '';
  const iso = m[1] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[6]}-${m[5]}-${m[4]}`;
  const d = new Date(iso + 'T00:00:00Z');
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === iso && iso <= new Date().toISOString().slice(0, 10) ? iso : '';
}
export function splitNames(value, surnameFirst = false) {
  const parts = clean(value).split(' ').filter(Boolean);
  if (parts.length < 3) return {};
  const names = surnameFirst ? parts.slice(2) : parts.slice(0, -2);
  const surnames = surnameFirst ? parts.slice(0, 2) : parts.slice(-2);
  return { primerNombre: names[0], segundoNombre: names.slice(1).join(' '), primerApellido: surnames[0], segundoApellido: surnames[1] };
}
