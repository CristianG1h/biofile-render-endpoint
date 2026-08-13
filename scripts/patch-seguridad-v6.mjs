import fs from 'node:fs';

const browserPath = new URL('../src/browser.js', import.meta.url);
const biofilePath = new URL('../src/biofile.js', import.meta.url);
const sheetsPath = new URL('../src/google-sheets.js', import.meta.url);
const procesarPath = new URL('../src/procesar-registro.js', import.meta.url);
const serverPath = new URL('../src/server.js', import.meta.url);

function reemplazarUna(texto, buscar, reemplazo, etiqueta) {
  if (!texto.includes(buscar)) throw new Error(`No se encontró ${etiqueta}.`);
  return texto.replace(buscar, reemplazo);
}

function reemplazarEntre(texto, inicio, fin, nuevo, etiqueta) {
  const a = texto.indexOf(inicio);
  const b = texto.indexOf(fin, a + inicio.length);
  if (a < 0 || b < 0) throw new Error(`No se encontró ${etiqueta}.`);
  return texto.slice(0, a) + nuevo + texto.slice(b);
}

// ==================== SESIONES BIOFILE: SIEMPRE LIMPIAS ====================
let browser = fs.readFileSync(browserPath, 'utf8');
if (!browser.includes('/* SESION_LIMPIA_V6 */')) {
  browser = reemplazarUna(
    browser,
    "  if (fs.existsSync(config.browser.authPath)) contextOptions.storageState = config.browser.authPath;",
    `  /* SESION_LIMPIA_V6 */\n  // Correctitud > velocidad: cada trabajo inicia un contexto sin cookies previas.\n  // Esto evita que una sesión antigua de Aura/Luisa/otro usuario se reutilice\n  // accidentalmente después de cambios de credenciales o storageState corrupto.\n  if (fs.existsSync(config.browser.authPath)) {\n    fs.rmSync(config.browser.authPath, { force: true });\n    logger?.info('Sesión BIOFILE almacenada descartada antes de iniciar el trabajo.', {\n      authPath: config.browser.authPath\n    });\n  }`,
    'la reutilización de storageState en browser.js'
  );
  fs.writeFileSync(browserPath, browser, 'utf8');
}

// ==================== GUARDADO: DESPUÉS DEL ÉXITO NO SE REVIERTE A ERROR ====================
let biofile = fs.readFileSync(biofilePath, 'utf8');
if (!biofile.includes('/* GUARDADO_CONFIRMADO_V6 */')) {
  const metodo = `  async guardarYCerrarExito() {\n    /* GUARDADO_CONFIRMADO_V6 */\n    const guardar = await this.#accion('guardar', 'Guardar');\n    await guardar.click();\n\n    const exito = this.page.getByText(/Registro guardado con éxito/i).first();\n    try {\n      await exito.waitFor({ state: 'visible', timeout: this.config.browser.timeout });\n    } catch {\n      const captura = await this.captura('error-guardar');\n      const textos = await this.page.locator('body').innerText().catch(() => '');\n      const posibles = textos.split('\\n').filter((t) => /obligatorio|requerido|seleccione|error/i.test(t)).slice(0, 20);\n      throw new Error(\`Biofile no confirmó el guardado. Revisa \${captura}. Mensajes: \${posibles.join(' | ')}\`);\n    }\n\n    // Desde este punto BIOFILE confirmó que el registro fue guardado.\n    // Un fallo visual al cerrar NO puede convertir un guardado real en un ERROR reintentable.\n    let cerrado = false;\n    try {\n      const cerrar = await this.#accion('cerrarExito', 'Cerrar');\n      await cerrar.click();\n      await this.page.waitForTimeout(700);\n      cerrado = true;\n    } catch (error) {\n      this.logger?.warn('BIOFILE confirmó el guardado, pero no fue posible cerrar el mensaje de éxito. Se conserva el guardado como válido.', {\n        error: error.message\n      });\n    }\n\n    return { guardadoConfirmado: true, cerrado };\n  }\n\n`;
  biofile = reemplazarEntre(
    biofile,
    '  async guardarYCerrarExito() {',
    '  async obtenerNumeroOrden() {',
    metodo,
    'guardarYCerrarExito()'
  );
  fs.writeFileSync(biofilePath, biofile, 'utf8');
}

