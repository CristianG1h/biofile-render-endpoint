import crypto from 'node:crypto';
import fs from 'node:fs';
import { convertirFechaBiofile } from './fecha.js';
import { normalizar, texto } from './util.js';

const COLUMNAS_CONTROL = [
  'ESTADO_BIOFILE',
  'NUMERO_OS_BIOFILE',
  'FECHA_BIOFILE',
  'FECHA_BIOFILE_ISO',
  'ERROR_BIOFILE',
  'INTENTOS_BIOFILE',
  'COMO_SE_ENTERO',
  'USUARIO_BIOFILE',
  'MODO_INGRESO_BIOFILE'
];

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

    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
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

function documentoComoTexto(valor) {
  if (valor === null || valor === undefined || valor === '') return '';
  return String(valor).trim().replace(/\.0$/, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function numeroComoTexto(valor) {
  if (valor === null || valor === undefined || valor === '') return '';
  return String(valor).trim().replace(/\.0$/, '').replace(/\D/g, '');
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

function fechaIsoBogota() {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(new Date()).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  );
  return `${partes.year}-${partes.month}-${partes.day}T${partes.hour}:${partes.minute}:${partes.second}-05:00`;
}

function fechaSolo(valorIso, valorLegado = '') {
  const iso = String(valorIso || '').trim();
  const matchIso = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  if (matchIso) return matchIso[1];

  const legado = String(valorLegado || '').trim();
  let m = legado.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = legado.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
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

    this.credentials.private_key = String(this.credentials.private_key).replace(/\\n/g, '\n');
    this.accessToken = '';
    this.expiraEn = 0;
  }

  async token() {
    const ahora = Math.floor(Date.now() / 1000);
    if (this.accessToken && ahora < this.expiraEn - 60) return this.accessToken;

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
    const assertion = `${unsigned}.${base64url(signer.sign(this.credentials.private_key))}`;

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
    let data = {};
    try { data = bodyText ? JSON.parse(bodyText) : {}; } catch { data = {}; }
    if (!response.ok) {
      const detalle = data?.error?.message || bodyText || `HTTP ${response.status}`;
      throw new Error(`Error de Google Sheets: ${detalle}`);
    }
    return data;
  }

  async getValues(spreadsheetId, range) {
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`);
    url.searchParams.set('majorDimension', 'ROWS');
    url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');
    url.searchParams.set('dateTimeRenderOption', 'SERIAL_NUMBER');
    const data = await this.request(url.toString());
    return data.values || [];
  }

  async batchUpdateValues(spreadsheetId, data) {
    return this.request(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data })
    });
  }
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
  }

  async cargar() {
    if (!['public', 'service_account'].includes(this.authMode)) {
      throw new Error('GOOGLE_AUTH_MODE debe ser public o service_account.');
    }

    if (this.authMode === 'service_account') {
      this.api = new SheetsApiClient({
        credentialsPath: this.credentialsPath,
        credentialsJson: this.credentialsJson
      });
      await this.#leerApi();
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

  async #leerApi() {
    const range = `${escaparHoja(this.hoja)}!A:AZ`;
    this.rows = await this.api.getValues(this.spreadsheetId, range);
    if (!this.rows.length) throw new Error(`La hoja "${this.hoja}" está vacía o no existe.`);
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
    await this.#leerApi();
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

  #filaPorDocumento(documento) {
    const buscado = documentoComoTexto(documento);
    if (!buscado) return 0;
    for (let row = this.rows.length; row >= 2; row -= 1) {
      if (documentoComoTexto(this.#getRaw(row, 'N° documento')) === buscado) return row;
    }
    return 0;
  }

  obtenerPendientes({ max = Infinity, documento = '', fila = 0 } = {}) {
    const registros = [];
    const documentoBuscado = documentoComoTexto(documento);
    const filaBuscada = Number(fila || 0);

    for (let row = 2; row <= this.rows.length; row += 1) {
      const numeroDocumento = documentoComoTexto(this.#getRaw(row, 'N° documento'));
      if (!numeroDocumento) continue;
      if (filaBuscada && row !== filaBuscada) continue;
      if (documentoBuscado && numeroDocumento !== documentoBuscado) continue;

      const estado = normalizar(this.#get(row, 'ESTADO_BIOFILE'));
      if (estado && !['PENDIENTE', 'ERROR'].includes(estado)) continue;

      registros.push({
        row,
        tipoDocumento: this.#get(row, 'Tipo doc'),
        numeroDocumento,
        primerApellido: this.#get(row, 'Primer apellido'),
        segundoApellido: this.#get(row, 'Segundo apellido'),
        primerNombre: this.#get(row, 'Primer nombre'),
        otrosNombres: this.#get(row, 'Otros nombres'),
        fechaNacimiento: convertirFechaBiofile(this.#getRaw(row, 'Fecha nacimiento')),
        ciudadNacimiento: this.#get(row, 'Ciudad nacimiento'),
        genero: this.#get(row, 'Género'),
        estadoCivil: this.#get(row, 'Estado civil'),
        nivelEducativo: this.#get(row, 'Nivel educativo'),
        correo: this.#get(row, 'Correo'),
        zona: this.#get(row, 'Zona'),
        direccion: this.#get(row, 'Dirección'),
        barrio: this.#get(row, 'Barrio'),
        municipio: this.#get(row, 'Municipio'),
        estrato: numeroComoTexto(this.#getRaw(row, 'Estrato')),
        celular: numeroComoTexto(this.#getRaw(row, 'Celular')),
        telefono: numeroComoTexto(this.#getRaw(row, 'Teléfono fijo')),
        profesionCargo: this.#get(row, 'Profesión o cargo'),
        funcionesCargo: this.#get(row, 'Funciones del cargo'),
        empresaExcel: this.#get(row, 'Empresa en misión'),
        fotoUrl: this.#get(row, 'FOTO (enlace)'),
        firmaUrl: this.#get(row, 'FIRMA (enlace)')
      });

      if (registros.length >= max) break;
    }

    return registros;
  }

  async #actualizar(row, valores) {
    if (this.authMode !== 'service_account') {
      throw new Error('Para actualizar Google Sheets debes usar GOOGLE_AUTH_MODE=service_account.');
    }
    const data = Object.entries(valores).map(([nombre, valor]) => {
      const col = this.#col(nombre);
      if (!col) throw new Error(`No existe la columna ${nombre} en Google Sheets.`);
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

  async actualizarCampos(row, valores) {
    await this.#actualizar(Number(row), valores);
  }

  async actualizarCampoPorDocumento(documento, campo, valor) {
    const row = this.#filaPorDocumento(documento);
    if (!row) throw new Error('No se encontró ese documento en Google Sheets.');
    if (!this.#col(campo)) throw new Error(`No existe la columna ${campo} en Google Sheets.`);
    await this.#actualizar(row, { [campo]: valor });
    return { row, campo, valor };
  }

  async marcarProcesando(row, usuario = '') {
    const actual = Number(this.#getRaw(row, 'INTENTOS_BIOFILE') || 0);
    await this.#actualizar(row, {
      ESTADO_BIOFILE: 'PROCESANDO',
      INTENTOS_BIOFILE: actual + 1,
      ERROR_BIOFILE: '',
      USUARIO_BIOFILE: usuario || this.#get(row, 'USUARIO_BIOFILE'),
      MODO_INGRESO_BIOFILE: 'AUTOMATICO',
      FECHA_BIOFILE_ISO: fechaIsoBogota()
    });
  }

  async marcarOrdenCreada(row, numeroOrden, usuario = '') {
    await this.#actualizar(row, {
      ESTADO_BIOFILE: 'ORDEN_CREADA',
      NUMERO_OS_BIOFILE: numeroOrden || '',
      FECHA_BIOFILE: fechaHoraBogota(),
      FECHA_BIOFILE_ISO: fechaIsoBogota(),
      USUARIO_BIOFILE: usuario || this.#get(row, 'USUARIO_BIOFILE'),
      MODO_INGRESO_BIOFILE: 'AUTOMATICO'
    });
  }

  async marcarCompletado(row, numeroOrden, usuario = '', modo = 'AUTOMATICO') {
    await this.#actualizar(row, {
      ESTADO_BIOFILE: 'COMPLETADO',
      NUMERO_OS_BIOFILE: numeroOrden || this.#get(row, 'NUMERO_OS_BIOFILE'),
      FECHA_BIOFILE: fechaHoraBogota(),
      FECHA_BIOFILE_ISO: fechaIsoBogota(),
      ERROR_BIOFILE: '',
      USUARIO_BIOFILE: usuario || this.#get(row, 'USUARIO_BIOFILE'),
      MODO_INGRESO_BIOFILE: String(modo || 'AUTOMATICO').toUpperCase()
    });
  }

  async marcarCompletadoManual(documento, usuario = '') {
    const row = this.#filaPorDocumento(documento);
    if (!row) throw new Error('No se encontró ese documento en Google Sheets.');
    await this.marcarCompletado(row, this.#get(row, 'NUMERO_OS_BIOFILE'), usuario, 'MANUAL');
    return { row };
  }

  async marcarError(row, error, { parcial = false, numeroOrden = '', usuario = '' } = {}) {
    await this.#actualizar(row, {
      ESTADO_BIOFILE: parcial ? 'PARCIAL' : 'ERROR',
      NUMERO_OS_BIOFILE: numeroOrden || this.#get(row, 'NUMERO_OS_BIOFILE'),
      FECHA_BIOFILE: fechaHoraBogota(),
      FECHA_BIOFILE_ISO: fechaIsoBogota(),
      ERROR_BIOFILE: String(error?.message || error).slice(0, 5000),
      USUARIO_BIOFILE: usuario || this.#get(row, 'USUARIO_BIOFILE'),
      MODO_INGRESO_BIOFILE: 'AUTOMATICO'
    });
  }

  obtenerEstadisticasUsuarios({ desde = '', hasta = '' } = {}) {
    const mapa = new Map();
    let total = 0;

    for (let row = 2; row <= this.rows.length; row += 1) {
      const usuario = this.#get(row, 'USUARIO_BIOFILE');
      if (!usuario) continue;

      const fecha = fechaSolo(this.#get(row, 'FECHA_BIOFILE_ISO'), this.#get(row, 'FECHA_BIOFILE'));
      if (!fecha) continue;
      if (desde && fecha < desde) continue;
      if (hasta && fecha > hasta) continue;

      const estado = normalizar(this.#get(row, 'ESTADO_BIOFILE'));
      const modo = normalizar(this.#get(row, 'MODO_INGRESO_BIOFILE'));
      const actual = mapa.get(usuario) || {
        usuario,
        total: 0,
        completados: 0,
        errores: 0,
        enProceso: 0,
        manuales: 0,
        automaticos: 0
      };

      actual.total += 1;
      total += 1;
      if (estado === 'COMPLETADO') actual.completados += 1;
      else if (['ERROR', 'PARCIAL'].includes(estado)) actual.errores += 1;
      else if (['PROCESANDO', 'ORDEN_CREADA'].includes(estado)) actual.enProceso += 1;
      if (modo === 'MANUAL') actual.manuales += 1;
      if (modo === 'AUTOMATICO') actual.automaticos += 1;
      mapa.set(usuario, actual);
    }

    const usuarios = [...mapa.values()].sort((a, b) =>
      b.completados - a.completados || b.total - a.total || a.usuario.localeCompare(b.usuario, 'es')
    );

    return {
      desde,
      hasta,
      total,
      lider: usuarios[0] || null,
      usuarios
    };
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
