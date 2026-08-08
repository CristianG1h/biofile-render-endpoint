import crypto from 'node:crypto';
import http from 'node:http';
import { crearGestorAuth, compararSeguro, usuarioPublico } from './auth.js';
import { config, validarConfiguracion } from './config.js';

const jobs = new Map();
const intentosLogin = new Map();
const auth = crearGestorAuth({
  usuarios: config.auth.users,
  secreto: config.auth.sessionSecret,
  ttlMs: config.auth.sessionTtlMs
});

let cola = Promise.resolve();
let servidor;
let moduloProcesador;

async function obtenerProcesador() {
  moduloProcesador ||= import('./procesar-registro.js');
  return moduloProcesador;
}

function ahoraIso() {
  return new Date().toISOString();
}

function limpiarJobsAntiguos() {
  const limite = Date.now() - config.api.jobRetentionMs;
  for (const [id, job] of jobs) {
    const referencia = Date.parse(job.finalizadoEn || job.creadoEn || '') || Date.now();
    if (referencia < limite && !['en_cola', 'procesando'].includes(job.estado)) {
      jobs.delete(id);
    }
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

function responderJson(req, res, status, payload, headers = {}) {
  aplicarCors(req, res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...headers
  });
  res.end(req.method === 'HEAD' ? '' : JSON.stringify(payload));
}

function extraerBearer(req) {
  const valor = String(req.headers.authorization || '');
  const match = valor.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function cuentaLegacy() {
  if (!config.biofile.usuario || !config.biofile.contrasena) return null;
  return {
    id: 'legacy',
    nombre: config.biofile.usuario,
    usuario: config.biofile.usuario,
    contrasena: config.biofile.contrasena
  };
}

function resolverIdentidad(req) {
  const bearer = extraerBearer(req);
  const usuarioSesion = auth.validarToken(bearer);
  if (usuarioSesion) {
    return { tipo: 'sesion', cuenta: usuarioSesion };
  }

  const claveDirecta = String(req.headers['x-api-key'] || '').trim();
  const clave = claveDirecta || bearer;
  const legacy = cuentaLegacy();
  if (legacy && config.api.key && compararSeguro(clave, config.api.key)) {
    return { tipo: 'api_key', cuenta: legacy };
  }

  return null;
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

function clienteLogin(req) {
  const reenviado = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return reenviado || req.socket.remoteAddress || 'desconocido';
}

function bloqueoLogin(req) {
  const clave = clienteLogin(req);
  const registro = intentosLogin.get(clave);
  if (!registro) return { bloqueado: false, clave };

  const transcurrido = Date.now() - registro.inicio;
  if (transcurrido >= config.auth.loginWindowMs) {
    intentosLogin.delete(clave);
    return { bloqueado: false, clave };
  }

  if (registro.intentos < config.auth.loginMaxAttempts) {
    return { bloqueado: false, clave };
  }

  return {
    bloqueado: true,
    clave,
    reintentarEn: Math.max(1, Math.ceil((config.auth.loginWindowMs - transcurrido) / 1000))
  };
}

function registrarFalloLogin(clave) {
  const actual = intentosLogin.get(clave);
  if (!actual || Date.now() - actual.inicio >= config.auth.loginWindowMs) {
    intentosLogin.set(clave, { inicio: Date.now(), intentos: 1 });
    return;
  }
  actual.intentos += 1;
}

function documentoValido(valor) {
  return /^[A-Za-z0-9.-]{4,30}$/.test(String(valor || '').trim());
}

function jobPublico(job) {
  if (!job) return null;
  return {
    id: job.id,
    estado: job.estado,
    documento: job.documento,
    fila: job.fila,
    subirImagenes: job.subirImagenes,
    usuario: job.usuario,
    creadoEn: job.creadoEn,
    iniciadoEn: job.iniciadoEn || null,
    finalizadoEn: job.finalizadoEn || null,
    resultado: job.resultado || null,
    error: job.error || null
  };
}

function puedeConsultar(job, identidad) {
  return identidad.tipo === 'api_key' || job.usuario.id === identidad.cuenta.id;
}

function encolar({ documento, fila, subirImagenes, identidad }) {
  limpiarJobsAntiguos();

  const duplicado = [...jobs.values()].find((job) => {
    const mismaSeleccion = documento
      ? job.documento === documento
      : Boolean(fila) && job.fila === fila;
    return mismaSeleccion && ['en_cola', 'procesando'].includes(job.estado);
  });
  if (duplicado) return { job: duplicado, duplicado: true };

  const id = crypto.randomUUID();
  const job = {
    id,
    estado: 'en_cola',
    documento,
    fila,
    subirImagenes,
    usuario: usuarioPublico(identidad.cuenta),
    cuenta: identidad.cuenta,
    tipoIdentidad: identidad.tipo,
    creadoEn: ahoraIso(),
    iniciadoEn: null,
    finalizadoEn: null,
    resultado: null,
    error: null
  };
  jobs.set(id, job);

  cola = cola
    .catch(() => {})
    .then(async () => {
      job.estado = 'procesando';
      job.iniciadoEn = ahoraIso();
      try {
        const { procesarRegistroBiofile } = await obtenerProcesador();
        job.resultado = await procesarRegistroBiofile({
          documento: job.documento,
          fila: job.fila,
          subirImagenes: job.subirImagenes,
          jobId: job.id,
          credencialesBiofile: job.cuenta,
          sesionBiofileId: job.tipoIdentidad === 'sesion' ? job.cuenta.id : ''
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
        job.cuenta = null;
      }
    });

  return { job, duplicado: false };
}

async function manejarLogin(req, res) {
  if (!auth.activo) {
    responderJson(req, res, 503, {
      ok: false,
      error: 'El acceso multiusuario todavía no está configurado en el servidor.'
    });
    return;
  }

  const bloqueo = bloqueoLogin(req);
  if (bloqueo.bloqueado) {
    responderJson(req, res, 429, {
      ok: false,
      error: 'Demasiados intentos. Espera unos minutos antes de volver a intentar.'
    }, { 'Retry-After': String(bloqueo.reintentarEn) });
    return;
  }

  const body = await leerJson(req);
  const login = String(body.usuario || '').trim();
  const contrasena = String(body.contrasena ?? '');
  const usuario = login.length <= 150 && contrasena.length <= 500
    ? auth.validarCredenciales(login, contrasena)
    : null;

  if (!usuario) {
    registrarFalloLogin(bloqueo.clave);
    responderJson(req, res, 401, {
      ok: false,
      error: 'Usuario o contraseña incorrectos.'
    });
    return;
  }

  intentosLogin.delete(bloqueo.clave);
  const publico = auth.usuarioPublico(usuario);
  responderJson(req, res, 200, {
    ok: true,
    token: auth.crearToken(usuario),
    expiraEnSegundos: Math.floor(auth.ttlMs / 1000),
    usuario: publico,
    mensaje: `Hola ${publico.nombre}, estás conectado con BIOFILE.`
  });
}

async function manejar(req, res) {
  if (req.method === 'OPTIONS') {
    aplicarCors(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  if (
    ['GET', 'HEAD'].includes(req.method) &&
    (url.pathname === '/' || url.pathname === '/api/health')
  ) {
    responderJson(req, res, 200, {
      ok: true,
      servicio: 'BIOFILE Robot API',
      estado: 'activo',
      autenticacion: auth.activo ? 'multiusuario' : 'api_key',
      cola: [...jobs.values()].filter((job) => ['en_cola', 'procesando'].includes(job.estado)).length,
      hora: ahoraIso()
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    await manejarLogin(req, res);
    return;
  }

  const identidad = resolverIdentidad(req);
  if (!identidad) {
    responderJson(req, res, 401, {
      ok: false,
      error: 'No autorizado. Inicia sesión o envía una clave API válida.'
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const publico = usuarioPublico(identidad.cuenta);
    responderJson(req, res, 200, {
      ok: true,
      usuario: publico,
      mensaje: `Hola ${publico.nombre}, estás conectado con BIOFILE.`
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
    const { job, duplicado } = encolar({ documento, fila, subirImagenes, identidad });
    const visible = puedeConsultar(job, identidad);

    responderJson(req, res, duplicado ? 409 : 202, {
      ok: !duplicado,
      duplicado,
      mensaje: duplicado
        ? 'Ese documento o fila ya está en cola o procesándose.'
        : 'Solicitud recibida. Consulta el estado con el jobId.',
      job: visible ? jobPublico(job) : null,
      statusPath: visible ? `/api/biofile/trabajos/${job.id}` : null
    });
    return;
  }

  const matchJob = url.pathname.match(/^\/api\/biofile\/trabajos\/([0-9a-f-]+)$/i);
  if (req.method === 'GET' && matchJob) {
    const job = jobs.get(matchJob[1]);
    if (!job || !puedeConsultar(job, identidad)) {
      responderJson(req, res, 404, { ok: false, error: 'Trabajo no encontrado o expirado.' });
      return;
    }
    responderJson(req, res, 200, { ok: true, job: jobPublico(job) });
    return;
  }

  responderJson(req, res, 404, { ok: false, error: 'Endpoint no encontrado.' });
}

validarConfiguracion({
  requiereApi: true,
  requiereBiofile: !config.auth.users.length,
  requiereDefaults: true,
  requiereGoogle: true,
  requiereEscrituraGoogle: true
});

servidor = http.createServer((req, res) => {
  manejar(req, res).catch((error) => {
    console.error('[API] Error no controlado:', error);
    responderJson(req, res, error.statusCode || 500, {
      ok: false,
      error: error.statusCode ? error.message : 'Error interno del servidor.'
    });
  });
});

servidor.listen(config.api.port, '0.0.0.0', () => {
  console.log(`[API] BIOFILE Robot API escuchando en 0.0.0.0:${config.api.port}`);
  console.log(`[API] Autenticación: ${auth.activo ? `${auth.cantidadUsuarios} usuarios` : 'clave API heredada'}`);
  console.log('[API] Endpoint: POST /api/biofile/enviar');
  console.log('[API] Salud: GET /api/health');
});

function apagar(senal) {
  console.log(`[API] ${senal} recibido. Cerrando servidor...`);
  servidor.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 290_000).unref();
}

process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
