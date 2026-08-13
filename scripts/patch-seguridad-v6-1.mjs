import fs from 'node:fs';

const sheetsPath = new URL('../src/google-sheets.js', import.meta.url);
const serverPath = new URL('../src/server.js', import.meta.url);

function reemplazarUna(texto, buscar, reemplazo, etiqueta) {
  if (!texto.includes(buscar)) throw new Error(`No se encontró ${etiqueta}.`);
  return texto.replace(buscar, reemplazo);
}

// ==================== LISTADO AUTENTICADO + FILA EXACTA ====================
let sheets = fs.readFileSync(sheetsPath, 'utf8');
if (!sheets.includes('/* LISTADO_AUTENTICADO_V61 */')) {
  const marcador = '  obtenerPendientes({ max = Infinity, documento = \'\', fila = 0 } = {}) {';
  if (!sheets.includes(marcador)) throw new Error('No se encontró obtenerPendientes() en google-sheets.js.');

  const metodo = `  /* LISTADO_AUTENTICADO_V61 */\n  listarRegistros({ busqueda = '' } = {}) {\n    const encabezados = (this.rows[0] || []).map((v) => texto(v));\n    const q = normalizar(busqueda);\n    const registros = [];\n\n    const valorListado = (valor, encabezado) => {\n      if (valor === null || valor === undefined) return '';\n      if (typeof valor === 'number' && normalizar(encabezado).includes('FECHA')) {\n        const ms = Date.UTC(1899, 11, 30) + Math.round(valor * 86400000);\n        const d = new Date(ms);\n        if (!Number.isNaN(d.getTime())) return d.toISOString();\n      }\n      return texto(valor);\n    };\n\n    // Más recientes primero. Esto alinea el listado con la operación diaria y\n    // evita que una cédula repetida seleccione silenciosamente una visita antigua.\n    for (let row = this.rows.length; row >= 2; row -= 1) {\n      const valores = this.rows[row - 1] || [];\n      const registro = { _FILA_SHEETS: row };\n      for (let i = 0; i < encabezados.length; i += 1) {\n        const encabezado = encabezados[i];\n        if (!encabezado) continue;\n        registro[encabezado] = valorListado(valores[i], encabezado);\n      }\n      if (q) {\n        const bolsa = normalizar(Object.values(registro).join(' '));\n        if (!bolsa.includes(q)) continue;\n      }\n      registros.push(registro);\n    }\n    return registros;\n  }\n\n`;
  sheets = sheets.replace(marcador, metodo + marcador);

  const inicioMetodo = sheets.indexOf(marcador);
  const finMetodo = sheets.indexOf('  async #actualizar(', inicioMetodo);
  if (inicioMetodo < 0 || finMetodo < 0) throw new Error('No se pudo aislar obtenerPendientes().');
  let bloque = sheets.slice(inicioMetodo, finMetodo);
  bloque = reemplazarUna(
    bloque,
    '    for (let row = 2; row <= this.rows.length; row += 1) {',
    '    for (let row = this.rows.length; row >= 2; row -= 1) {',
    'el orden de selección de pendientes'
  );
  sheets = sheets.slice(0, inicioMetodo) + bloque + sheets.slice(finMetodo);

  // Seguridad v6 reemplazó el bloque de error y, al hacerlo, podía retirar por
  // accidente marcarEliminado() agregado por operación v5. Lo restauramos aquí.
  if (!sheets.includes('  async marcarEliminado(documento,')) {
    const antesStats = "  obtenerEstadisticasUsuarios({ desde = '', hasta = '' } = {}) {";
    if (!sheets.includes(antesStats)) throw new Error('No se encontró obtenerEstadisticasUsuarios().');
    const eliminado = `  /* ELIMINADOS_RESTAURADO_V61 */\n  async marcarEliminadoFila(row, actor = '', motivo = '') {\n    const fila = Number(row || 0);\n    if (!Number.isInteger(fila) || fila < 2 || fila > this.rows.length) throw new Error('Fila de Google Sheets no válida.');\n    const estado = normalizar(this.#get(fila, 'ESTADO_BIOFILE'));\n    if (estado === 'COMPLETADO') throw new Error('Un registro ya completado no se puede mover a Eliminados.');\n    await this.#actualizar(fila, {\n      ESTADO_BIOFILE: 'ELIMINADO',\n      ELIMINADO_POR: actor,\n      FECHA_ELIMINADO_ISO: fechaIsoBogota(),\n      MOTIVO_ELIMINADO: String(motivo || '').slice(0, 1000),\n      ULTIMA_ETAPA_BIOFILE: 'ELIMINADO'\n    });\n    return { row: fila, documento: this.#get(fila, 'N° documento'), eliminadoPor: actor, motivo: String(motivo || '') };\n  }\n\n  async marcarEliminado(documento, actor = '', motivo = '') {\n    const row = this.#filaPorDocumento(documento);\n    if (!row) throw new Error('No se encontró ese documento en Google Sheets.');\n    return this.marcarEliminadoFila(row, actor, motivo);\n  }\n\n  async marcarCompletadoManualFila(row, usuarioResponsable = '', registradoPor = '') {\n    const fila = Number(row || 0);\n    if (!Number.isInteger(fila) || fila < 2 || fila > this.rows.length) throw new Error('Fila de Google Sheets no válida.');\n    await this.marcarCompletado(fila, this.#get(fila, 'NUMERO_OS_BIOFILE'), usuarioResponsable, 'MANUAL');\n    await this.#actualizar(fila, { REGISTRADO_POR_BIOFILE: registradoPor || usuarioResponsable });\n    return { row: fila, usuarioResponsable, registradoPor: registradoPor || usuarioResponsable };\n  }\n\n`;
    sheets = sheets.replace(antesStats, eliminado + antesStats);
  } else if (!sheets.includes('  async marcarCompletadoManualFila(')) {
    const antesStats = "  obtenerEstadisticasUsuarios({ desde = '', hasta = '' } = {}) {";
    const helper = `  async marcarCompletadoManualFila(row, usuarioResponsable = '', registradoPor = '') {\n    const fila = Number(row || 0);\n    if (!Number.isInteger(fila) || fila < 2 || fila > this.rows.length) throw new Error('Fila de Google Sheets no válida.');\n    await this.marcarCompletado(fila, this.#get(fila, 'NUMERO_OS_BIOFILE'), usuarioResponsable, 'MANUAL');\n    await this.#actualizar(fila, { REGISTRADO_POR_BIOFILE: registradoPor || usuarioResponsable });\n    return { row: fila, usuarioResponsable, registradoPor: registradoPor || usuarioResponsable };\n  }\n\n`;
    sheets = sheets.replace(antesStats, helper + antesStats);
  }

  fs.writeFileSync(sheetsPath, sheets, 'utf8');
}

