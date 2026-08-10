import crypto from 'node:crypto';
import fs from 'node:fs';
import { convertirFechaBiofile } from './fecha.js';
import { normalizar, texto } from './util.js';

const COLUMNAS_CONTROL = [
  'ESTADO_BIOFILE',
  'NUMERO_OS_BIOFILE',
  'FECHA_BIOFILE',
  'ERROR_BIOFILE',
  'INTENTOS_BIOFILE',
  'COMO_SE_ENTERO'
];

const TOKEN_CACHE = new Map();
const REGISTROS_CACHE = new Map();
const REGISTROS_EN_CURSO = new Map();

function extraerSpreadsheetId(urlOId) {
  const valor = String(urlOId || '').trim();
  const match = valor.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(valor)) return valor;
  throw new Error('GOOGLE_SHEETS_URL no contiene un ID válido de Google Sheets.');
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < csv.length; i += 1) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

function base64url(valor) {
  return Buffer.from(valor)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function columnaA1(numero) {
  let n = numero;
  let resultado = '';
  while (n > 0) {
    n -= 1;
    resultado = String.fromCharCode(65 + (n % 26)) + resultado;
    n = Math.floor(n / 26);
  }
  return resultado;
}

function escaparHoja(nombre) {
  return `'${String(nombre).replace(/'/g, "''")}'`;
}

function numeroComoTexto(valor) {
  if (valor === null || valor === undefined || valor === '') return '';
  if (typeof valor === 'number') return Number.isInteger(valor) ? String(valor) : String(valor);
  return texto(valor).replace(/\.0$/, '').replace(/\D/g, '');
}

function fechaHoraBogota() {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date());
}

class SheetsApiClient {
  constructor({ credentialsPath, credentialsJson = '' }) {
    if (credentialsJson) {
      try {
        this.credentials = JSON.parse(credentialsJson);
      } catch {
        throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON no contiene un JSON válido.');
      }
    } else {
      if (!credentialsPath || !fs.existsSync(credentialsPath)) {
        throw new Error(`No se encontró la credencial de Google: ${credentialsPath || '(ruta vacía)'}`);
      }
      this.credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    }

    if (!this.credentials.client_email || !this.credentials.private_key) {
      throw new Error('El JSON de Google no contiene client_email o private_key.');
    }

    // Permite pegar la clave privada como una variable con saltos escapados (\n).
    this.credentials.private_key = String(this.credentials.private_key).replace(/\\n/g, '\n');
    this.accessToken = '';
    this.expiraEn = 0;
  }

