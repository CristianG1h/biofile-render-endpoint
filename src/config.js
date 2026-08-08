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

function idUsuario(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function leerUsuariosBiofile() {
  const jsonDirecto = String(env('BIOFILE_USERS_JSON')).trim();
  const archivo = String(env('BIOFILE_USERS_FILE')).trim();

  if (!jsonDirecto && !archivo) return [];

  let contenido;
  try {
    contenido = jsonDirecto
      ? JSON.parse(jsonDirecto)
      : JSON.parse(fs.readFileSync(rutaAbsoluta(archivo), 'utf8'));
  } catch (error) {
    throw new Error(`No se pudo leer la configuración multiusuario de BIOFILE: ${error.message}`);
  }

  const elementos = Array.isArray(contenido)
    ? contenido
    : Object.entries(contenido || {}).map(([usuario, contrasena]) => ({
        nombre: usuario,
        usuario,
        contrasena
      }));

  const ids = new Set();
  const usuarios = elementos.map((item, index) => {
    const nombre = String(item?.nombre || item?.usuario || '').trim();
    const usuario = String(item?.usuario || '').trim();
    const contrasena = String(item?.contrasena ?? '');
    const id = idUsuario(item?.id || usuario || nombre);

    if (!id || !nombre || !usuario || !contrasena) {
      throw new Error(
        `El usuario BIOFILE número ${index + 1} debe incluir nombre, usuario y contrasena.`
      );
    }
    if (ids.has(id)) {
      throw new Error(`Hay dos usuarios BIOFILE con el mismo id: ${id}`);
    }
    ids.add(id);

    return { id, nombre, usuario, contrasena };
  });

  return usuarios;
}

const selectorsPath = rutaAbsoluta(env('SELECTORS_PATH', './config/selectors.json'));
const runtimeDir = rutaAbsoluta(env('RUNTIME_DIR', '/tmp/biofile-robot'));
const usuariosBiofile = leerUsuariosBiofile();

export const config = {
  api: {
    port: entero(env('PORT', '10000'), 10000),
    key: env('API_KEY'),
    allowedOrigins: listaCsv(env('ALLOWED_ORIGINS', '*')),
    maxBodyBytes: entero(env('MAX_BODY_BYTES', '65536'), 65536),
    jobRetentionMs: entero(env('JOB_RETENTION_MS', String(6 * 60 * 60 * 1000)), 6 * 60 * 60 * 1000)
  },
  auth: {
    users: usuariosBiofile,
    sessionSecret: env('SESSION_SECRET'),
    sessionTtlMs: entero(env('SESSION_TTL_MS', String(12 * 60 * 60 * 1000)), 12 * 60 * 60 * 1000),
    loginMaxAttempts: entero(env('LOGIN_MAX_ATTEMPTS', '5'), 5),
    loginWindowMs: entero(env('LOGIN_WINDOW_MS', String(15 * 60 * 1000)), 15 * 60 * 1000)
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
    authPath: rutaAbsoluta(env('BIOFILE_AUTH_PATH', path.join(runtimeDir, 'auth', 'biofile.json'))),
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

export function validarConfiguracion({
  requiereApi = false,
  requiereBiofile = true,
  requiereDefaults = true,
  requiereGoogle = true,
  requiereEscrituraGoogle = false
} = {}, configuracion = config) {
  const faltantes = [];
  const actual = configuracion;

  if (requiereApi && !actual.api.key && !actual.auth?.users?.length) {
    faltantes.push('API_KEY o BIOFILE_USERS_JSON');
  }
  if (requiereApi && actual.auth?.users?.length && !actual.auth.sessionSecret) {
    faltantes.push('SESSION_SECRET');
  }
  if (requiereBiofile && !actual.biofile.usuario) faltantes.push('BIOFILE_USUARIO');
  if (requiereBiofile && !actual.biofile.contrasena) faltantes.push('BIOFILE_CONTRASENA');
  if (requiereGoogle && !actual.google.urlOId) faltantes.push('GOOGLE_SHEETS_URL');
  if (requiereGoogle && !actual.google.hoja) faltantes.push('GOOGLE_SHEETS_HOJA');
  if (requiereDefaults && !actual.defaults.localidad) faltantes.push('DEFAULT_LOCALIDAD');
  if (requiereDefaults && !actual.defaults.sede) faltantes.push('DEFAULT_SEDE');
  if (requiereDefaults && !actual.defaults.tipoEvaluacion) faltantes.push('DEFAULT_TIPO_EVALUACION');

  if (requiereEscrituraGoogle && actual.google.authMode.toLowerCase() !== 'service_account') {
    faltantes.push('GOOGLE_AUTH_MODE=service_account');
  }

  if (requiereGoogle && actual.google.authMode.toLowerCase() === 'service_account') {
    const tieneJson = Boolean(actual.google.credentialsJson);
    const tieneArchivo = Boolean(actual.google.credentialsPath) && fs.existsSync(actual.google.credentialsPath);
    if (!tieneJson && !tieneArchivo) {
      faltantes.push('archivo secreto GOOGLE_SERVICE_ACCOUNT_FILE o GOOGLE_SERVICE_ACCOUNT_JSON');
    }
  }

  if (faltantes.length) {
    throw new Error(`Faltan valores obligatorios de configuración: ${faltantes.join(', ')}`);
  }
}
