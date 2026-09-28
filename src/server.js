import { reconcileLegacy } from './jobs/recovery.js';
import { purgeDiagnostics } from './diagnostic-store.js';
import { JobStore } from './jobs/job-store.js';
import { JobService } from './jobs/job-service.js';
import { createNationalApi } from './nacionales/index.js';
import { cerrarNavegador } from './browser.js';
import crypto from 'node:crypto';
import http from 'node:http';
import { config, validarConfiguracion } from './config.js';
import { BaseGoogleSheets } from './google-sheets.js';
import { procesarRegistroBiofile } from './procesar-registro.js';
import { notificarExperiencia } from './experiencia.js';
import { UsuariosBiofileStore, normalizarUsuario } from './usuarios-store.js';
import { DirectorioEmpresasBiofileStore, sincronizarEmpresasDesdeBiofile } from './directorio-empresas-biofile.js';
import { CatalogoPaquetesBiofileStore, TIPOS_EVALUACION_BIOFILE, claveEmpresaCatalogo, normalizarTipoEvaluacion } from './catalogo-paquetes-biofile.js';
import { investigarPaquetesEmpresaBiofile } from './investigar-paquetes-biofile.js';

const jobService = new JobService(new JobStore(config.google));
const jobs = jobService.jobs;
let jobsError = null;
const jobsReady = jobService.init().then(async () => { await reconcileLegacy(await cargarBase(), jobs); }).catch(error => { jobsError = error; console.error('[JOBS] Persistencia no disponible; nuevos envíos bloqueados.'); });
jobService.onSettled = async job => {
  await usuariosStore.registrarAuditoria(job.usuarioNombre, job.estado === 'completado' ? 'INGRESO_AUTOMATICO_COMPLETADO' : 'INGRESO_AUTOMATICO_ERROR', job.documento || '', `Job: ${job.id} | Estado: ${job.estado} | Orden: ${job.numeroOrden || ''}`).catch(() => { job.auditoriaPendiente = true; });
  if (job.kind !== 'legacy-job' || !job.fila || job.estado === 'completado') return;
  const base = await new BaseGoogleSheets({ ...config.google, logger:null }).cargar({ fila:job.fila });
  await base.actualizarCampos(job.fila, {
    ESTADO_BIOFILE:job.numeroOrden || job.guardadoConfirmado ? 'PARCIAL' : job.guardadoIntentado ? 'REVISAR_BIOFILE' : job.estado === 'interrumpido' ? 'INTERRUMPIDO' : 'ERROR',
    NUMERO_OS_BIOFILE:job.numeroOrden || '',
    ERROR_BIOFILE:job.error?.mensaje || 'Trabajo interrumpido',
    GUARDADO_INTENTADO_BIOFILE:job.guardadoIntentado?'SI':'NO',
    ULTIMA_ETAPA_BIOFILE:job.etapa,
    JOB_ID_BIOFILE:job.id
  });
};
async function requireJobs() { await jobsReady; if (jobsError) throw Object.assign(new Error('Persistencia de trabajos no disponible. Revise la configuración de Google Sheets.'), { statusCode: 503 }); }
const nationalApi = createNationalApi({ service: jobService, ready: jobsReady, send: responderJson, companies: async () => directorioEmpresasStore.listar(), screenshotsRoot: config.paths.screenshots });
const sesiones = new Map();
let servidor;

const usuariosStore = new UsuariosBiofileStore({
  google: config.google,
  hojaUsuarios: config.usuariosStore.hojaUsuarios,
  hojaAuditoria: config.usuariosStore.hojaAuditoria,
  encryptionKey: config.seguridad.encryptionKey
});


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

/* DIRECTORIO_EMPRESAS_BIOFILE_V74 */
const directorioEmpresasStore = new DirectorioEmpresasBiofileStore({ google: config.google });
let sincronizacionEmpresasActiva = null;
const DIRECTORIO_SYNC_INTERVAL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.BIOFILE_CLIENTES_SYNC_INTERVAL_MS || 24 * 60 * 60 * 1000)
);

function usuarioDirectorioEmpresas(preferido = null) {
  if (preferido?.usuario && preferido?.contrasena) return preferido;
  return typeof usuarioCatalogoAutomatico === 'function' ? usuarioCatalogoAutomatico() : (config.usuariosEntorno[0] || null);
}

/* DIRECTORIO_EMPRESAS_DIARIO_V74B */
function diaBogotaDirectorio(fecha = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(fecha);
}

function proximoDiaBogotaIso() {
  const hoy = diaBogotaDirectorio(new Date());
  const [y, m, d] = hoy.split('-').map(Number);
  // Colombia permanece en UTC-5: 00:05 local equivale a 05:05 UTC.
  return new Date(Date.UTC(y, m - 1, d + 1, 5, 5, 0)).toISOString();
}

async function directorioVencido() {
  const estado = await directorioEmpresasStore.obtenerEstado().catch(() => ({}));
  const ultimo = Date.parse(estado.ultimoExitoIso || '') || 0;
  const cambioDeDia = !ultimo || diaBogotaDirectorio(new Date(ultimo)) !== diaBogotaDirectorio(new Date());
  const superoIntervalo = !ultimo || Date.now() - ultimo >= DIRECTORIO_SYNC_INTERVAL_MS;
  return { estado, vencido: cambioDeDia || superoIntervalo };
}

