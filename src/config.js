import fs from 'node:fs';
import path from 'node:path';
import { booleano, entero, leerJsonSiExiste, rutaAbsoluta } from './util.js';

function env(nombre, defecto = '') {
  return process.env[nombre] ?? defecto;
}

function listaCsv(valor) {
  return String(valor || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function idSeguro(valor) {
  return String(valor || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'usuario';
}

function normalizarRol(valor) {
  const rol = String(valor || 'user').trim().toLowerCase();
  if (rol === 'superadmin') return 'superadmin';
  if (rol === 'admin') return 'admin';
  return 'user';
}

function cargarUsuariosEntorno() {
  const usuarios = [];

  for (const [nombreVariable, usuario] of Object.entries(process.env)) {
    const match = nombreVariable.match(/^BIOFILE_USER_(.+)$/);
    if (!match) continue;

    const sufijo = match[1];
    const contrasena = process.env[`BIOFILE_PASSWORD_${sufijo}`] ?? process.env[`BIOFILE_PASS_${sufijo}`] ?? '';
    const rol = normalizarRol(process.env[`BIOFILE_ROLE_${sufijo}`] || 'user');

    if (!String(usuario || '').trim() || !String(contrasena || '').trim()) continue;

    usuarios.push({
      id: `env_${idSeguro(sufijo)}`,
      usuario: String(usuario).trim(),
      contrasena: String(contrasena),
      rol,
      activo: true,
      fuente: 'render'
    });
  }

  // Compatibilidad con la configuración antigua de un solo usuario.
  if (!usuarios.length && env('BIOFILE_USUARIO') && env('BIOFILE_CONTRASENA')) {
    usuarios.push({
      id: 'env_legacy',
      usuario: env('BIOFILE_USUARIO').trim(),
      contrasena: env('BIOFILE_CONTRASENA'),
      rol: 'admin',
      activo: true,
      fuente: 'render'
    });
  }

  return usuarios.sort((a, b) => a.usuario.localeCompare(b.usuario, 'es'));
}

const selectorsPath = rutaAbsoluta(env('SELECTORS_PATH', './config/selectors.json'));
const runtimeDir = rutaAbsoluta(env('RUNTIME_DIR', '/tmp/biofile-robot'));
const authDir = rutaAbsoluta(env('BIOFILE_AUTH_DIR', path.join(runtimeDir, 'auth')));

export const config = {
  api: {
    port: entero(env('PORT', '10000'), 10000),
    key: env('API_KEY'),
    allowedOrigins: listaCsv(env('ALLOWED_ORIGINS', '*')),
    maxBodyBytes: entero(env('MAX_BODY_BYTES', '65536'), 65536),
    jobRetentionMs: entero(env('JOB_RETENTION_MS', String(6 * 60 * 60 * 1000)), 6 * 60 * 60 * 1000),
    sessionTtlMs: entero(env('SESSION_TTL_MS', String(12 * 60 * 60 * 1000)), 12 * 60 * 60 * 1000)
  },
  usuariosEntorno: cargarUsuariosEntorno(),
  seguridad: {
    encryptionKey: env('BIOFILE_ENCRYPTION_KEY')
  },
  usuariosStore: {
    hojaUsuarios: env('BIOFILE_USERS_SHEET', 'USUARIOS_BIOFILE'),
    hojaAuditoria: env('BIOFILE_AUDIT_SHEET', 'AUDITORIA_BIOFILE')
  },
  biofile: {
    usuario: env('BIOFILE_USUARIO'),
    contrasena: env('BIOFILE_CONTRASENA'),
    loginUrl: env('BIOFILE_LOGIN_URL', 'https://vipso.biofile.com.co/IniciarSesion.aspx?ReturnUrl=%2f'),
    ordenUrl: env('BIOFILE_ORDEN_URL', 'https://vipso.biofile.com.co/Factura/OrdenesServiciosSaludOcupacional.aspx'),
    esperaPacienteMs: entero(env('BIOFILE_ESPERA_PACIENTE_MS', '4500'), 4500)
  },
  google: {
    urlOId: env('GOOGLE_SHEETS_URL'),
    hoja: env('GOOGLE_SHEETS_HOJA', 'Hoja 1'),
    authMode: env('GOOGLE_AUTH_MODE', 'service_account'),
    credentialsPath: rutaAbsoluta(env('GOOGLE_SERVICE_ACCOUNT_FILE', '/etc/secrets/google-service-account.json')),
    credentialsJson: env('GOOGLE_SERVICE_ACCOUNT_JSON')
  },
  defaults: {
    zona: env('DEFAULT_ZONA', 'URBANA'),
    localidad: env('DEFAULT_LOCALIDAD'),
    sede: env('DEFAULT_SEDE'),
    tipoEvaluacion: env('DEFAULT_TIPO_EVALUACION'),
    acuerdo: env('DEFAULT_ACUERDO', 'PARTICULARES'),
    empresaMision: env('DEFAULT_EMPRESA_MISION', 'PARTICULARES'),
    paquete: env('DEFAULT_PAQUETE', 'NO APLICA'),
    eps: env('DEFAULT_EPS', 'NO REFIERE'),
    afp: env('DEFAULT_AFP', 'NO REFIERE'),
    arl: env('DEFAULT_ARL', 'NO REFIERE'),
    diagnostico: env('DEFAULT_DIAGNOSTICO', 'Z100'),
    tipoVinculacion: env('DEFAULT_TIPO_VINCULACION', 'CONTRIBUTIVO'),
    tipoAfiliado: env('DEFAULT_TIPO_AFILIADO', 'COTIZANTE'),
    nivel: env('DEFAULT_NIVEL', '2'),
    productoServicio: env('DEFAULT_PRODUCTO_SERVICIO'),
    cantidad: env('DEFAULT_CANTIDAD', '1'),
    prestador: env('DEFAULT_PRESTADOR', 'No Aplica'),
    formaPago: env('DEFAULT_FORMA_PAGO', 'CONTADO'),
    valor: env('DEFAULT_VALOR')
  },
  browser: {
    headless: booleano(env('HEADLESS', 'true'), true),
    slowMo: entero(env('SLOW_MO_MS', '0'), 0),
    timeout: entero(env('TIMEOUT_MS', '45000'), 45000),
    executablePath: env('PLAYWRIGHT_EXECUTABLE_PATH'),
    authDir,
    authPath: rutaAbsoluta(env('BIOFILE_AUTH_PATH', path.join(authDir, 'biofile.json'))),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  },
  subirImagenes: booleano(env('SUBIR_IMAGENES', 'true'), true),
  subirImagenesPacienteExistente: booleano(env('SUBIR_IMAGENES_PACIENTE_EXISTENTE', 'false'), false),
  usarEmpresaExcel: booleano(env('USAR_EMPRESA_GOOGLE_SHEETS', 'false'), false),
  selectorsPath,
  selectors: leerJsonSiExiste(selectorsPath, {}),
  paths: {
    screenshots: rutaAbsoluta(env('SCREENSHOTS_DIR', path.join(runtimeDir, 'screenshots'))),
    logs: rutaAbsoluta(env('LOGS_DIR', path.join(runtimeDir, 'logs')))
  }
};

export function configParaUsuario(usuario) {
  if (!usuario?.usuario || !usuario?.contrasena) {
    throw new Error('No se recibió un usuario BIOFILE válido para crear la sesión.');
  }

  const id = idSeguro(usuario.id || usuario.usuario);
  return {
    ...config,
    biofile: {
      ...config.biofile,
      usuario: usuario.usuario,
      contrasena: usuario.contrasena
    },
    browser: {
      ...config.browser,
      authPath: path.join(config.browser.authDir, `${id}.json`)
    },
    paths: {
      ...config.paths,
      screenshots: path.join(config.paths.screenshots, id)
    }
  };
}

export function validarConfiguracion({
  requiereApi = false,
  requiereBiofile = true,
  requiereDefaults = true,
  requiereGoogle = true,
  requiereEscrituraGoogle = false
} = {}) {
  const faltantes = [];

  if (requiereApi && !config.usuariosEntorno.length) {
    faltantes.push('al menos un usuario BIOFILE configurado en Render');
  }
  if (requiereBiofile && !config.biofile.usuario) faltantes.push('BIOFILE_USUARIO');
  if (requiereBiofile && !config.biofile.contrasena) faltantes.push('BIOFILE_CONTRASENA');
  if (requiereGoogle && !config.google.urlOId) faltantes.push('GOOGLE_SHEETS_URL');
  if (requiereGoogle && !config.google.hoja) faltantes.push('GOOGLE_SHEETS_HOJA');
  if (requiereDefaults && !config.defaults.localidad) faltantes.push('DEFAULT_LOCALIDAD');
  if (requiereDefaults && !config.defaults.sede) faltantes.push('DEFAULT_SEDE');
  if (requiereDefaults && !config.defaults.tipoEvaluacion) faltantes.push('DEFAULT_TIPO_EVALUACION');

  if (requiereEscrituraGoogle && config.google.authMode.toLowerCase() !== 'service_account') {
    faltantes.push('GOOGLE_AUTH_MODE=service_account');
  }

  if (requiereGoogle && config.google.authMode.toLowerCase() === 'service_account') {
    const tieneJson = Boolean(config.google.credentialsJson);
    const tieneArchivo = Boolean(config.google.credentialsPath) && fs.existsSync(config.google.credentialsPath);
    if (!tieneJson && !tieneArchivo) {
      faltantes.push('archivo secreto GOOGLE_SERVICE_ACCOUNT_FILE o GOOGLE_SERVICE_ACCOUNT_JSON');
    }
  }

  if (faltantes.length) {
    throw new Error(`Faltan valores obligatorios de configuración: ${faltantes.join(', ')}`);
  }
}