  async token() {
    const ahora = Math.floor(Date.now() / 1000);
    if (this.accessToken && ahora < this.expiraEn - 60) return this.accessToken;

    const cacheado = TOKEN_CACHE.get(this.credentials.client_email);
    if (cacheado?.accessToken && ahora < cacheado.expiraEn - 60) {
      this.accessToken = cacheado.accessToken;
      this.expiraEn = cacheado.expiraEn;
      return this.accessToken;
    }

    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({
      iss: this.credentials.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: ahora,
      exp: ahora + 3600
    }));
    const unsigned = `${header}.${payload}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const firma = signer.sign(this.credentials.private_key);
    const assertion = `${unsigned}.${base64url(firma)}`;

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      throw new Error(`Google rechazó la autenticación: ${data.error_description || data.error || response.status}`);
    }
    this.accessToken = data.access_token;
    this.expiraEn = ahora + Number(data.expires_in || 3600);
    TOKEN_CACHE.set(this.credentials.client_email, {
      accessToken: this.accessToken,
      expiraEn: this.expiraEn
    });
    return this.accessToken;
  }

  async request(url, options = {}) {
    const token = await this.token();
    const response = await fetch(url, {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(options.headers || {})
      }
    });
    const bodyText = await response.text();
    const data = bodyText ? JSON.parse(bodyText) : {};
    if (!response.ok) {
      const detalle = data?.error?.message || bodyText || `HTTP ${response.status}`;
      throw new Error(`Error de Google Sheets: ${detalle}`);
    }
    return data;
  }

  async getValues(spreadsheetId, range, { formateados = false } = {}) {
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`);
    url.searchParams.set('majorDimension', 'ROWS');
    url.searchParams.set('valueRenderOption', formateados ? 'FORMATTED_VALUE' : 'UNFORMATTED_VALUE');
    if (!formateados) url.searchParams.set('dateTimeRenderOption', 'SERIAL_NUMBER');
    const data = await this.request(url.toString());
    return data.values || [];
  }

  async batchGetValues(spreadsheetId, ranges) {
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet`);
    for (const range of ranges) url.searchParams.append('ranges', range);
    url.searchParams.set('majorDimension', 'ROWS');
    url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');
    url.searchParams.set('dateTimeRenderOption', 'SERIAL_NUMBER');
    const data = await this.request(url.toString());
    return (data.valueRanges || []).map((item) => item.values || []);
  }

  async batchUpdateValues(spreadsheetId, data) {
    return this.request(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data })
    });
  }
}

/**
 * Convierte una respuesta de Sheets en los mismos objetos que consume el panel.
 * __fila permite que el robot lea después únicamente la fila seleccionada.
 */
export function convertirFilasARegistros(filas = []) {
  const encabezados = (filas[0] || []).map((valor) => texto(valor));
  if (!encabezados.some(Boolean)) return [];

  const registros = [];
  for (let indice = 1; indice < filas.length; indice += 1) {
    const valores = filas[indice] || [];
    if (!valores.some((valor) => texto(valor))) continue;

    const registro = { __fila: indice + 1 };
    encabezados.forEach((encabezado, columna) => {
      if (encabezado) registro[encabezado] = texto(valores[columna]);
    });
    registros.push(registro);
  }
  return registros;
}

export function filtrarRegistros(registros = [], busqueda = '') {
  const termino = normalizar(String(busqueda || '').slice(0, 150));
  if (!termino) return registros;

  return registros.filter((registro) => Object.entries(registro).some(([clave, valor]) => (
    clave !== '__fila' && normalizar(valor).includes(termino)
  )));
}

/**
 * Lista registros a través de la cuenta de servicio. Una caché muy corta evita
 * descargar la misma hoja varias veces cuando distintos usuarios abren el panel
 * al mismo tiempo, sin ocultar por mucho tiempo los estados recién actualizados.
 */
export async function listarRegistrosGoogleSheets({
  urlOId,
  hoja,
  credentialsPath,
  credentialsJson = '',
  busqueda = '',
  cacheMs = 5_000
}) {
  const spreadsheetId = extraerSpreadsheetId(urlOId);
  const claveCache = `${spreadsheetId}\0${hoja}`;
  const ahora = Date.now();
  const vigente = REGISTROS_CACHE.get(claveCache);
  let registros;

  if (vigente && ahora < vigente.expiraEn) {
    registros = vigente.registros;
  } else {
    let carga = REGISTROS_EN_CURSO.get(claveCache);
    if (!carga) {
      carga = (async () => {
        const api = new SheetsApiClient({ credentialsPath, credentialsJson });
        const rango = `${escaparHoja(hoja)}!A:ZZ`;
        const filas = await api.getValues(spreadsheetId, rango, { formateados: true });
        const nuevos = convertirFilasARegistros(filas);
        const ttl = Math.max(0, Math.min(60_000, Number(cacheMs) || 0));
        REGISTROS_CACHE.set(claveCache, { registros: nuevos, expiraEn: Date.now() + ttl });
        return nuevos;
      })();
      REGISTROS_EN_CURSO.set(claveCache, carga);
    }

    try {
      registros = await carga;
    } finally {
      if (REGISTROS_EN_CURSO.get(claveCache) === carga) {
        REGISTROS_EN_CURSO.delete(claveCache);
      }
    }
  }

  return filtrarRegistros(registros, busqueda);
}

export class BaseGoogleSheets {
  constructor({ urlOId, hoja, authMode, credentialsPath, credentialsJson = '', logger }) {
    this.spreadsheetId = extraerSpreadsheetId(urlOId);
    this.hoja = hoja;
    this.authMode = String(authMode || 'public').toLowerCase();
    this.credentialsPath = credentialsPath;
    this.credentialsJson = credentialsJson;
    this.logger = logger;
    this.rows = [];
    this.headers = new Map();
    this.api = null;
    this.filaCargada = 0;
  }

  async cargar({ fila = 0 } = {}) {
    if (!['public', 'service_account'].includes(this.authMode)) {
      throw new Error('GOOGLE_AUTH_MODE debe ser public o service_account.');
    }

    if (this.authMode === 'service_account') {
      this.api = new SheetsApiClient({
        credentialsPath: this.credentialsPath,
        credentialsJson: this.credentialsJson
      });
      await this.#leerApi(Number(fila) || 0);
      await this.#asegurarColumnasControl();
    } else {
      await this.#leerPublico();
    }

    this.#construirHeaders();
    this.#validarColumnasBase();
    return this;
  }

  async #leerPublico() {
    const url = `https://docs.google.com/spreadsheets/d/${this.spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(this.hoja)}`;
    const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0' } });
    const body = await response.text();
    if (!response.ok || /^\s*</.test(body)) {
      throw new Error('No se pudo leer la hoja públicamente. Verifica que esté compartida como “Cualquier persona con el enlace: Lector”.');
    }
    this.rows = parseCsv(body);
  }

  async #leerApi(fila = 0) {
    const filaExacta = Number.isInteger(fila) && fila >= 2 ? fila : 0;
    this.filaCargada = filaExacta;

    if (filaExacta) {
      const hoja = escaparHoja(this.hoja);
      const [encabezados, valores] = await this.api.batchGetValues(this.spreadsheetId, [
        `${hoja}!A1:ZZ1`,
        `${hoja}!A${filaExacta}:ZZ${filaExacta}`
      ]);
      this.rows = [];
      this.rows[0] = encabezados?.[0] || [];
      this.rows[filaExacta - 1] = valores?.[0] || [];
    } else {
      const range = `${escaparHoja(this.hoja)}!A:ZZ`;
      this.rows = await this.api.getValues(this.spreadsheetId, range);
    }

    if (!this.rows[0]?.length) throw new Error(`La hoja "${this.hoja}" está vacía o no existe.`);
  }

  #construirHeaders() {
    this.headers = new Map();
    const header = this.rows[0] || [];
    header.forEach((valor, index) => {
      const key = normalizar(valor);
      if (key) this.headers.set(key, index + 1);
    });
  }

  async #asegurarColumnasControl() {
    this.#construirHeaders();
    const faltantes = COLUMNAS_CONTROL.filter((nombre) => !this.headers.has(normalizar(nombre)));
    if (!faltantes.length) return;

    const inicio = (this.rows[0]?.length || 0) + 1;
    const data = faltantes.map((nombre, index) => ({
      range: `${escaparHoja(this.hoja)}!${columnaA1(inicio + index)}1`,
      values: [[nombre]]
    }));
    await this.api.batchUpdateValues(this.spreadsheetId, data);
    await this.#leerApi(this.filaCargada);
    this.logger?.info('Columnas de control agregadas a Google Sheets.', { columnas: faltantes });
  }

  #validarColumnasBase() {
    [
      'Tipo doc', 'N° documento', 'Primer apellido', 'Primer nombre',
      'Fecha nacimiento', 'Ciudad nacimiento', 'Género', 'Estado civil',
      'Nivel educativo', 'Zona', 'Dirección', 'Municipio', 'Estrato',
      'Celular', 'Profesión o cargo', 'Funciones del cargo',
      'FOTO (enlace)', 'FIRMA (enlace)'
    ].forEach((nombre) => {
      if (!this.headers.has(normalizar(nombre))) {
        throw new Error(`No existe la columna requerida en Google Sheets: ${nombre}`);
      }
    });
  }

  #col(nombre) {
    return this.headers.get(normalizar(nombre)) || 0;
  }

  #get(rowNumber, nombre) {
    const col = this.#col(nombre);
    if (!col) return '';
    return texto(this.rows[rowNumber - 1]?.[col - 1]);
  }

  #getRaw(rowNumber, nombre) {
    const col = this.#col(nombre);
    if (!col) return '';
    return this.rows[rowNumber - 1]?.[col - 1] ?? '';
  }

  #getPrimero(rowNumber, nombres) {
    for (const nombre of nombres) {
      const valor = this.#get(rowNumber, nombre);
      if (valor) return valor;
    }
    return '';
  }

  #getPorPalabras(rowNumber, palabras, excluidas = []) {
    const requeridas = palabras.map(normalizar);
    const prohibidas = excluidas.map(normalizar);
    for (const [encabezado, columna] of this.headers) {
      if (
        requeridas.every((palabra) => encabezado.includes(palabra)) &&
        prohibidas.every((palabra) => !encabezado.includes(palabra))
      ) {
        return texto(this.rows[rowNumber - 1]?.[columna - 1]);
      }
    }
    return '';
  }

  obtenerPendientes({
  max = Infinity,
  documento = '',
  fila = 0
} = {}) {
  const registros = [];

  const documentoBuscado = numeroComoTexto(documento);
  const filaBuscada = Number(fila || 0);

  const filaInicial = filaBuscada || 2;
  const filaFinal = filaBuscada || this.rows.length;

  for (let row = filaInicial; row <= filaFinal; row += 1) {
    const numeroDocumento = numeroComoTexto(
      this.#getRaw(row, 'N° documento')
    );

    if (!numeroDocumento) continue;

    // Permite escoger una fila exacta de Google Sheets.
    if (filaBuscada && row !== filaBuscada) {
      continue;
    }

    // Permite escoger una persona por documento.
    if (
      documentoBuscado &&
      numeroDocumento !== documentoBuscado
    ) {
      continue;
    }

    const estado = normalizar(
      this.#get(row, 'ESTADO_BIOFILE')
    );

    if (
      estado &&
      !['PENDIENTE', 'ERROR'].includes(estado)
    ) {
      continue;
    }

    const zona = this.#get(row, 'Zona');
    const zonaNormalizada = normalizar(zona);
    const localidad = this.#getPrimero(row, [
      'Localidad',
      'Localidad Bogotá',
      'Localidad Bogota',
      'Localidad de Bogotá',
      'Localidad de Bogota',
      'Localidad de residencia',
      'Localidad donde vive'
    ]) || this.#getPorPalabras(row, ['LOCALIDAD'], ['NACIMIENTO']) || (
      ['URBANA', 'RURAL'].includes(zonaNormalizada) ? '' : zona
    );

    registros.push({
      row,
      tipoDocumento: this.#get(row, 'Tipo doc'),
      numeroDocumento,
      primerApellido: this.#get(row, 'Primer apellido'),
      segundoApellido: this.#get(row, 'Segundo apellido'),
      primerNombre: this.#get(row, 'Primer nombre'),
      otrosNombres: this.#get(row, 'Otros nombres'),

      fechaNacimiento: convertirFechaBiofile(
        this.#getRaw(row, 'Fecha nacimiento')
      ),

      ciudadNacimiento: this.#get(row, 'Ciudad nacimiento'),
      genero: this.#get(row, 'Género'),
      estadoCivil: this.#get(row, 'Estado civil'),
      nivelEducativo: this.#get(row, 'Nivel educativo'),
      correo: this.#get(row, 'Correo'),
      zona,
      direccion: this.#get(row, 'Dirección'),
      barrio: this.#get(row, 'Barrio'),
      municipio: this.#get(row, 'Municipio'),
      localidad,
      municipioResidencia: this.#getPrimero(row, [
        'Municipio residencia',
        'Municipio o ciudad donde vive',
        'Municipio donde vive'
      ]),
      eps: this.#getPrimero(row, ['EPS', 'Eps']),
      afp: this.#getPrimero(row, [
        'AFP',
        'Afp',
        'Fondo de pensiones (AFP)',
        'Fondo de pensiones'
      ]),
      arl: this.#getPrimero(row, ['ARL', 'Arl']),

      estrato: numeroComoTexto(
        this.#getRaw(row, 'Estrato')
      ),

      celular: numeroComoTexto(
        this.#getRaw(row, 'Celular')
      ),

      telefono: numeroComoTexto(
        this.#getRaw(row, 'Teléfono fijo')
      ),

      profesionCargo: this.#get(row, 'Profesión o cargo'),
      funcionesCargo: this.#get(row, 'Funciones del cargo'),
      empresaExcel: this.#get(row, 'Empresa en misión'),
      fotoUrl: this.#get(row, 'FOTO (enlace)'),
      firmaUrl: this.#get(row, 'FIRMA (enlace)')
    });

    if (registros.length >= max) {
      break;
    }
  }

  return registros;
}
  async #actualizar(row, valores) {
    if (this.authMode !== 'service_account') {
      throw new Error('Para actualizar estados debes usar GOOGLE_AUTH_MODE=service_account.');
    }
    const data = Object.entries(valores).map(([nombre, valor]) => {
      const col = this.#col(nombre);
      if (!col) throw new Error(`No existe la columna de control ${nombre}.`);
      return {
        range: `${escaparHoja(this.hoja)}!${columnaA1(col)}${row}`,
        values: [[valor]]
      };
    });
    await this.api.batchUpdateValues(this.spreadsheetId, data);

    for (const [nombre, valor] of Object.entries(valores)) {
      const col = this.#col(nombre);
      while ((this.rows[row - 1] || []).length < col) this.rows[row - 1].push('');
      this.rows[row - 1][col - 1] = valor;
    }
  }

  async marcarProcesando(row) {
    const actual = Number(this.#getRaw(row, 'INTENTOS_BIOFILE') || 0);
    await this.#actualizar(row, {
      ESTADO_BIOFILE: 'PROCESANDO',
      INTENTOS_BIOFILE: actual + 1,
      ERROR_BIOFILE: ''
    });
  }

  async marcarOrdenCreada(row, numeroOrden) {
    await this.#actualizar(row, {
      ESTADO_BIOFILE: 'ORDEN_CREADA',
      NUMERO_OS_BIOFILE: numeroOrden || '',
      FECHA_BIOFILE: fechaHoraBogota()
    });
  }

  async marcarCompletado(row, numeroOrden) {
    await this.#actualizar(row, {
      ESTADO_BIOFILE: 'COMPLETADO',
      NUMERO_OS_BIOFILE: numeroOrden || this.#get(row, 'NUMERO_OS_BIOFILE'),
      FECHA_BIOFILE: fechaHoraBogota(),
      ERROR_BIOFILE: ''
    });
  }

  async marcarError(row, error, { parcial = false, numeroOrden = '' } = {}) {
    await this.#actualizar(row, {
      ESTADO_BIOFILE: parcial ? 'PARCIAL' : 'ERROR',
      NUMERO_OS_BIOFILE: numeroOrden || this.#get(row, 'NUMERO_OS_BIOFILE'),
      FECHA_BIOFILE: fechaHoraBogota(),
      ERROR_BIOFILE: String(error?.message || error).slice(0, 5000)
    });
  }

  resumen() {
    return {
      spreadsheetId: this.spreadsheetId,
      hoja: this.hoja,
      authMode: this.authMode,
      filas: Math.max(0, this.rows.length - 1),
      columnas: this.rows[0]?.length || 0,
      encabezados: this.rows[0] || []
    };
  }
}