// ==================== GOOGLE SHEETS: IDEMPOTENCIA PERSISTENTE ====================
let sheets = fs.readFileSync(sheetsPath, 'utf8');
if (!sheets.includes('/* IDEMPOTENCIA_BIOFILE_V6 */')) {
  const columnas = "  'MOTIVO_ELIMINADO'\n];";
  if (!sheets.includes(columnas)) throw new Error('No se encontraron las columnas operativas v5 en google-sheets.js.');
  sheets = sheets.replace(
    columnas,
    `  'MOTIVO_ELIMINADO',\n  /* IDEMPOTENCIA_BIOFILE_V6 */\n  'JOB_ID_BIOFILE',\n  'SOLICITADO_POR_BIOFILE',\n  'GUARDADO_INTENTADO_BIOFILE',\n  'GUARDADO_CONFIRMADO_BIOFILE',\n  'ULTIMA_ETAPA_BIOFILE',\n  'SESION_BIOFILE_USUARIO'\n];`
  );

  const filtro = `      const estado = normalizar(this.#get(row, 'ESTADO_BIOFILE'));\n      if (estado && !['PENDIENTE', 'ERROR'].includes(estado)) continue;`;
  sheets = reemplazarUna(
    sheets,
    filtro,
    `      const estado = normalizar(this.#get(row, 'ESTADO_BIOFILE'));\n      if (estado && !['PENDIENTE', 'ERROR'].includes(estado)) continue;\n\n      // Los ERROR históricos son potencialmente inseguros: antes de v6 un guardado\n      // exitoso podía quedar marcado como ERROR. Solo se reintenta un ERROR cuando\n      // v6 dejó constancia explícita de que nunca se intentó Guardar.\n      if (estado === 'ERROR') {\n        const guardarIntentado = normalizar(this.#get(row, 'GUARDADO_INTENTADO_BIOFILE'));\n        if (guardarIntentado !== 'NO') continue;\n      }`,
    'el filtro de registros reintentables'
  );

  const metodos = `  async marcarProcesando(row, usuario = '', jobId = '') {\n    const actual = Number(this.#getRaw(row, 'INTENTOS_BIOFILE') || 0);\n    await this.#actualizar(row, {\n      ESTADO_BIOFILE: 'PROCESANDO',\n      INTENTOS_BIOFILE: actual + 1,\n      ERROR_BIOFILE: '',\n      USUARIO_BIOFILE: usuario || this.#get(row, 'USUARIO_BIOFILE'),\n      MODO_INGRESO_BIOFILE: 'AUTOMATICO',\n      FECHA_BIOFILE_ISO: fechaIsoBogota(),\n      JOB_ID_BIOFILE: jobId || this.#get(row, 'JOB_ID_BIOFILE'),\n      SOLICITADO_POR_BIOFILE: usuario || this.#get(row, 'SOLICITADO_POR_BIOFILE'),\n      GUARDADO_INTENTADO_BIOFILE: 'NO',\n      GUARDADO_CONFIRMADO_BIOFILE: '',\n      ULTIMA_ETAPA_BIOFILE: 'PREPARANDO',\n      SESION_BIOFILE_USUARIO: ''\n    });\n  }\n\n  async marcarSesionVerificada(row, usuario = '', jobId = '') {\n    await this.#actualizar(row, {\n      JOB_ID_BIOFILE: jobId || this.#get(row, 'JOB_ID_BIOFILE'),\n      SESION_BIOFILE_USUARIO: usuario,\n      ULTIMA_ETAPA_BIOFILE: 'SESION_VERIFICADA'\n    });\n  }\n\n  async marcarGuardando(row, usuario = '', jobId = '') {\n    await this.#actualizar(row, {\n      ESTADO_BIOFILE: 'GUARDANDO',\n      FECHA_BIOFILE_ISO: fechaIsoBogota(),\n      JOB_ID_BIOFILE: jobId || this.#get(row, 'JOB_ID_BIOFILE'),\n      USUARIO_BIOFILE: usuario || this.#get(row, 'USUARIO_BIOFILE'),\n      GUARDADO_INTENTADO_BIOFILE: 'SI',\n      ULTIMA_ETAPA_BIOFILE: 'GUARDAR_ENVIADO'\n    });\n  }\n\n  async marcarOrdenCreada(row, numeroOrden, usuario = '', jobId = '') {\n    await this.#actualizar(row, {\n      ESTADO_BIOFILE: 'ORDEN_CREADA',\n      NUMERO_OS_BIOFILE: numeroOrden || this.#get(row, 'NUMERO_OS_BIOFILE'),\n      FECHA_BIOFILE: fechaHoraBogota(),\n      FECHA_BIOFILE_ISO: fechaIsoBogota(),\n      USUARIO_BIOFILE: usuario || this.#get(row, 'USUARIO_BIOFILE'),\n      MODO_INGRESO_BIOFILE: 'AUTOMATICO',\n      JOB_ID_BIOFILE: jobId || this.#get(row, 'JOB_ID_BIOFILE'),\n      GUARDADO_INTENTADO_BIOFILE: 'SI',\n      GUARDADO_CONFIRMADO_BIOFILE: 'SI',\n      ULTIMA_ETAPA_BIOFILE: 'ORDEN_CREADA'\n    });\n  }\n\n  async marcarCompletado(row, numeroOrden, usuario = '', modo = 'AUTOMATICO') {\n    await this.#actualizar(row, {\n      ESTADO_BIOFILE: 'COMPLETADO',\n      NUMERO_OS_BIOFILE: numeroOrden || this.#get(row, 'NUMERO_OS_BIOFILE'),\n      FECHA_BIOFILE: fechaHoraBogota(),\n      FECHA_BIOFILE_ISO: fechaIsoBogota(),\n      ERROR_BIOFILE: '',\n      USUARIO_BIOFILE: usuario || this.#get(row, 'USUARIO_BIOFILE'),\n      MODO_INGRESO_BIOFILE: String(modo || 'AUTOMATICO').toUpperCase(),\n      REGISTRADO_POR_BIOFILE: usuario || this.#get(row, 'REGISTRADO_POR_BIOFILE'),\n      GUARDADO_CONFIRMADO_BIOFILE: normalizar(modo) === 'MANUAL' ? this.#get(row, 'GUARDADO_CONFIRMADO_BIOFILE') : 'SI',\n      ULTIMA_ETAPA_BIOFILE: 'COMPLETADO'\n    });\n  }\n\n`;
  sheets = reemplazarEntre(
    sheets,
    '  async marcarProcesando(row, usuario = \'\') {',
    '  async marcarCompletadoManual(',
    metodos,
    'los métodos de estado automático de Google Sheets'
  );

  const errorNuevo = `  async marcarError(row, error, { parcial = false, numeroOrden = '', usuario = '', guardarIntentado = false, jobId = '' } = {}) {\n    const estadoSeguro = parcial ? 'PARCIAL' : guardarIntentado ? 'REVISAR_BIOFILE' : 'ERROR';\n    await this.#actualizar(row, {\n      ESTADO_BIOFILE: estadoSeguro,\n      NUMERO_OS_BIOFILE: numeroOrden || this.#get(row, 'NUMERO_OS_BIOFILE'),\n      FECHA_BIOFILE: fechaHoraBogota(),\n      FECHA_BIOFILE_ISO: fechaIsoBogota(),\n      ERROR_BIOFILE: String(error?.message || error).slice(0, 5000),\n      USUARIO_BIOFILE: usuario || this.#get(row, 'USUARIO_BIOFILE'),\n      MODO_INGRESO_BIOFILE: 'AUTOMATICO',\n      JOB_ID_BIOFILE: jobId || this.#get(row, 'JOB_ID_BIOFILE'),\n      GUARDADO_INTENTADO_BIOFILE: guardarIntentado ? 'SI' : (this.#get(row, 'GUARDADO_INTENTADO_BIOFILE') || 'NO'),\n      GUARDADO_CONFIRMADO_BIOFILE: parcial ? 'SI' : this.#get(row, 'GUARDADO_CONFIRMADO_BIOFILE'),\n      ULTIMA_ETAPA_BIOFILE: estadoSeguro\n    });\n  }\n\n`;
  sheets = reemplazarEntre(
    sheets,
    '  async marcarError(row, error,',
    '  obtenerEstadisticasUsuarios(',
    errorNuevo,
    'marcarError()'
  );

  sheets = sheets.replace(
    "else if (['ERROR', 'PARCIAL'].includes(estado)) actual.errores += 1;",
    "else if (['ERROR', 'PARCIAL', 'REVISAR_BIOFILE'].includes(estado)) actual.errores += 1;"
  );

  fs.writeFileSync(sheetsPath, sheets, 'utf8');
}

