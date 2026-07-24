import crypto from 'node:crypto';
import http from 'node:http';
import { config, validarConfiguracion } from './config.js';
import { procesarRegistroBiofile } from './procesar-registro.js';

const jobs = new Map();
let cola = Promise.resolve();
let servidor;

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

function responderJson(req, res, status, payload) {
  aplicarCors(req, res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function extraerClave(req) {
  const directa = String(req.headers['x-api-key'] || '').trim();
  if (directa) return directa;
  const auth = String(req.headers.authorization || '');
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function comparacionSegura(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function autorizado(req) {
  return Boolean(config.api.key) && comparacionSegura(extraerClave(req), config.api.key);
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
    creadoEn: job.creadoEn,
    iniciadoEn: job.iniciadoEn || null,
    finalizadoEn: job.finalizadoEn || null,
    resultado: job.resultado || null,
    error: job.error || null
  };
}

function encolar({ documento, fila, subirImagenes }) {
  limpiarJobsAntiguos();

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
        job.resultado = await procesarRegistroBiofile({
          documento: job.documento,
          fila: job.fila,
          subirImagenes: job.subirImagenes,
          jobId: job.id
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

  return { job, duplicado: false };
}

async function manejar(req, res) {
  if (req.method === 'OPTIONS') {
    aplicarCors(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/api/health')) {
    responderJson(req, res, 200, {
      ok: true,
      servicio: 'BIOFILE Robot API',
      estado: 'activo',
      cola: [...jobs.values()].filter((j) => ['en_cola', 'procesando'].includes(j.estado)).length,
      hora: ahoraIso()
    });
    return;
  }

  if (!autorizado(req)) {
    responderJson(req, res, 401, {
      ok: false,
      error: 'No autorizado. Envía la clave en X-API-Key o Authorization: Bearer.'
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
    const { job, duplicado } = encolar({ documento, fila, subirImagenes });

    responderJson(req, res, duplicado ? 409 : 202, {
      ok: !duplicado,
      duplicado,
      mensaje: duplicado
        ? 'Ese documento ya está en cola o procesándose.'
        : 'Solicitud recibida. Consulta el estado con el jobId.',
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
    responderJson(req, res, 200, { ok: true, job: jobPublico(job) });
    return;
  }

  responderJson(req, res, 404, { ok: false, error: 'Endpoint no encontrado.' });
}

validarConfiguracion({
  requiereApi: true,
  requiereBiofile: true,
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
