import fs from 'node:fs';

const serverPath = new URL('../src/server.js', import.meta.url);
const procesarPath = new URL('../src/procesar-registro.js', import.meta.url);
const biofilePath = new URL('../src/biofile.js', import.meta.url);
const MARCA = 'CATALOGO_PAQUETES_BIOFILE_V7';

function reemplazarUna(texto, buscar, reemplazo, etiqueta) {
  if (!texto.includes(buscar)) throw new Error('No se encontró ' + etiqueta + '.');
  return texto.replace(buscar, reemplazo);
}

// ==================== API + COLA DE CATÁLOGO ====================
let server = fs.readFileSync(serverPath, 'utf8');
if (!server.includes('/* ' + MARCA + '_SERVER */')) {
  server = reemplazarUna(
    server,
    "import { UsuariosBiofileStore, normalizarUsuario } from './usuarios-store.js';",
    "import { UsuariosBiofileStore, normalizarUsuario } from './usuarios-store.js';\n" +
    "import { CatalogoPaquetesBiofileStore, TIPOS_EVALUACION_BIOFILE, claveEmpresaCatalogo, normalizarTipoEvaluacion } from './catalogo-paquetes-biofile.js';\n" +
    "import { investigarPaquetesEmpresaBiofile } from './investigar-paquetes-biofile.js';",
    'los imports del servidor'
  );

  const antesCampos = 'const CAMPOS_EDITABLES = new Set([';
  if (!server.includes(antesCampos)) throw new Error('No se encontró CAMPOS_EDITABLES.');

  const soporteCatalogo = `
/* CATALOGO_PAQUETES_BIOFILE_V7_SERVER */
const catalogoStore = new CatalogoPaquetesBiofileStore({
  google: config.google,
  hojaEmpresas: process.env.BIOFILE_CATALOG_EMPRESAS_SHEET || 'CATALOGO_EMPRESAS_BIOFILE',
  hojaPaquetes: process.env.BIOFILE_CATALOG_PAQUETES_SHEET || 'CATALOGO_PAQUETES_BIOFILE',
  ttlMs: Number(process.env.BIOFILE_CATALOG_TTL_MS || 24 * 60 * 60 * 1000)
});
const investigacionesCatalogo = new Map();
let colaGlobalCatalogo = Promise.resolve();
const CATALOGO_REINTENTO_ERROR_MS = Number(process.env.BIOFILE_CATALOG_ERROR_RETRY_MS || 15 * 60 * 1000);

function usuarioCatalogoAutomatico() {
  const usuarioDirecto = String(process.env.BIOFILE_CATALOG_USER || '').trim();
  const passwordDirecto = String(process.env.BIOFILE_CATALOG_PASSWORD || process.env.BIOFILE_CATALOG_PASS || '');
  if (usuarioDirecto && passwordDirecto) {
    return {
      id: 'env_catalogo',
      usuario: usuarioDirecto,
      contrasena: passwordDirecto,
      rol: 'admin',
      activo: true,
      fuente: 'render-catalogo'
    };
  }

  const candidatos = [...config.usuariosEntorno].sort((a, b) => {
    const peso = (u) => u.rol === 'superadmin' ? 0 : u.rol === 'admin' ? 1 : 2;
    return peso(a) - peso(b);
  });
  return candidatos[0] || null;
}

function programarInvestigacionCatalogo(empresa, { force = false, usuarioPreferido = null } = {}) {
  const nombre = String(empresa || '').trim();
  const clave = claveEmpresaCatalogo(nombre);
  if (!clave) return Promise.reject(new Error('La empresa es obligatoria.'));

  const activa = investigacionesCatalogo.get(clave);
  if (activa) return activa;
  if (investigacionesCatalogo.size >= 25) {
    return Promise.reject(new Error('La cola de actualización del catálogo está temporalmente llena.'));
  }

  const ejecutar = async () => {
    const actual = await catalogoStore.obtener(nombre).catch(() => null);
    const errorReciente = String(actual?.estado || '').toUpperCase() === 'ERROR' &&
      Date.now() - (Date.parse(actual?.ultimaRevisionIso || '') || 0) < CATALOGO_REINTENTO_ERROR_MS;
    if ((actual?.fresca || errorReciente) && !force) return actual;

    const usuario = usuarioPreferido?.usuario && usuarioPreferido?.contrasena
      ? usuarioPreferido
      : usuarioCatalogoAutomatico();

    if (!usuario) {
      throw new Error('No hay un usuario BIOFILE disponible en Render para actualizar el catálogo.');
    }

    const investigacion = await investigarPaquetesEmpresaBiofile({
      empresa: actual?.acuerdoExacto || nombre,
      usuario
    });

    return catalogoStore.guardarInvestigacion({
      empresaBuscada: nombre,
      acuerdoExacto: investigacion.acuerdoExacto || actual?.acuerdoExacto || nombre,
      paquetes: investigacion.paquetes,
      estado: 'OK',
      error: ''
    });
  };

  // Las investigaciones se serializan globalmente. Así un formulario público
  // no puede abrir decenas de navegadores BIOFILE al mismo tiempo.
  const promesa = colaGlobalCatalogo
    .catch(() => {})
    .then(ejecutar)
    .catch(async (error) => {
      console.error('[CATALOGO] Error investigando "' + nombre + '":', error.message);
      await catalogoStore.guardarError(nombre, error).catch(() => {});
      throw error;
    })
    .finally(() => {
      if (investigacionesCatalogo.get(clave) === promesa) investigacionesCatalogo.delete(clave);
    });

  colaGlobalCatalogo = promesa.catch(() => {});
  investigacionesCatalogo.set(clave, promesa);
  return promesa;
}

function precargarCatalogoSinEsperar(empresa, opciones = {}) {
  programarInvestigacionCatalogo(empresa, opciones).catch(() => {});
}
`;
  server = server.replace(antesCampos, soporteCatalogo + '\n' + antesCampos);

  server = reemplazarUna(
    server,
    'function encolar({ documento, fila, subirImagenes, usuario }) {',
    'function encolar({ documento, fila, subirImagenes, empresaCatalogo, tipoEvaluacion, paquete, usuario }) {',
    'la firma de encolar()'
  );

  server = reemplazarUna(
    server,
    "    subirImagenes,\n    usuarioId: usuario.id,",
    "    subirImagenes,\n    empresaCatalogo: empresaCatalogo || '',\n    tipoEvaluacion: tipoEvaluacion || TIPOS_EVALUACION_BIOFILE[0],\n    paquete: paquete || 'NO APLICA',\n    usuarioId: usuario.id,",
    'los datos del trabajo'
  );

  server = reemplazarUna(
    server,
    "    subirImagenes: job.subirImagenes,\n    usuario: {",
    "    subirImagenes: job.subirImagenes,\n    empresaCatalogo: job.empresaCatalogo || '',\n    tipoEvaluacion: job.tipoEvaluacion || TIPOS_EVALUACION_BIOFILE[0],\n    paquete: job.paquete || 'NO APLICA',\n    usuario: {",
    'la respuesta pública del trabajo'
  );

  server = reemplazarUna(
    server,
    "          subirImagenes: job.subirImagenes,\n          jobId: job.id,",
    "          subirImagenes: job.subirImagenes,\n          empresaCatalogo: job.empresaCatalogo,\n          tipoEvaluacion: job.tipoEvaluacion,\n          paquete: job.paquete,\n          jobId: job.id,",
    'los parámetros enviados al procesador'
  );

  const antesLogin = "  if (req.method === 'POST' && url.pathname === '/api/auth/login') {";
  if (!server.includes(antesLogin)) throw new Error('No se encontró el endpoint de login.');
  const publico = `
  if (req.method === 'POST' && url.pathname === '/api/catalogo/precargar') {
    const body = await leerJson(req);
    const empresa = String(body.empresa || '').trim();
    if (empresa.length < 3 || empresa.length > 180) {
      responderJson(req, res, 400, { ok: false, error: 'El nombre de la empresa no es válido.' });
      return;
    }
    precargarCatalogoSinEsperar(empresa);
    responderJson(req, res, 202, {
      ok: true,
      empresa,
      mensaje: 'Empresa recibida. El catálogo se actualizará en segundo plano si hace falta.'
    });
    return;
  }

`;
  server = server.replace(antesLogin, publico + antesLogin);

  const despuesLogout = "  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {\n    if (autenticacion.token) sesiones.delete(autenticacion.token);\n    responderJson(req, res, 200, { ok: true });\n    return;\n  }\n";
  if (!server.includes(despuesLogout)) throw new Error('No se encontró el endpoint logout.');
  const endpoints = `

  if (req.method === 'GET' && url.pathname === '/api/catalogo/empresa') {
    const empresa = String(url.searchParams.get('empresa') || '').trim();
    if (empresa.length < 3) {
      responderJson(req, res, 400, { ok: false, error: 'Indica el nombre de la empresa.' });
      return;
    }

    const catalogo = await catalogoStore.obtener(empresa);
    const errorReciente = String(catalogo?.estado || '').toUpperCase() === 'ERROR' &&
      Date.now() - (Date.parse(catalogo?.ultimaRevisionIso || '') || 0) < CATALOGO_REINTENTO_ERROR_MS;
    const actualizando = !catalogo?.fresca && !errorReciente;
    if (actualizando) precargarCatalogoSinEsperar(empresa, { usuarioPreferido: usuario });

    responderJson(req, res, 200, {
      ok: true,
      empresa,
      catalogo,
      actualizando,
      tiposEvaluacion: TIPOS_EVALUACION_BIOFILE
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/catalogo/refrescar') {
    const body = await leerJson(req);
    const empresa = String(body.empresa || '').trim();
    if (empresa.length < 3) {
      responderJson(req, res, 400, { ok: false, error: 'Indica el nombre de la empresa.' });
      return;
    }
    precargarCatalogoSinEsperar(empresa, { force: true, usuarioPreferido: usuario });
    responderJson(req, res, 202, { ok: true, empresa, actualizando: true });
    return;
  }
`;
  server = server.replace(despuesLogout, despuesLogout + endpoints);

  const envioViejo = "    const subirImagenes = body.subirImagenes !== false;\n    const { job, duplicado } = encolar({ documento, fila, subirImagenes, usuario });";
  if (!server.includes(envioViejo)) throw new Error('No se encontró el bloque de envío a BIOFILE.');
  const envioNuevo = `    const subirImagenes = body.subirImagenes !== false;
    const empresaCatalogo = String(body.empresa || '').trim();
    const tipoEvaluacion = normalizarTipoEvaluacion(body.tipoEvaluacion || TIPOS_EVALUACION_BIOFILE[0]);
    let paquete = String(body.paquete || 'NO APLICA').trim() || 'NO APLICA';

    if (!tipoEvaluacion) {
      responderJson(req, res, 400, { ok: false, error: 'El tipo de evaluación seleccionado no es válido.' });
      return;
    }

    if (normalizarUsuario(paquete) !== normalizarUsuario('NO APLICA')) {
      if (!empresaCatalogo) {
        responderJson(req, res, 400, { ok: false, error: 'Para usar un paquete debes indicar la empresa/acuerdo comercial.' });
        return;
      }
      const validacionPaquete = await catalogoStore.validarPaquete(empresaCatalogo, tipoEvaluacion, paquete);
      if (!validacionPaquete.ok) {
        responderJson(req, res, 409, { ok: false, error: validacionPaquete.error });
        return;
      }
      paquete = validacionPaquete.paquete;
    } else {
      paquete = 'NO APLICA';
    }

    const { job, duplicado } = encolar({
      documento,
      fila,
      subirImagenes,
      empresaCatalogo,
      tipoEvaluacion,
      paquete,
      usuario
    });`;
  server = server.replace(envioViejo, envioNuevo);

  const initAnchor = "if (usuariosStore.disponible()) {";
  if (!server.includes(initAnchor)) throw new Error('No se encontró la inicialización de usuariosStore.');
  server = server.replace(
    initAnchor,
    "catalogoStore.inicializar().catch((error) => {\n" +
    "  console.error('[CATALOGO] No fue posible preparar las hojas del catálogo:', error.message);\n" +
    "});\n\n" + initAnchor
  );

  fs.writeFileSync(serverPath, server, 'utf8');
}