// ==================== PROCESADOR: CLAIM TEMPRANO + BARRERA ANTES DE GUARDAR ====================
let procesar = fs.readFileSync(procesarPath, 'utf8');
if (!procesar.includes('/* SEGURIDAD_PROCESO_V6 */')) {
  procesar = reemplazarUna(
    procesar,
    "  let ordenCreada = false;\n  let marcadoProcesando = false;",
    "  let ordenCreada = false;\n  let marcadoProcesando = false;\n  /* SEGURIDAD_PROCESO_V6 */\n  let guardarIntentado = false;",
    'las banderas de procesamiento'
  );

  procesar = reemplazarUna(
    procesar,
    "  try {\n    await reportar(27, 'Abriendo navegador BIOFILE', 'Creando la sesión privada de este usuario.');",
    "  try {\n    // Reclama la fila antes de abrir BIOFILE para que el estado persistente deje de ser PENDIENTE.\n    await base.marcarProcesando(registro.row, usuario.usuario, jobId);\n    marcadoProcesando = true;\n    await reportar(27, 'Abriendo navegador BIOFILE', 'Creando la sesión privada de este usuario.');",
    'el inicio del try del procesador'
  );

  procesar = reemplazarUna(
    procesar,
    "    await sesion.asegurarLogin();\n    await reportar(42, 'Abriendo nueva orden', 'Ingresando al formulario de órdenes de servicios de salud ocupacional.');",
    "    await sesion.asegurarLogin();\n    await base.marcarSesionVerificada(registro.row, usuario.usuario, jobId);\n    await reportar(42, 'Abriendo nueva orden', 'Ingresando al formulario de órdenes de servicios de salud ocupacional.');",
    'la verificación de sesión'
  );

  procesar = reemplazarUna(
    procesar,
    "    await base.marcarProcesando(registro.row, usuario.usuario);\n    marcadoProcesando = true;\n\n    await reportar(78, 'Guardando orden en BIOFILE', 'Enviando el formulario y esperando la confirmación de BIOFILE.');",
    "    // Barrera persistente de idempotencia: desde aquí un fallo NUNCA vuelve a ERROR reintentable.\n    await base.marcarGuardando(registro.row, usuario.usuario, jobId);\n    guardarIntentado = true;\n\n    await reportar(78, 'Guardando orden en BIOFILE', 'Enviando el formulario y esperando la confirmación de BIOFILE.');",
    'el marcado previo al Guardar'
  );

  procesar = reemplazarUna(
    procesar,
    "    await biofile.guardarYCerrarExito();\n    numeroOrden = await biofile.obtenerNumeroOrden();\n    ordenCreada = true;\n    await reportar(84, 'Orden creada correctamente',",
    "    await biofile.guardarYCerrarExito();\n    // El mensaje de éxito de BIOFILE ya es suficiente para considerar creada la orden.\n    // La lectura de O.S. o el cierre visual no pueden volverla a un estado reintentable.\n    ordenCreada = true;\n    numeroOrden = await biofile.obtenerNumeroOrden();\n    await reportar(84, 'Orden creada correctamente',",
    'el orden de confirmación del primer guardado'
  );

  procesar = procesar.replace(
    "await base.marcarOrdenCreada(registro.row, numeroOrden, usuario.usuario);",
    "await base.marcarOrdenCreada(registro.row, numeroOrden, usuario.usuario, jobId);"
  );

  procesar = reemplazarUna(
    procesar,
    "      parcial: ordenCreada,\n      numeroOrden,\n      usuario: usuario.usuario\n    })",
    "      parcial: ordenCreada,\n      numeroOrden,\n      usuario: usuario.usuario,\n      guardarIntentado,\n      jobId\n    })",
    'los datos de marcarError()'
  );

  procesar = reemplazarUna(
    procesar,
    "      estado: ordenCreada ? 'PARCIAL' : 'ERROR'",
    "      estado: ordenCreada ? 'PARCIAL' : guardarIntentado ? 'REVISAR_BIOFILE' : 'ERROR'",
    'el estado público del error'
  );

  fs.writeFileSync(procesarPath, procesar, 'utf8');
}