let server = fs.readFileSync(serverPath, 'utf8');
if (!server.includes('/* LISTADO_API_V61 */')) {
  const antes = "  if (url.pathname === '/api/superadmin/usuarios' && req.method === 'GET') {";
  if (!server.includes(antes)) throw new Error('No se encontró el punto de inserción para listado autenticado.');
  const endpoint = `  /* LISTADO_API_V61 */\n  if (req.method === 'GET' && url.pathname === '/api/registros/listar') {\n    const base = await cargarBase();\n    const registros = base.listarRegistros({ busqueda: url.searchParams.get('busqueda') || '' });\n    responderJson(req, res, 200, { ok: true, registros });\n    return;\n  }\n\n`;
  server = server.replace(antes, endpoint + antes);

  const inicioEditar = "  if (req.method === 'PATCH' && url.pathname === '/api/registros/actualizar') {";
  const finEditar = "  if (req.method === 'POST' && url.pathname === '/api/registros/marcar-manual') {";
  const a = server.indexOf(inicioEditar), b = server.indexOf(finEditar, a);
  if (a < 0 || b < 0) throw new Error('No se encontró endpoint de edición.');
  let editar = server.slice(a, b);
  editar = reemplazarUna(
    editar,
    "    const campo = String(body.campo || '').trim();",
    "    const fila = Number(body.fila || 0);\n    const filaValida = Number.isInteger(fila) && fila >= 2;\n    const campo = String(body.campo || '').trim();",
    'la lectura de fila en edición'
  );
  editar = reemplazarUna(
    editar,
    "    const resultado = await base.actualizarCampoPorDocumento(documento, campo, valor);\n    responderJson(req, res, 200, { ok: true, ...resultado, actualizadoPor: usuarioPublico(usuario) });",
    "    let resultado;\n    if (filaValida) {\n      await base.actualizarCampos(fila, { [campo]: valor });\n      resultado = { row: fila, campo, valor };\n    } else {\n      resultado = await base.actualizarCampoPorDocumento(documento, campo, valor);\n    }\n    responderJson(req, res, 200, { ok: true, ...resultado, actualizadoPor: usuarioPublico(usuario) });",
    'la edición por fila exacta'
  );
  server = server.slice(0, a) + editar + server.slice(b);

  // Ingreso manual: respetar exactamente la visita abierta en el panel.
  const inicioManual = "  if (req.method === 'POST' && url.pathname === '/api/registros/marcar-manual') {";
  const finManual = "  if (req.method === 'POST' && url.pathname === '/api/registros/eliminar') {";
  const ma = server.indexOf(inicioManual), mb = server.indexOf(finManual, ma);
  if (ma >= 0 && mb > ma) {
    let manual = server.slice(ma, mb);
    if (!manual.includes('const fila = Number(body.fila || 0);')) {
      manual = reemplazarUna(
        manual,
        "    const documento = String(body.documento || '').trim();",
        "    const documento = String(body.documento || '').trim();\n    const fila = Number(body.fila || 0);\n    const filaValida = Number.isInteger(fila) && fila >= 2;",
        'la fila del ingreso manual'
      );
    }
    manual = manual.replace(
      "      const [registroExperiencia] = base.obtenerPendientes({ max: 1, documento });",
      "      const [registroExperiencia] = base.obtenerPendientes({ max: 1, documento, fila: filaValida ? fila : 0 });"
    );
    manual = manual.replace(
      "      const resultado = await base.marcarCompletadoManual(documento, responsable, usuario.usuario);",
      "      const resultado = filaValida\n        ? await base.marcarCompletadoManualFila(fila, responsable, usuario.usuario)\n        : await base.marcarCompletadoManual(documento, responsable, usuario.usuario);"
    );
    // Compatibilidad con el bloque anterior a la atribución v5.
    manual = manual.replace(
      "    const [registroExperiencia] = base.obtenerPendientes({ max: 1, documento });",
      "    const [registroExperiencia] = base.obtenerPendientes({ max: 1, documento, fila: filaValida ? fila : 0 });"
    );
    manual = manual.replace(
      "    const resultado = await base.marcarCompletadoManual(documento, usuario.usuario);",
      "    const resultado = filaValida\n      ? await base.marcarCompletadoManualFila(fila, usuario.usuario, usuario.usuario)\n      : await base.marcarCompletadoManual(documento, usuario.usuario);"
    );
    server = server.slice(0, ma) + manual + server.slice(mb);
  }

  // Eliminados: si el panel envía fila, nunca tocar otra visita con la misma cédula.
  const inicioEliminar = "  if (req.method === 'POST' && url.pathname === '/api/registros/eliminar') {";
  const finEliminar = "  if (req.method === 'GET' && url.pathname === '/api/admin/estadisticas') {";
  const ea = server.indexOf(inicioEliminar), eb = server.indexOf(finEliminar, ea);
  if (ea >= 0 && eb > ea) {
    let eliminar = server.slice(ea, eb);
    if (!eliminar.includes('const fila = Number(body.fila || 0);')) {
      eliminar = eliminar.replace(
        "    const documento = String(body.documento || '').trim();",
        "    const documento = String(body.documento || '').trim();\n    const fila = Number(body.fila || 0);\n    const filaValida = Number.isInteger(fila) && fila >= 2;"
      );
    }
    eliminar = eliminar.replace(
      "      const resultado = await base.marcarEliminado(documento, usuario.usuario, motivo);",
      "      const resultado = filaValida\n        ? await base.marcarEliminadoFila(fila, usuario.usuario, motivo)\n        : await base.marcarEliminado(documento, usuario.usuario, motivo);"
    );
    server = server.slice(0, ea) + eliminar + server.slice(eb);
  }

  fs.writeFileSync(serverPath, server, 'utf8');
}

console.log('[BIOFILE] Seguridad v6.1: listado autenticado, fila exacta y Eliminados restaurado habilitados.');