function programarSincronizacionEmpresas({ force = false, completo = false, usuarioPreferido = null } = {}) {
  if (sincronizacionEmpresasActiva) return sincronizacionEmpresasActiva;
  sincronizacionEmpresasActiva = (async () => {
    const control = await directorioVencido();
    if (!force && !control.vencido) return { omitida: true, motivo: 'directorio_fresco', estado: control.estado };
    const usuario = usuarioDirectorioEmpresas(usuarioPreferido);
    if (!usuario) throw new Error('No hay un usuario BIOFILE disponible para actualizar el directorio de empresas.');
    const usarCompleto = completo || !control.estado?.ultimoExitoIso;
    console.log('[CLIENTES] Iniciando sincronización ' + (usarCompleto ? 'completa' : 'incremental') + '.');
    const resultado = await sincronizarEmpresasDesdeBiofile({ usuario, store: directorioEmpresasStore, completo: usarCompleto });
    console.log('[CLIENTES] Sincronización terminada:', resultado.totalEmpresas, 'empresas; nuevas:', resultado.nuevas);
    return resultado;
  })().finally(() => { sincronizacionEmpresasActiva = null; });
  return sincronizacionEmpresasActiva;
}

async function estadoDirectorioEmpresas() {
  const estado = await directorioEmpresasStore.obtenerEstado();
  return {
    ...estado,
    sincronizando: Boolean(sincronizacionEmpresasActiva),
    intervaloMs: DIRECTORIO_SYNC_INTERVAL_MS,
    proximaRevisionIso: estado.ultimoExitoIso
      ? (() => {
          const porIntervalo = new Date((Date.parse(estado.ultimoExitoIso) || Date.now()) + DIRECTORIO_SYNC_INTERVAL_MS).getTime();
          const porDia = Date.parse(proximoDiaBogotaIso());
          return new Date(Math.min(porIntervalo, porDia)).toISOString();
        })()
      : ''
  };
}

const CAMPOS_EDITABLES = new Set([
  'Tipo doc', 'N° documento', 'Ciudad nacimiento', 'Fecha nacimiento',
  'Primer apellido', 'Segundo apellido', 'Primer nombre', 'Otros nombres',
  'Género', 'Estado civil', 'Nivel educativo', 'Correo', 'Zona', 'Dirección',
  'Barrio', 'Municipio', 'Estrato', 'Celular', 'Teléfono fijo',
  'Empresa en misión', 'Profesión o cargo', 'Funciones del cargo', 'EPS', 'AFP', 'ARL'
]);

function ahoraIso() {
  return new Date().toISOString();
}

function usuarioPublico(usuario) {
  return usuario ? {
    id: usuario.id,
    nombre: usuario.usuario,
    rol: usuario.rol,
    activo: usuario.activo !== false,
    fuente: usuario.fuente || 'panel'
  } : null;
}

function limpiarJobsAntiguos() {
  const limite = Date.now() - config.api.jobRetentionMs;
  for (const [id, job] of jobs) {
    const referencia = Date.parse(job.finalizadoEn || job.creadoEn || '') || Date.now();
    if (referencia < limite && !['en_cola', 'procesando'].includes(job.estado)) jobs.delete(id);
  }
}

function limpiarSesiones() {
  const ahora = Date.now();
  for (const [token, sesion] of sesiones) {
    if (!sesion || sesion.expiraEn <= ahora) sesiones.delete(token);
  }
}

function invalidarSesionesUsuario(usuarioId) {
  for (const [token, sesion] of sesiones) {
    if (sesion?.usuario?.id === usuarioId) sesiones.delete(token);
  }
}

function origenPermitido(origen) {
  if (!origen) return '';
  if (config.api.allowedOrigins.includes('*')) return '*';
  return config.api.allowedOrigins.includes(origen) ? origen : '';
}