// ==================== API: SOLO BEARER + DOCUMENTO CANÓNICO + AUDITORÍA ====================
let server = fs.readFileSync(serverPath, 'utf8');
if (!server.includes('/* AUTH_BEARER_ONLY_V6 */')) {
  server = server.replace(
    "    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');",
    "    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');"
  );

  const authNuevo = `function autenticar(req) {\n  /* AUTH_BEARER_ONLY_V6 */\n  limpiarSesiones();\n  const token = extraerBearer(req);\n  if (!token) return null;\n  const sesion = sesiones.get(token);\n  if (!sesion || sesion.expiraEn <= Date.now() || !sesion.usuario) return null;\n  sesion.expiraEn = Date.now() + config.api.sessionTtlMs;\n  return { usuario: sesion.usuario, token, legado: false };\n}\n\n`;
  server = reemplazarEntre(
    server,
    'function autenticar(req) {',
    'function crearSesionPanel(usuario) {',
    authNuevo,
    'autenticar()'
  );

  server = reemplazarUna(
    server,
    "function documentoValido(valor) {\n  return /^[A-Za-z0-9.\\-\\s]{4,30}$/.test(String(valor || '').trim());\n}",
    `function documentoValido(valor) {\n  return /^[A-Za-z0-9.\\-\\s]{4,30}$/.test(String(valor || '').trim());\n}\n\n/* DOCUMENTO_CLAVE_V6 */\nfunction documentoClave(valor) {\n  return String(valor || '').trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase();\n}`,
    'documentoValido()'
  );

  server = server.replace(
    "    if (actualizado.activo === false) invalidarSesionesUsuario(actualizado.id);",
    "    invalidarSesionesUsuario(actualizado.id);"
  );

  server = server.replace(
    "    const documento = String(body.documento || '').trim().replace(/\\s+/g, '');",
    "    const documento = documentoClave(body.documento);"
  );

  const respuestaEncolar = `    const { job, duplicado } = encolar({ documento, fila, subirImagenes, usuario });\n\n    responderJson(req, res, duplicado ? 409 : 202, {`;
  server = reemplazarUna(
    server,
    respuestaEncolar,
    `    const { job, duplicado } = encolar({ documento, fila, subirImagenes, usuario });\n\n    await usuariosStore.registrarAuditoria(\n      usuario.usuario,\n      duplicado ? 'ENVIO_DUPLICADO_BLOQUEADO' : 'SOLICITAR_INGRESO_AUTOMATICO',\n      documento,\n      'Job: ' + job.id + (duplicado ? ' | Ya estaba activo con: ' + job.usuarioNombre : '')\n    ).catch(() => {});\n\n    responderJson(req, res, duplicado ? 409 : 202, {`,
    'la auditoría al encolar'
  );

  server = reemplazarUna(
    server,
    "        job.estado = 'completado';\n        job.progreso = 100;",
    "        job.estado = 'completado';\n        await usuariosStore.registrarAuditoria(usuario.usuario, 'INGRESO_AUTOMATICO_COMPLETADO', job.documento, 'Job: ' + job.id + ' | O.S.: ' + (job.resultado?.numeroOrden || job.numeroOrden || '')).catch(() => {});\n        job.progreso = 100;",
    'la auditoría de trabajo completado'
  );

  server = reemplazarUna(
    server,
    "        job.estado = 'error';\n        job.progreso = 100;",
    "        job.estado = 'error';\n        await usuariosStore.registrarAuditoria(usuario.usuario, 'INGRESO_AUTOMATICO_ERROR', job.documento, 'Job: ' + job.id + ' | ' + error.message + (error.detalle?.estado ? ' | Estado: ' + error.detalle.estado : '')).catch(() => {});\n        job.progreso = 100;",
    'la auditoría de trabajo con error'
  );

  fs.writeFileSync(serverPath, server, 'utf8');
}

console.log('[BIOFILE] Seguridad v6: idempotencia, sesión limpia, Bearer-only y auditoría reforzada habilitadas.');
