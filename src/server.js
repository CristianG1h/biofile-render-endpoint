import crypto from 'node:crypto';
import http from 'node:http';
import { config, validarConfiguracion } from './config.js';
import { BaseGoogleSheets } from './google-sheets.js';
import { procesarRegistroBiofile } from './procesar-registro.js';

const jobs = new Map();
const colasUsuarios = new Map();
const sesiones = new Map();
let servidor;

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

function normalizarUsuario(valor) {
  return String(valor || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function usuarioPublico(usuario) {
  return usuario ? {
    id: usuario.id,
    nombre: usuario.usuario,
    rol: usuario.rol
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
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

function buscarUsuarioPorId(id) {
  return config.usuariosBiofile.find((u) => u.id === id) || null;
}

function buscarUsuarioCredenciales(nombre, contrasena) {
  const normalizado = normalizarUsuario(nombre);
  for (const usuario of config.usuariosBiofile) {
    if (normalizarUsuario(usuario.usuario) !== normalizado) continue;
    if (comparacionSegura(contrasena, usuario.contrasena)) return usuario;
  }
  return null;
}

function autenticar(req) {
  limpiarSesiones();
  const token = extraerBearer(req);
  if (token) {
    const sesion = sesiones.get(token);
    if (sesion && sesion.expiraEn > Date.now()) {
      const usuario = buscarUsuarioPorId(sesion.usuarioId);
      if (usuario) {
        sesion.expiraEn = Date.now() + config.api.sessionTtlMs;
        return { usuario, token, legado: false };
      }
    }
  }

  // Compatibilidad temporal con el panel anterior que usaba X-API-Key.
  const apiKey = extraerApiKey(req);
  if (config.api.key && apiKey && comparacionSegura(apiKey, config.api.key)) {
    const usuario = config.usuariosBiofile[0] || null;
    if (usuario) return { usuario, token: '', legado: true };
  }

  return null;
}

function crearSesionPanel(usuario) {
  limpiarSesiones();
  const token = crypto.randomBytes(32).toString('base64url');
  sesiones.set(token, {
    usuarioId: usuario.id,
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

function jobPublico(job) {
  if (!job) return null;
  return {
    id: job.id,
    estado: job.estado,
    documento: job.documento,
    fila: job.fila,
    subirImagenes: job.subirImagenes,
    usuario: {
      id: job.usuarioId,
      nombre: job.usuarioNombre
    },
    creadoEn: job.creadoEn,
    iniciadoEn: job.iniciadoEn || null,
    finalizadoEn: job.finalizadoEn || null,
    resultado: job.resultado || null,
    error: job.error || null
  };
}

function encolar({ documento, fila, subirImagenes, usuario }) {
  limpiarJobsAntiguos();

  // Evita crear dos órdenes para la misma persona aunque sean usuarios distintos.
  const duplicado = [...jobs.values()].find((job) =>
    job.documento === documento && ['en_cola', 'procesando'].includes(job.estado)
  );
  if (duplicado) return { job: duplicado, duplicado: true };

  const id = crypto.randomUUID();
  const job = {
    id,
    estado: 'en_cola',
    documento,
    fila,
    subirImagenes,
    usuarioId: usuario.id,
    usuarioNombre: usuario.usuario,
    creadoEn: ahoraIso(),
    iniciadoEn: null,
    finalizadoEn: null,
    resultado: null,
    error: null
  };
  jobs.set(id, job);

  const colaAnterior = colasUsuarios.get(usuario.id) || Promise.resolve();
  const nuevaCola = colaAnterior
    .catch(() => {})
    .then(async () => {
      job.estado = 'procesando';
      job.iniciadoEn = ahoraIso();
      try {
        job.resultado = await procesarRegistroBiofile({
          documento: job.documento,
          fila: job.fila,
          subirImagenes: job.subirImagenes,
          jobId: job.id,
          usuario
        });
        job.estado = 'completado';
      } catch (error) {
        job.estado = 'error';
        job.error = {
          mensaje: error.message,
          ...(error.detalle || {})
        };
      } finally {
        job.finalizadoEn = ahoraIso();
      }
    });

  colasUsuarios.set(usuario.id, nuevaCola);
  nuevaCola.finally(() => {
    if (colasUsuarios.get(usuario.id) === nuevaCola) colasUsuarios.delete(usuario.id);
  }).catch(() => {});

  return { job, duplicado: false };
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
      usuariosConfigurados: config.usuariosBiofile.length,
      cola: [...jobs.values()].filter((j) => ['en_cola', 'procesando'].includes(j.estado)).length,
      colasPorUsuario: trabajosActivosPorUsuario(),
      hora: ahoraIso()
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await leerJson(req);
    const usuario = buscarUsuarioCredenciales(body.usuario, body.contrasena);
    if (!usuario) {
      responderJson(req, res, 401, { ok: false, error: 'Usuario o contraseña incorrectos.' });
      return;
    }
    const token = crearSesionPanel(usuario);
    responderJson(req, res, 200, {
      ok: true,
      token,
      usuario: usuarioPublico(usuario),
      expiraEnMs: config.api.sessionTtlMs
    });
    return;
  }

  const autenticacion = autenticar(req);
  if (!autenticacion) {
    responderJson(req, res, 401, {
      ok: false,
      error: 'Sesión no válida. Inicia sesión nuevamente.'
    });
    return;
  }
  const usuario = autenticacion.usuario;

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    responderJson(req, res, 200, { ok: true, usuario: usuarioPublico(usuario) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    if (autenticacion.token) sesiones.delete(autenticacion.token);
    responderJson(req, res, 200, { ok: true });
    return;
  }

  if (req.method === 'PATCH' && url.pathname === '/api/registros/actualizar') {
    const body = await leerJson(req);
    const documento = String(body.documento || '').trim();
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
    const resultado = await base.actualizarCampoPorDocumento(documento, campo, valor);
    responderJson(req, res, 200, {
      ok: true,
      ...resultado,
      actualizadoPor: usuarioPublico(usuario)
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/registros/marcar-manual') {
    const body = await leerJson(req);
    const documento = String(body.documento || '').trim();
    if (!documentoValido(documento)) {
      responderJson(req, res, 400, { ok: false, error: 'Documento no válido.' });
      return;
    }
    const base = await cargarBase();
    const resultado = await base.marcarCompletadoManual(documento, usuario.usuario);
    responderJson(req, res, 200, {
      ok: true,
      documento,
      fila: resultado.row,
      usuario: usuarioPublico(usuario),
      modo: 'MANUAL'
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/estadisticas') {
    if (usuario.rol !== 'admin') {
      responderJson(req, res, 403, { ok: false, error: 'Solo el administrador puede ver este dashboard.' });
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
    responderJson(req, res, 200, {
      ok: true,
      estadisticas,
      colasActuales: trabajosActivosPorUsuario()
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/biofile/enviar') {
    const body = await leerJson(req);
    const documento = String(body.documento || '').trim().replace(/\s+/g, '');
    const fila = Number(body.fila || 0);
    const filaValida = Number.isInteger(fila) && fila >= 2;

    if (!documentoValido(documento) && !filaValida) {
      responderJson(req, res, 400, {
        ok: false,
        error: 'Indica un documento válido o una fila numérica de Google Sheets.'
      });
      return;
    }

    const subirImagenes = body.subirImagenes !== false;
    const { job, duplicado } = encolar({ documento, fila, subirImagenes, usuario });

    responderJson(req, res, duplicado ? 409 : 202, {
      ok: !duplicado,
      duplicado,
      mensaje: duplicado
        ? `Ese documento ya está en cola o procesándose con ${job.usuarioNombre}.`
        : `Solicitud recibida en la cola de ${usuario.usuario}.`,
      job: jobPublico(job),
      statusPath: `/api/biofile/trabajos/${job.id}`
    });
    return;
  }

  const matchJob = url.pathname.match(/^\/api\/biofile\/trabajos\/([0-9a-f-]+)$/i);
  if (req.method === 'GET' && matchJob) {
    const job = jobs.get(matchJob[1]);
    if (!job) {
      responderJson(req, res, 404, { ok: false, error: 'Trabajo no encontrado o expirado.' });
      return;
    }
    if (usuario.rol !== 'admin' && job.usuarioId !== usuario.id) {
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

servidor = http.createServer((req, res) => {
  manejar(req, res).catch((error) => {
    console.error('[API] Error no controlado:', error);
    responderJson(req, res, error.statusCode || 500, {
      ok: false,
      error: error.statusCode ? error.message : (error.message || 'Error interno del servidor.')
    });
  });
});

servidor.listen(config.api.port, '0.0.0.0', () => {
  console.log(`[API] BIOFILE Robot API multiusuario escuchando en 0.0.0.0:${config.api.port}`);
  console.log(`[API] Usuarios configurados: ${config.usuariosBiofile.length}`);
  console.log('[API] Login: POST /api/auth/login');
  console.log('[API] Envío: POST /api/biofile/enviar');
  console.log('[API] Salud: GET /api/health');
});

function apagar(senal) {
  console.log(`[API] ${senal} recibido. Cerrando servidor...`);
  servidor.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 290_000).unref();
}

process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
