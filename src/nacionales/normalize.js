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

const MONTHS = Object.freeze({
  ENE:1, ENERO:1, JAN:1, JANUARY:1,
  FEB:2, FEBRERO:2, FEBRUARY:2,
  MAR:3, MARZO:3, MARCH:3,
  ABR:4, ABRIL:4, APR:4, APRIL:4,
  MAY:5, MAYO:5,
  JUN:6, JUNIO:6, JUNE:6,
  JUL:7, JULIO:7, JULY:7,
  AGO:8, AGOSTO:8, AUG:8, AUGUST:8,
  SEP:9, SEPT:9, SEPTIEMBRE:9, SEPTEMBER:9,
  OCT:10, OCTUBRE:10, OCTOBER:10,
  NOV:11, NOVIEMBRE:11, NOVEMBER:11,
  DIC:12, DICIEMBRE:12, DEC:12, DECEMBER:12
});

function validIso(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const d = new Date(iso + 'T00:00:00Z');
  return !Number.isNaN(d.valueOf()) &&
    d.toISOString().slice(0, 10) === iso &&
    iso <= new Date().toISOString().slice(0, 10) ? iso : '';
}

export function date(value) {
  const raw = clean(value);
  if (!raw) return '';

  let m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return validIso(m[1] + '-' + String(m[2]).padStart(2,'0') + '-' + String(m[3]).padStart(2,'0'));

  m = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return validIso(m[3] + '-' + String(m[2]).padStart(2,'0') + '-' + String(m[1]).padStart(2,'0'));

  m = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return validIso(m[1] + '-' + m[2] + '-' + m[3]);

  const upper = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  m = upper.match(/^(\d{1,2})\s*(?:\/|-|\s+DE\s+|\s+)([A-Z]+)\s*(?:\/|-|\s+DE\s+|\s+)(\d{4})$/);
  if (m && MONTHS[m[2]]) {
    return validIso(m[3] + '-' + String(MONTHS[m[2]]).padStart(2,'0') + '-' + String(m[1]).padStart(2,'0'));
  }
  return '';
}

export function approximateBirthDate(referenceIso, { years = 35, months = 0, days = 0 } = {}) {
  const base = date(referenceIso) || new Date().toISOString().slice(0, 10);
  const [y,m,d] = base.split('-').map(Number);
  const dt = new Date(Date.UTC(y - Number(years || 0), m - 1 - Number(months || 0), d - Number(days || 0)));
  return dt.toISOString().slice(0, 10);
}

const CITY_ALIASES = Object.freeze([
  ['SAN JOSE DEL GUAVIARE','SAN JOSÉ DEL GUAVIARE'],
  ['PUERTO CARRENO','PUERTO CARREÑO'],
  ['SANTA MARTA','SANTA MARTA'],
  ['VILLAVICENCIO','VILLAVICENCIO'],
  ['BARRANQUILLA','BARRANQUILLA'],
  ['BUCARAMANGA','BUCARAMANGA'],
  ['VALLEDUPAR','VALLEDUPAR'],
  ['CARTAGENA','CARTAGENA'],
  ['MANIZALEZ','MANIZALES'],
  ['MANIZALES','MANIZALES'],
  ['MEDELLIN','MEDELLÍN'],
  ['MONTERIA','MONTERÍA'],
  ['CUCUTA','CÚCUTA'],
  ['BOGOTA','BOGOTÁ'],
  ['PEREIRA','PEREIRA'],
  ['CARTAGO','CARTAGO'],
  ['CALI','CALI'],
  ['TUNJA','TUNJA'],
  ['SOPO','SOPÓ']
]);

export function canonicalCity(value) {
  const n = norm(value);
  if (!n || ['NO APLICA','NO REFIERE','SIN INFORMACION','SELECCIONE'].includes(n)) return '';
  for (const [key, label] of CITY_ALIASES) if (n===key || n.startsWith(key+' ') || n.endsWith(' '+key)) return label;
  const raw = clean(value).split('(')[0].split('/').pop().split(/\s+-\s+/)[0].trim();
  return raw ? raw.toUpperCase() : '';
}

export function splitNames(value, surnameFirst = false) {
  const parts = clean(value).split(' ').filter(Boolean);
  if (parts.length < 2) return {};
  if (parts.length === 2) {
    return surnameFirst
      ? { primerNombre: parts[1], segundoNombre: '', primerApellido: parts[0], segundoApellido: '' }
      : { primerNombre: parts[0], segundoNombre: '', primerApellido: parts[1], segundoApellido: '' };
  }
  const names = surnameFirst ? parts.slice(2) : parts.slice(0, -2);
  const surnames = surnameFirst ? parts.slice(0, 2) : parts.slice(-2);
  return { primerNombre: names[0], segundoNombre: names.slice(1).join(' '), primerApellido: surnames[0], segundoApellido: surnames.slice(1).join(' ') };
}
