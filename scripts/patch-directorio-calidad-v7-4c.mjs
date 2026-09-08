import fs from 'node:fs';

const directorioPath = new URL('../src/directorio-empresas-biofile.js', import.meta.url);
let src = fs.readFileSync(directorioPath, 'utf8');
const MARCA = 'DIRECTORIO_EMPRESAS_CALIDAD_V74C';

if (src.includes(MARCA)) {
  console.log('[Directorio] calidad v7.4c ya instalada.');
  process.exit(0);
}

function reemplazarUna(texto, buscar, reemplazo, etiqueta) {
  if (!texto.includes(buscar)) throw new Error('No se encontró ' + etiqueta + '.');
  return texto.replace(buscar, reemplazo);
}

const textoFn = `function texto(valor) {
  return String(valor ?? '').replace(/\\s+/g, ' ').trim();
}`;
const helpers = `${textoFn}

/* ${MARCA} */
export function normalizarFechaDirectorio(valor) {
  const numero = typeof valor === 'number'
    ? valor
    : (/^\\d{5}(?:[.,]\\d+)?$/.test(String(valor ?? '').trim()) ? Number(String(valor).replace(',', '.')) : NaN);
  if (Number.isFinite(numero) && numero >= 20000 && numero <= 100000) {
    const fecha = new Date(Date.UTC(1899, 11, 30) + Math.round(numero) * 86400000);
    const dd = String(fecha.getUTCDate()).padStart(2, '0');
    const mm = String(fecha.getUTCMonth() + 1).padStart(2, '0');
    return dd + '/' + mm + '/' + fecha.getUTCFullYear();
  }
  return texto(valor);
}

export function acuerdoDirectorioValido(valor) {
  const original = texto(valor);
  if (!original || original.length < 2) return false;
  if (/^\\d+(?:[.,]\\d+)?$/.test(original)) return false;
  const normal = normalizarClaveEmpresa(original);
  if (/^TOTAL(?: GENERAL)?(?:\\s|$)/.test(normal)) return false;
  return true;
}`;
src = reemplazarUna(src, textoFn, helpers, 'función texto()');

src = reemplazarUna(
  src,
  '?valueInputOption=USER_ENTERED`,',
  '?valueInputOption=RAW`,',
  'valueInputOption del directorio'
);

src = reemplazarUna(src, '      fechaCreacion: texto(r[4]),', '      fechaCreacion: normalizarFechaDirectorio(r[4]),', 'fechaCreacion del directorio');
src = reemplazarUna(
  src,
  '    })).filter((x) => x.clave && x.acuerdo);',
  '    })).filter((x) => x.clave && x.acuerdo && acuerdoDirectorioValido(x.acuerdo));',
  'filtro de empresas guardadas'
);

const recientesViejo = `    const nuevas = [...items]
      .sort((a, b) => String(b.primeraDeteccionIso).localeCompare(String(a.primeraDeteccionIso)))
      .slice(0, 12)
      .map((x) => ({ acuerdo: x.acuerdo, cliente: x.cliente, primeraDeteccionIso: x.primeraDeteccionIso }));`;
const recientesNuevo = `    const ultimoExito = texto(r[1]);
    const nuevasUltima = Number(r[4] || 0);
    const nuevas = nuevasUltima > 0
      ? [...items]
          .filter((x) => texto(x.primeraDeteccionIso) === ultimoExito)
          .sort((a, b) => a.acuerdo.localeCompare(b.acuerdo, 'es', { sensitivity: 'base' }))
          .slice(0, Math.min(12, nuevasUltima))
          .map((x) => ({ acuerdo: x.acuerdo, cliente: x.cliente, primeraDeteccionIso: x.primeraDeteccionIso }))
      : [];`;
src = reemplazarUna(src, recientesViejo, recientesNuevo, 'empresas recientes');

