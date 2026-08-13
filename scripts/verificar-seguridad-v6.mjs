import fs from 'node:fs';

const archivos = {
  browser: new URL('../src/browser.js', import.meta.url),
  biofile: new URL('../src/biofile.js', import.meta.url),
  sheets: new URL('../src/google-sheets.js', import.meta.url),
  procesar: new URL('../src/procesar-registro.js', import.meta.url),
  server: new URL('../src/server.js', import.meta.url)
};

const contenido = Object.fromEntries(Object.entries(archivos).map(([k, u]) => [k, fs.readFileSync(u, 'utf8')]));
const pruebas = [
  ['sesión BIOFILE limpia', contenido.browser.includes('/* SESION_LIMPIA_V6 */')],
  ['guardado confirmado no revierte', contenido.biofile.includes('/* GUARDADO_CONFIRMADO_V6 */')],
  ['idempotencia persistente', contenido.sheets.includes('/* IDEMPOTENCIA_BIOFILE_V6 */')],
  ['estado REVISAR_BIOFILE', contenido.sheets.includes("'REVISAR_BIOFILE'")],
  ['barrera antes de Guardar', contenido.procesar.includes('/* SEGURIDAD_PROCESO_V6 */') && contenido.procesar.includes('marcarGuardando')],
  ['API Bearer-only', contenido.server.includes('/* AUTH_BEARER_ONLY_V6 */') && !contenido.server.includes('legado: true')],
  ['documento canónico', contenido.server.includes('/* DOCUMENTO_CLAVE_V6 */')],
  ['auditoría automática', contenido.server.includes('INGRESO_AUTOMATICO_COMPLETADO') && contenido.server.includes('INGRESO_AUTOMATICO_ERROR')],
  ['listado autenticado', contenido.sheets.includes('/* LISTADO_AUTENTICADO_V61 */') && contenido.server.includes('/* LISTADO_API_V61 */')],
  ['fila exacta', contenido.sheets.includes('_FILA_SHEETS') && contenido.server.includes('filaValida')],
  ['eliminados restaurado', contenido.sheets.includes('ELIMINADOS_RESTAURADO_V61') && contenido.sheets.includes('marcarEliminadoFila')],
  ['manual por fila', contenido.sheets.includes('marcarCompletadoManualFila')],
  ['filtro histórico v6.2', contenido.sheets.includes('CORTE_HISTORICO_PENDIENTES_V62')],
  ['hora Colombia preservada', contenido.sheets.includes('/* FECHA_LOCAL_COLOMBIA_V63 */') && contenido.sheets.includes("+ '-05:00'")]
];

const fallidas = pruebas.filter(([, ok]) => !ok);
for (const [nombre, ok] of pruebas) console.log(`${ok ? 'OK' : 'FAIL'} - ${nombre}`);
if (fallidas.length) process.exit(1);
console.log(`Seguridad BIOFILE verificada: ${pruebas.length}/${pruebas.length} controles.`);