function aplicarCors(req, res) {
  const permitido = origenPermitido(req.headers.origin);
  if (permitido) {
    res.setHeader('Access-Control-Allow-Origin', permitido);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

function responderJson(req, res, status, payload) {
  aplicarCors(req, res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function extraerApiKey(req) {
  return String(req.headers['x-api-key'] || '').trim();
}

function extraerBearer(req) {
  const auth = String(req.headers.authorization || '');
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function comparacionSegura(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function buscarUsuarioEntorno(nombre, contrasena) {
  const normalizado = normalizarUsuario(nombre);
  for (const usuario of config.usuariosEntorno) {
    if (normalizarUsuario(usuario.usuario) !== normalizado) continue;
    if (comparacionSegura(contrasena, usuario.contrasena)) return usuario;
  }
  return null;
}

function existeUsuarioEntorno(nombre) {
  const normalizado = normalizarUsuario(nombre);
  return config.usuariosEntorno.some((u) => normalizarUsuario(u.usuario) === normalizado);
}

async function buscarCredenciales(nombre, contrasena) {
  const entorno = buscarUsuarioEntorno(nombre, contrasena);
  if (entorno) return { estado: 'ok', usuario: entorno };

  if (!usuariosStore.disponible()) return { estado: 'no_encontrado', usuario: null };
  return usuariosStore.autenticar(nombre, contrasena);
}

function autenticar(req) {
  /* AUTH_BEARER_ONLY_V6 */
  limpiarSesiones();
  const token = extraerBearer(req);
  if (!token) return null;
  const sesion = sesiones.get(token);
  if (!sesion || sesion.expiraEn <= Date.now() || !sesion.usuario) return null;
  sesion.expiraEn = Date.now() + config.api.sessionTtlMs;
  return { usuario: sesion.usuario, token, legado: false };
}

function crearSesionPanel(usuario) {
  limpiarSesiones();
  const token = crypto.randomBytes(32).toString('base64url');
  sesiones.set(token, {
    usuario: { ...usuario },
    creadoEn: Date.now(),
    expiraEn: Date.now() + config.api.sessionTtlMs
  });
  return token;
}

async function leerJson(req) {
  let total = 0;
  const partes = [];
  for await (const parte of req) {
    total += parte.length;
    if (total > config.api.maxBodyBytes) {
      const error = new Error('El cuerpo de la petición es demasiado grande.');
      error.statusCode = 413;
      throw error;
    }
    partes.push(parte);
  }
  if (!partes.length) return {};
  try {
    return JSON.parse(Buffer.concat(partes).toString('utf8'));
  } catch {
    const error = new Error('El cuerpo debe ser un JSON válido.');
    error.statusCode = 400;
    throw error;
  }
}

function documentoValido(valor) {
  return /^[A-Za-z0-9.\-\s]{4,30}$/.test(String(valor || '').trim());
}

/* DOCUMENTO_CLAVE_V6 */
function documentoClave(valor) {
  return String(valor || '').trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function jobPublico(job) {
  if (!job) return null;
  return {
    id: job.id,
    estado: job.estado,
    documento: job.documento,
    fila: job.fila,
    subirImagenes: job.subirImagenes,
    empresaCatalogo: job.empresaCatalogo || '',
    tipoEvaluacion: job.tipoEvaluacion || TIPOS_EVALUACION_BIOFILE[0],
    paquete: job.paquete || 'NO APLICA',
    usuario: {
      id: job.usuarioId,
      nombre: job.usuarioNombre
    },
    creadoEn: job.creadoEn,
    iniciadoEn: job.iniciadoEn || null,
    finalizadoEn: job.finalizadoEn || null,
    ultimaActividad: job.ultimaActividad || null,
    duracion: job.duracion || (job.iniciadoEn ? Date.now() - Date.parse(job.iniciadoEn) : 0),
    reintentable: Boolean(job.reintentable),
    ultimoPasoEjecutado: job.ultimoPasoEjecutado || '',
    guardadoIntentado: Boolean(job.guardadoIntentado),
    metrics: job.metrics || {},
    resultado: job.resultado || null,
    error: job.error || null,
    /* JOB_PUBLIC_PROGRESS_V1 */
    progreso: Number(job.progreso || 0),
    etapa: job.etapa || '',
    detalle: job.detalle || '',
    numeroOrden: job.numeroOrden || job.resultado?.numeroOrden || job.error?.numeroOrden || ''
  };
}

async function encolar({ usuario, ...input }) {
  await requireJobs();
  return jobService.enqueue({ ...input, kind: 'legacy-job' }, usuario, ({ usuario, job, onProgress }) => procesarRegistroBiofile({ ...input, jobId: job.id, usuario, onProgress }));
}

function trabajosActivosPorUsuario() {
  const mapa = {};
  for (const job of jobs.values()) {
    if (!['en_cola', 'procesando'].includes(job.estado)) continue;
    const actual = mapa[job.usuarioId] || { usuario: job.usuarioNombre, enCola: 0, procesando: 0 };
    if (job.estado === 'en_cola') actual.enCola += 1;
    if (job.estado === 'procesando') actual.procesando += 1;
    mapa[job.usuarioId] = actual;
  }
  return mapa;
}

async function cargarBase() {
  return new BaseGoogleSheets({
    urlOId: config.google.urlOId,
    hoja: config.google.hoja,
    authMode: config.google.authMode,
    credentialsPath: config.google.credentialsPath,
    credentialsJson: config.google.credentialsJson
  }).cargar();
}

function fechaValida(valor) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(valor || ''));
}

function requiereRol(usuario, roles) {
  return roles.includes(usuario?.rol);
}

function usuarioRenderPublico(u) {
  return {
    id: u.id,
    usuario: u.usuario,
    rol: u.rol,
    activo: true,
    fuente: 'render',
    soloLectura: true
  };
}

/* OPERACION_API_V5 */
async function resolverUsuarioResponsable(actor, solicitado = '') {
  const nombre = String(solicitado || '').trim();
  if (!nombre) return actor.usuario;
  if (actor.rol !== 'superadmin') {
    if (normalizarUsuario(nombre) !== normalizarUsuario(actor.usuario)) {
      throw new Error('Solo un Super Admin puede atribuir un ingreso manual a otro usuario.');
    }
    return actor.usuario;
  }

  const administrados = usuariosStore.disponible() ? await usuariosStore.listar() : [];
  const candidatos = [
    ...config.usuariosEntorno.map((u) => ({ usuario: u.usuario, activo: u.activo !== false })),
    ...administrados
  ];
  const encontrado = candidatos.find((u) => normalizarUsuario(u.usuario) === normalizarUsuario(nombre));
  if (!encontrado) throw new Error('El usuario responsable indicado no existe.');
  if (encontrado.activo === false) throw new Error('El usuario responsable está inactivo.');
  return encontrado.usuario;
}

async function manejar(req, res) {
  if (req.method === 'OPTIONS') {
    aplicarCors(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  if (['GET', 'HEAD'].includes(req.method) && (url.pathname === '/' || url.pathname === '/api/health')) {
    responderJson(req, res, 200, {
      ok: true,
      servicio: 'BIOFILE Robot API multiusuario',
      estado: 'activo',
      usuariosRender: config.usuariosEntorno.length,
      superadminsRender: config.usuariosEntorno.filter((u) => u.rol === 'superadmin').length,
      gestionUsuariosDisponible: usuariosStore.disponible(),
      cola: [...jobs.values()].filter((j) => ['en_cola', 'procesando'].includes(j.estado)).length,
      colasPorUsuario: trabajosActivosPorUsuario(),
      hora: ahoraIso()
    });
    return;
  }


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

  if (req.method === 'GET' && url.pathname === '/api/directorio/empresas') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const q = String(url.searchParams.get('q') || '').trim();
    const limit = Math.max(1, Math.min(25, Number(url.searchParams.get('limit') || 10)));
    const control = await directorioVencido().catch(() => ({ estado: {}, vencido: false }));
    if (control.vencido) programarSincronizacionEmpresas({ force: false }).catch((error) => console.warn('[CLIENTES] Actualización automática:', error.message));
    const empresas = await directorioEmpresasStore.buscar(q, limit);
    responderJson(req, res, 200, {
      ok: true,
      empresas,
      totalEmpresas: Number(control.estado?.totalEmpresas || 0),
      ultimoExitoIso: control.estado?.ultimoExitoIso || '',
      sincronizando: Boolean(sincronizacionEmpresasActiva)
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await leerJson(req);
    const resultado = await buscarCredenciales(body.usuario, body.contrasena);
    if (resultado.estado === 'inactivo') {
      responderJson(req, res, 403, { ok: false, error: 'Su usuario se encuentra inactivo. Comuníquese con el superadministrador.' });
      return;
    }
    if (resultado.estado !== 'ok' || !resultado.usuario) {
      responderJson(req, res, 401, { ok: false, error: 'Usuario o contraseña incorrectos.' });
      return;
    }
    const token = crearSesionPanel(resultado.usuario);
    responderJson(req, res, 200, {
      ok: true,
      token,
      usuario: usuarioPublico(resultado.usuario),
      expiraEnMs: config.api.sessionTtlMs
    });
    return;
  }

  const autenticacion = autenticar(req);
  if (!autenticacion) {
    responderJson(req, res, 401, { ok: false, error: 'Sesión no válida. Inicia sesión nuevamente.' });
    return;
  }
  const usuario = autenticacion.usuario;
  if (url.pathname.startsWith('/api/nacionales/')) { await requireJobs(); if (await nationalApi(req,res,url,usuario)) return; }

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    responderJson(req, res, 200, { ok: true, usuario: usuarioPublico(usuario) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    if (autenticacion.token) sesiones.delete(autenticacion.token);
    responderJson(req, res, 200, { ok: true });
    return;
  }


  if (req.method === 'GET' && url.pathname === '/api/superadmin/directorio/estado') {
    if (!requiereRol(usuario, ['superadmin'])) {
      responderJson(req, res, 403, { ok: false, error: 'Solo un superadministrador puede consultar el directorio de empresas.' });
      return;
    }
    responderJson(req, res, 200, { ok: true, directorio: await estadoDirectorioEmpresas() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/superadmin/directorio/sincronizar') {
    if (!requiereRol(usuario, ['superadmin'])) {
      responderJson(req, res, 403, { ok: false, error: 'Solo un superadministrador puede actualizar el directorio de empresas.' });
      return;
    }
    const body = await leerJson(req);
    if (!sincronizacionEmpresasActiva) {
      programarSincronizacionEmpresas({
        force: true,
        completo: body.completo === true,
        usuarioPreferido: usuario
      }).catch((error) => console.error('[CLIENTES] Sincronización manual:', error.message));
    }
    responderJson(req, res, 202, {
      ok: true,
      sincronizando: true,
      mensaje: body.completo === true
        ? 'Sincronización completa iniciada.'
        : 'Actualización de empresas iniciada.'
    });
    return;
  }


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

  /* LISTADO_API_V61 */
  if (req.method === 'GET' && url.pathname === '/api/biofile/trabajos') {
    await requireJobs(); responderJson(req,res,200,{ok:true,jobs:[...jobs.values()].filter(j=>j.kind==='legacy-job' && j.usuarioId===usuario.id).map(jobPublico)}); return;
  }
  if (req.method === 'GET' && url.pathname === '/api/registros/listar') {
    const base = await cargarBase();
    const registros = base.listarRegistros({ busqueda: url.searchParams.get('busqueda') || '' });
    responderJson(req, res, 200, { ok: true, registros });
    return;
  }

  /* CONCILIACION_BIOFILE_V64 */
  if (req.method === 'POST' && url.pathname === '/api/registros/verificar-biofile') {
    const body = await leerJson(req);
    const documento = String(body.documento || '').trim();
    const fila = Number(body.fila || 0);
    const filaValida = Number.isInteger(fila) && fila >= 2;
    if (!filaValida && !documentoValido(documento)) {
      responderJson(req, res, 400, { ok: false, error: 'Documento o fila no válidos.' });
      return;
    }

    const clave = documentoClave(documento);
    const activo = [...jobs.values()].find((j) => documentoClave(j.documento) === clave && ['en_cola', 'procesando'].includes(j.estado));
    if (activo) {
      responderJson(req, res, 409, { ok: false, error: 'Este paciente está en cola o procesándose. Espere a que termine antes de verificarlo.' });
      return;
    }

    try {
      const base = await cargarBase();
      const registros = base.listarRegistros({ busqueda: '' });
      const registro = registros.find((r) => {
        const filaRegistro = Number(r?._FILA_SHEETS || 0);
        if (filaValida) return filaRegistro === fila;
        return documentoClave(r?.['N° documento']) === clave;
      });
      if (!registro) {
        responderJson(req, res, 404, { ok: false, error: 'No se encontró esa visita en Google Sheets.' });
        return;
      }

      const row = Number(registro._FILA_SHEETS);
      const docRegistro = String(registro['N° documento'] || documento).trim();
      const estado = String(registro.ESTADO_BIOFILE || '').trim().toUpperCase();
      const numeroOrden = String(registro.NUMERO_OS_BIOFILE || '').trim();
      const guardadoConfirmado = String(registro.GUARDADO_CONFIRMADO_BIOFILE || '').trim().toUpperCase();
      const modo = String(registro.MODO_INGRESO_BIOFILE || 'AUTOMATICO').trim().toUpperCase() || 'AUTOMATICO';
      const responsable = String(registro.USUARIO_BIOFILE || usuario.usuario).trim() || usuario.usuario;

      if (estado === 'COMPLETADO') {
        responderJson(req, res, 200, { ok: true, conciliado: true, yaCompletado: true, fila: row, documento: docRegistro, numeroOrden, modo, mensaje: 'Este paciente ya figura como completado.' });
        return;
      }

      const evidenciaOrden = Boolean(numeroOrden) || guardadoConfirmado === 'SI' || ['ORDEN_CREADA', 'PARCIAL'].includes(estado);
      if (evidenciaOrden) {
        await base.marcarCompletado(row, numeroOrden, responsable, modo);
        await usuariosStore.registrarAuditoria(
          usuario.usuario,
          'CONCILIACION_BIOFILE',
          docRegistro,
          'Fila ' + row + '; evidencia: ' + (numeroOrden ? 'O.S. ' + numeroOrden : guardadoConfirmado === 'SI' ? 'guardado confirmado' : estado)
        ).catch(() => {});
        responderJson(req, res, 200, {
          ok: true, conciliado: true, yaCompletado: false, fila: row, documento: docRegistro, numeroOrden, modo,
          mensaje: numeroOrden
            ? 'Se encontró la O.S. ' + numeroOrden + ' y el registro fue movido a Ingresados.'
            : 'Se encontró evidencia de un guardado confirmado y el registro fue movido a Ingresados.'
        });
        return;
      }

      responderJson(req, res, 200, {
        ok: true, conciliado: false, fila: row, documento: docRegistro, requiereConfirmacionManual: true,
        mensaje: 'No hay una O.S. ni un guardado confirmado que permitan conciliar automáticamente. Si ya fue ingresado manualmente en BIOFILE, confirma el ingreso manual y el responsable.'
      });
    } catch (error) {
      responderJson(req, res, Number(error.statusCode || 400), { ok: false, error: error.message });
    }
    return;
  }

  /* SUPERADMIN_LAB_CATALOGO_V71 */
  if (req.method === 'GET' && url.pathname === '/api/superadmin/catalogo/actual') {
    if (!requiereRol(usuario, ['superadmin'])) {
      responderJson(req, res, 403, { ok: false, error: 'Solo un Super Admin puede usar el laboratorio BIOFILE.' });
      return;
    }

    const empresa = String(url.searchParams.get('empresa') || '').trim();
    if (empresa.length < 3) {
      responderJson(req, res, 400, { ok: false, error: 'Indica una empresa válida.' });
      return;
    }

    const catalogo = await catalogoStore.obtener(empresa);
    responderJson(req, res, 200, { ok: true, empresa, catalogo, encontrado: Boolean(catalogo) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/superadmin/catalogo/probar') {
    if (!requiereRol(usuario, ['superadmin'])) {
      responderJson(req, res, 403, { ok: false, error: 'Solo un Super Admin puede usar el laboratorio BIOFILE.' });
      return;
    }

    const body = await leerJson(req);
    const empresa = String(body.empresa || '').trim();
    const guardar = body.guardar === true;
    if (empresa.length < 3 || empresa.length > 180) {
      responderJson(req, res, 400, { ok: false, error: 'Indica una empresa válida.' });
      return;
    }

    const inicio = Date.now();
    const previo = await catalogoStore.obtener(empresa).catch(() => null);
    try {
      const investigacion = await investigarPaquetesEmpresaBiofile({ empresa: previo?.acuerdoExacto || empresa, usuario });
      let catalogoGuardado = previo;
      if (guardar) {
        catalogoGuardado = await catalogoStore.guardarInvestigacion({
          empresaBuscada: empresa,
          acuerdoExacto: investigacion.acuerdoExacto || empresa,
          paquetes: investigacion.paquetes,
          estado: 'OK',
          error: ''
        });
      }
      responderJson(req, res, 200, {
        ok: true, empresa, guardar, duracionMs: Date.now() - inicio, previo, investigacion, catalogoGuardado
      });
    } catch (error) {
      responderJson(req, res, 422, {
        ok: false, empresa, guardar, duracionMs: Date.now() - inicio, error: error.message, previo,
        detalleCatalogo: error.detalleCatalogo || null, detalleProductoServicio: error.detalleProductoServicio || null
      });
    }
    return;
  }
  if (url.pathname === '/api/superadmin/usuarios' && req.method === 'GET') {
    if (!requiereRol(usuario, ['superadmin'])) {
      responderJson(req, res, 403, { ok: false, error: 'Solo un superadministrador puede gestionar usuarios.' });
      return;
    }
    if (!usuariosStore.disponible()) {
      responderJson(req, res, 503, { ok: false, error: 'Configura BIOFILE_ENCRYPTION_KEY en Render para habilitar la gestión de usuarios.' });
      return;
    }
    const usuarios = await usuariosStore.listar();
    responderJson(req, res, 200, {
      ok: true,
      usuarios,
      usuariosRender: config.usuariosEntorno.map(usuarioRenderPublico),
      hojas: {
        usuarios: config.usuariosStore.hojaUsuarios,
        auditoria: config.usuariosStore.hojaAuditoria
      }
    });
    return;
  }

  if (url.pathname === '/api/superadmin/usuarios' && req.method === 'POST') {
    if (!requiereRol(usuario, ['superadmin'])) {
      responderJson(req, res, 403, { ok: false, error: 'Solo un superadministrador puede crear usuarios.' });
      return;
    }
    if (!usuariosStore.disponible()) {
      responderJson(req, res, 503, { ok: false, error: 'Configura BIOFILE_ENCRYPTION_KEY en Render.' });
      return;
    }
    const body = await leerJson(req);
    if (existeUsuarioEntorno(body.usuario)) {
      responderJson(req, res, 409, { ok: false, error: 'Ese usuario todavía está configurado directamente en Render. Elimínalo de Render o usa otro nombre.' });
      return;
    }
    const creado = await usuariosStore.crear({
      usuario: body.usuario,
      contrasena: body.contrasena,
      rol: body.rol,
      actor: usuario.usuario
    });
    responderJson(req, res, 201, { ok: true, usuario: creado });
    return;
  }

  const matchUsuarioAdmin = url.pathname.match(/^\/api\/superadmin\/usuarios\/([0-9a-f-]+)$/i);
  if (matchUsuarioAdmin && req.method === 'PATCH') {
    if (!requiereRol(usuario, ['superadmin'])) {
      responderJson(req, res, 403, { ok: false, error: 'Solo un superadministrador puede modificar usuarios.' });
      return;
    }
    if (!usuariosStore.disponible()) {
      responderJson(req, res, 503, { ok: false, error: 'Configura BIOFILE_ENCRYPTION_KEY en Render.' });
      return;
    }
    const body = await leerJson(req);
    if (body.rol === 'superadmin') {
      responderJson(req, res, 400, { ok: false, error: 'Los superadministradores solo se crean desde las variables de Render.' });
      return;
    }
    if (body.usuario && existeUsuarioEntorno(body.usuario)) {
      responderJson(req, res, 409, { ok: false, error: 'Ese nombre corresponde a un usuario configurado directamente en Render.' });
      return;
    }
    const actualizado = await usuariosStore.actualizar(matchUsuarioAdmin[1], body, usuario.usuario);
    invalidarSesionesUsuario(actualizado.id);
    responderJson(req, res, 200, { ok: true, usuario: actualizado });
    return;
  }

  if (url.pathname === '/api/superadmin/auditoria' && req.method === 'GET') {
    if (!requiereRol(usuario, ['superadmin'])) {
      responderJson(req, res, 403, { ok: false, error: 'Solo un superadministrador puede ver la auditoría.' });
      return;
    }
    if (!usuariosStore.disponible()) {
      responderJson(req, res, 503, { ok: false, error: 'Configura BIOFILE_ENCRYPTION_KEY en Render.' });
      return;
    }
    const auditoria = await usuariosStore.listarAuditoria(url.searchParams.get('limit') || 100);
    responderJson(req, res, 200, { ok: true, auditoria });
    return;
  }

  if (req.method === 'PATCH' && url.pathname === '/api/registros/actualizar') {
    const body = await leerJson(req);
    const documento = String(body.documento || '').trim();
    const fila = Number(body.fila || 0);
    const filaValida = Number.isInteger(fila) && fila >= 2;
    const campo = String(body.campo || '').trim();
    let valor = body.valor === null || body.valor === undefined ? '' : String(body.valor).trim();

    if (!documentoValido(documento)) {
      responderJson(req, res, 400, { ok: false, error: 'Documento no válido.' });
      return;
    }
    if (!CAMPOS_EDITABLES.has(campo)) {
      responderJson(req, res, 400, { ok: false, error: 'Ese campo no está habilitado para edición.' });
      return;
    }
    if (campo === 'Estrato' && !valor) valor = '1';

    const base = await cargarBase();
    let resultado;
    if (filaValida) {
      await base.actualizarCampos(fila, { [campo]: valor });
      resultado = { row: fila, campo, valor };
    } else {
      resultado = await base.actualizarCampoPorDocumento(documento, campo, valor);
    }
    responderJson(req, res, 200, { ok: true, ...resultado, actualizadoPor: usuarioPublico(usuario) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/registros/marcar-manual') {
    const body = await leerJson(req);
    const documento = String(body.documento || '').trim();
    const fila = Number(body.fila || 0);
    const filaValida = Number.isInteger(fila) && fila >= 2;
    if (!documentoValido(documento)) {
      responderJson(req, res, 400, { ok: false, error: 'Documento no válido.' });
      return;
    }
    try {
      const responsable = await resolverUsuarioResponsable(usuario, body.usuarioResponsable);
      const base = await cargarBase();
      const [registroExperiencia] = base.obtenerPendientes({ max: 1, documento, fila: filaValida ? fila : 0 });
      const fechaExperienciaIso = new Date().toISOString();
      const resultado = filaValida
        ? await base.marcarCompletadoManualFila(fila, responsable, usuario.usuario)
        : await base.marcarCompletadoManual(documento, responsable, usuario.usuario);
      /* AUDITORIA_OPERATIVA_V5 */
      await usuariosStore.registrarAuditoria(usuario.usuario, 'INGRESO_MANUAL', documento, 'Atribuido a: ' + responsable).catch(() => {});
      /* EXPERIENCIA_MANUAL_V1 */
      const experiencia = registroExperiencia
        ? await notificarExperiencia({
            registro: registroExperiencia,
            numeroOrden: '',
            usuario: responsable,
            modoIngreso: 'MANUAL',
            fechaIngresoBiofileIso: fechaExperienciaIso
          })
        : { ok: false, omitido: true, motivo: 'No se encontró registro pendiente para programar la encuesta.' };
      responderJson(req, res, 200, {
        ok: true,
        documento,
        fila: resultado.row,
        usuario: usuarioPublico(usuario),
        atribuidoA: responsable,
        registradoPor: usuario.usuario,
        modo: 'MANUAL',
        experiencia
      });
    } catch (error) {
      responderJson(req, res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/registros/eliminar') {
    const body = await leerJson(req);
    const documento = String(body.documento || '').trim();
    const fila = Number(body.fila || 0);
    const filaValida = Number.isInteger(fila) && fila >= 2;
    const motivo = String(body.motivo || '').trim();
    if (!documentoValido(documento)) {
      responderJson(req, res, 400, { ok: false, error: 'Documento no válido.' });
      return;
    }
    const activo = [...jobs.values()].find((j) =>
      j.documento === documento && ['en_cola', 'procesando'].includes(j.estado)
    );
    if (activo) {
      responderJson(req, res, 409, {
        ok: false,
        error: 'Este paciente está en cola o procesándose. Espere a que termine antes de enviarlo a Eliminados.'
      });
      return;
    }
    try {
      const base = await cargarBase();
      const resultado = filaValida
        ? await base.marcarEliminadoFila(fila, usuario.usuario, motivo)
        : await base.marcarEliminado(documento, usuario.usuario, motivo);
      await usuariosStore.registrarAuditoria(usuario.usuario, 'ENVIAR_A_ELIMINADOS', documento, motivo || 'Sin motivo especificado').catch(() => {});
      responderJson(req, res, 200, { ok: true, ...resultado });
    } catch (error) {
      responderJson(req, res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/estadisticas') {
    if (!requiereRol(usuario, ['admin', 'superadmin'])) {
      responderJson(req, res, 403, { ok: false, error: 'Solo administradores pueden ver este dashboard.' });
      return;
    }
    const desde = String(url.searchParams.get('desde') || '');
    const hasta = String(url.searchParams.get('hasta') || '');
    if ((desde && !fechaValida(desde)) || (hasta && !fechaValida(hasta))) {
      responderJson(req, res, 400, { ok: false, error: 'Las fechas deben usar el formato AAAA-MM-DD.' });
      return;
    }
    if (desde && hasta && desde > hasta) {
      responderJson(req, res, 400, { ok: false, error: 'La fecha inicial no puede ser posterior a la final.' });
      return;
    }
    const base = await cargarBase();
    const estadisticas = base.obtenerEstadisticasUsuarios({ desde, hasta });
    responderJson(req, res, 200, { ok: true, estadisticas, colasActuales: trabajosActivosPorUsuario() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/biofile/enviar') {
    const body = await leerJson(req);
    const documento = documentoClave(body.documento);
    const fila = Number(body.fila || 0);
    const filaValida = Number.isInteger(fila) && fila >= 2;

    if (!documentoValido(documento) && !filaValida) {
      responderJson(req, res, 400, { ok: false, error: 'Indica un documento válido o una fila numérica de Google Sheets.' });
      return;
    }

    const subirImagenes = body.subirImagenes !== false;
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

    const { job, duplicado } = await encolar({
      documento,
      fila,
      subirImagenes,
      empresaCatalogo,
      tipoEvaluacion,
      paquete,
      usuario
    });

    await usuariosStore.registrarAuditoria(
      usuario.usuario,
      duplicado ? 'ENVIO_DUPLICADO_BLOQUEADO' : 'SOLICITAR_INGRESO_AUTOMATICO',
      documento,
      'Job: ' + job.id + (duplicado ? ' | Ya estaba activo con: ' + job.usuarioNombre : '')
    ).catch(() => {});

    responderJson(req, res, duplicado ? 409 : 202, {
      ok: !duplicado,
      duplicado,
      mensaje: duplicado
        ? `Ese documento ya está en cola o procesándose con ${job.usuarioNombre}.`
        : `Solicitud recibida en la cola de ${usuario.usuario}.`,
      job: job.usuarioId === usuario.id || usuario.rol === 'superadmin' ? jobPublico(job) : null,
      statusPath: `/api/biofile/trabajos/${job.id}`
    });
    return;
  }

  if (url.pathname.startsWith('/api/biofile/trabajos/')) await requireJobs();
  const matchJob = url.pathname.match(/^\/api\/biofile\/trabajos\/([0-9a-f-]+)$/i);
  if (req.method === 'GET' && matchJob) {
    const job = jobs.get(matchJob[1]);
    if (!job) {
      responderJson(req, res, 404, { ok: false, error: 'Trabajo no encontrado o expirado.' });
      return;
    }
    if (!requiereRol(usuario, ['admin', 'superadmin']) && job.usuarioId !== usuario.id) {
      responderJson(req, res, 403, { ok: false, error: 'Este trabajo pertenece a otro usuario.' });
      return;
    }
    responderJson(req, res, 200, { ok: true, job: jobPublico(job) });
    return;
  }

  responderJson(req, res, 404, { ok: false, error: 'Endpoint no encontrado.' });
}

validarConfiguracion({
  requiereApi: true,
  requiereBiofile: false,
  requiereDefaults: true,
  requiereGoogle: true,
  requiereEscrituraGoogle: true
});

catalogoStore.inicializar().catch((error) => {
  console.error('[CATALOGO] No fue posible preparar las hojas del catálogo:', error.message);
});

directorioEmpresasStore.inicializar().then(() => {
  setTimeout(() => {
    programarSincronizacionEmpresas({ force: false }).catch((error) => console.error('[CLIENTES] Sincronización automática:', error.message));
  }, 15_000).unref?.();
}).catch((error) => {
  console.error('[CLIENTES] No fue posible preparar el directorio interno:', error.message);
});

const timerDirectorioEmpresas = setInterval(() => {
  programarSincronizacionEmpresas({ force: false }).catch((error) => console.error('[CLIENTES] Revisión periódica:', error.message));
}, 60 * 60 * 1000);
timerDirectorioEmpresas.unref?.();

if (usuariosStore.disponible()) {
  usuariosStore.inicializar().catch((error) => {
    console.error('[USUARIOS] No fue posible preparar las hojas de usuarios/auditoría:', error.message);
  });
} else {
  console.warn('[USUARIOS] Gestión dinámica deshabilitada hasta configurar BIOFILE_ENCRYPTION_KEY (mínimo 32 caracteres).');
}

servidor = http.createServer((req, res) => {
  manejar(req, res).catch((error) => {
    console.error('[API] Error no controlado:', error);
    const status = error.statusCode || (/ya existe/i.test(error.message) ? 409 : 500);
    responderJson(req, res, status, {
      ok: false,
      error: error.statusCode ? error.message : (error.message || 'Error interno del servidor.')
    });
  });
});

void purgeDiagnostics(config.paths.screenshots);
setInterval(() => { void purgeDiagnostics(config.paths.screenshots); }, 3600000).unref();

servidor.listen(config.api.port, '0.0.0.0', () => {
  console.log(`[API] BIOFILE Robot API multiusuario escuchando en 0.0.0.0:${config.api.port}`);
  console.log(`[API] Usuarios configurados en Render: ${config.usuariosEntorno.length}`);
  console.log(`[API] Gestión dinámica: ${usuariosStore.disponible() ? 'habilitada' : 'pendiente de BIOFILE_ENCRYPTION_KEY'}`);
  console.log('[API] Login: POST /api/auth/login');
  console.log('[API] Envío: POST /api/biofile/enviar');
  console.log('[API] Salud: GET /api/health');
});

function apagar(senal) {
  console.log(`[API] ${senal} recibido. Cerrando servidor...`);
  jobService.accepting = false;
  servidor.close();
  jobService.shutdown().then(() => cerrarNavegador()).finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 290_000).unref();
}

process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