src = reemplazarUna(src, '      ultimoExitoIso: texto(r[1]),', '      ultimoExitoIso: ultimoExito,', 'último éxito del estado');
src = reemplazarUna(src, '      totalEmpresas: Number(r[3] || items.length || 0),', '      totalEmpresas: items.length,', 'total real de empresas');
src = reemplazarUna(src, '      nuevasUltima: Number(r[4] || 0),', '      nuevasUltima,', 'contador de nuevas');
src = reemplazarUna(src, '      fechaDesde: texto(r[5]),', '      fechaDesde: normalizarFechaDirectorio(r[5]),', 'fecha desde del estado');
src = reemplazarUna(src, '      fechaHasta: texto(r[6]),', '      fechaHasta: normalizarFechaDirectorio(r[6]),', 'fecha hasta del estado');

src = reemplazarUna(
  src,
  '  async guardarSincronizacion(clientes, { fechaDesde, fechaHasta, duracionMs = 0 } = {}) {',
  '  async guardarSincronizacion(clientes, { fechaDesde, fechaHasta, duracionMs = 0, reemplazar = false } = {}) {',
  'firma guardarSincronizacion'
);
src = reemplazarUna(
  src,
  '      const mapa = new Map(existentes.map((x) => [x.clave, { ...x }]));',
  '      const mapa = reemplazar ? new Map() : new Map(existentes.map((x) => [x.clave, { ...x }]));',
  'mapa incremental/completo'
);
src = reemplazarUna(
  src,
  '        if (!clave || acuerdo.length < 2) continue;',
  '        if (!clave || acuerdo.length < 2 || !acuerdoDirectorioValido(acuerdo)) continue;',
  'validación al guardar empresas'
);

src = reemplazarUna(
  src,
  '    const acuerdo = texto(cells[indices.acuerdo]);',
  `    const acuerdo = texto(cells[indices.acuerdo]);
    if (!acuerdoDirectorioValido(acuerdo)) continue;`,
  'validación del acuerdo extraído'
);

const rowsViejo = `    const rows = await tabla.locator('tr').evaluateAll((trs) => trs.map((tr) =>
      Array.from(tr.querySelectorAll('th,td')).map((td) => (td.innerText || td.textContent || '').replace(/\\s+/g, ' ').trim())
    )).catch(() => []);`;
const rowsNuevo = `    // table.rows + tr.cells devuelve únicamente las celdas de esta tabla.
    // querySelectorAll('th,td') también incluía celdas de tablas anidadas de BIOFILE,
    // desplazando columnas y creando falsos acuerdos como 13 / Cliente 15.
    const rows = await tabla.evaluate((table) => Array.from(table.rows || []).map((tr) =>
      Array.from(tr.cells || []).map((td) => (td.innerText || td.textContent || '').replace(/\\s+/g, ' ').trim())
    )).catch(() => []);`;
src = reemplazarUna(src, rowsViejo, rowsNuevo, 'lectura de filas de tabla');

const guardarViejo = `    const resultado = await store.guardarSincronizacion(clientes, {
      fechaDesde: rango.desde,
      fechaHasta: rango.hasta,
      duracionMs: Date.now() - inicio
    });`;
const guardarNuevo = `    if (rango.completo) {
      const existentes = await store.listar().catch(() => []);
      const minimoSeguro = existentes.length >= 100
        ? Math.max(50, Math.floor(existentes.length * 0.45))
        : 1;
      if (clientes.length < minimoSeguro) {
        throw new Error('La lectura histórica devolvió solo ' + clientes.length + ' empresas frente a ' + existentes.length + ' guardadas. Se conservó el directorio anterior por seguridad.');
      }
    }
    const resultado = await store.guardarSincronizacion(clientes, {
      fechaDesde: rango.desde,
      fechaHasta: rango.hasta,
      duracionMs: Date.now() - inicio,
      reemplazar: rango.completo
    });`;
src = reemplazarUna(src, guardarViejo, guardarNuevo, 'guardado de sincronización completa');

if (!src.includes(MARCA) || !src.includes('table.rows') || !src.includes('valueInputOption=RAW') || !src.includes('reemplazar: rango.completo') || !src.includes('const nuevasUltima')) {
  throw new Error('Directorio calidad v7.4c quedó incompleto.');
}

fs.writeFileSync(directorioPath, src, 'utf8');
console.log('[Directorio] v7.4c: columnas anidadas, fechas seriales, recientes y reconstrucción completa corregidas.');