// ==================== PROCESADOR: OVERRIDES DE TIPO Y PAQUETE ====================
let procesar = fs.readFileSync(procesarPath, 'utf8');
if (!procesar.includes('/* ' + MARCA + '_PROCESAR */')) {
  if (!procesar.includes("import { normalizarTipoEvaluacion } from './catalogo-paquetes-biofile.js';")) {
    const importAnchor = "import { resolverRelacionEmpresaRegistro } from './relacion-empresa.js';";
    if (procesar.includes(importAnchor)) {
      procesar = procesar.replace(
        importAnchor,
        importAnchor + "\nimport { normalizarTipoEvaluacion } from './catalogo-paquetes-biofile.js';"
      );
    } else {
      procesar = reemplazarUna(
        procesar,
        "import { notificarExperiencia } from './experiencia.js';",
        "import { notificarExperiencia } from './experiencia.js';\nimport { normalizarTipoEvaluacion } from './catalogo-paquetes-biofile.js';",
        'el import de experiencia'
      );
    }
  }

  procesar = reemplazarUna(
    procesar,
    "  subirImagenes = true,\n  jobId = '',",
    "  subirImagenes = true,\n  empresaCatalogo = '',\n  tipoEvaluacion = '',\n  paquete = 'NO APLICA',\n  jobId = '',",
    'la firma del procesador'
  );

  const llenarAnchor = '    const resultadoLlenado = await biofile.llenarOrden(registro, defaults);';
  if (!procesar.includes(llenarAnchor)) throw new Error('No se encontró el llenado principal.');
  const override = `    /* CATALOGO_PAQUETES_BIOFILE_V7_PROCESAR */
    const tipoEvaluacionSeleccionado = normalizarTipoEvaluacion(tipoEvaluacion || defaults.tipoEvaluacion);
    if (!tipoEvaluacionSeleccionado) {
      throw new Error('El tipo de evaluación recibido no es válido para BIOFILE.');
    }
    defaults.tipoEvaluacion = tipoEvaluacionSeleccionado;
    defaults.paquete = String(paquete || 'NO APLICA').trim() || 'NO APLICA';
    if (String(empresaCatalogo || '').trim()) {
      // El acuerdo exacto que validó el catálogo debe ser el mismo sobre el cual
      // BIOFILE seleccionará el paquete.
      defaults.acuerdo = String(empresaCatalogo).trim();
    }

    logger.info('Tipo de evaluación y paquete preparados para la orden.', {
      empresaPanel: empresaCatalogo || '',
      tipoEvaluacion: defaults.tipoEvaluacion,
      paquete: defaults.paquete
    });

`;
  procesar = procesar.replace(llenarAnchor, override + llenarAnchor);
  fs.writeFileSync(procesarPath, procesar, 'utf8');
}

// ==================== BIOFILE: AUTOCOMPLETADO DINÁMICO ====================
let biofile = fs.readFileSync(biofilePath, 'utf8');
if (!biofile.includes('/* ' + MARCA + '_BIOFILE */')) {
  const tipoFijo = `      'TIPO DE EVALUACION MEDICA O PROCEDIMIENTO': {
        buscar: 'INGRES',
        seleccionar: 'EVALUACIÓN MÉDICA OCUPACIONAL DE INGRESO'
      },`;
  const tipoDinamico = `      /* CATALOGO_PAQUETES_BIOFILE_V7_BIOFILE */
      'TIPO DE EVALUACION MEDICA O PROCEDIMIENTO': {
        buscar: valorOriginal,
        seleccionar: valorOriginal
      },`;
  biofile = reemplazarUna(biofile, tipoFijo, tipoDinamico, 'la regla fija de tipo de evaluación');

  const paqueteFijo = `      'NOMBRE DEL PAQUETE': {
        buscar: 'NO APL',
        seleccionar: 'NO APLICA'
      },`;
  const paqueteDinamico = `      'NOMBRE DEL PAQUETE': {
        buscar: valorOriginal,
        seleccionar: valorOriginal
      },`;
  biofile = reemplazarUna(biofile, paqueteFijo, paqueteDinamico, 'la regla fija de paquete');

  fs.writeFileSync(biofilePath, biofile, 'utf8');
}

console.log('[BIOFILE] v7: catálogo de paquetes, tipos de evaluación dinámicos y caché de 24 horas habilitados.');
