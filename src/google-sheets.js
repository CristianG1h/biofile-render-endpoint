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
  'MODO_INGRESO_BIOFILE',
  /* ESTADOS_OPERACION_V5 */
  'REGISTRADO_POR_BIOFILE',
  'ELIMINADO_POR',
  'FECHA_ELIMINADO_ISO',
  'MOTIVO_ELIMINADO',
  /* IDEMPOTENCIA_BIOFILE_V6 */
  'JOB_ID_BIOFILE',
  'SOLICITADO_POR_BIOFILE',
  'GUARDADO_INTENTADO_BIOFILE',
  'GUARDADO_CONFIRMADO_BIOFILE',
  'ULTIMA_ETAPA_BIOFILE',
  'SESION_BIOFILE_USUARIO',
  'ACUERDO_COMERCIAL_BIOFILE',
  'EMPRESA_MISION_BIOFILE',
  'ORIGEN_RELACION_EMPRESA'
];

/* RELACION_EMPRESA_BIOFILE_V69B_SHEETS */

export function extraerSpreadsheetId(urlOId) {
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

const sharedClients = new Map();
const headerCache = new Map();
export class SheetsApiClient {
  constructor({ credentialsPath, credentialsJson = '' }) {
    const key = crypto.createHash('sha256').update(String(credentialsPath || '') + credentialsJson).digest('hex');
    if (sharedClients.has(key)) return sharedClients.get(key);

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
    sharedClients.set(key, this);
  }

  async token() {
    if (this.tokenPending) return this.tokenPending;
    this.tokenPending = this.refreshToken();
    try { return await this.tokenPending; } finally { this.tokenPending = null; }
  }

  async refreshToken() {
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
    const key=spreadsheetId+':'+range;
    const cached=headerCache.get(key);
    if (/!A1:ZZ1$/.test(range) && cached && Date.now()-cached.at<30000) return structuredClone(cached.values);
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`);
    url.searchParams.set('majorDimension', 'ROWS');
    url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');
    url.searchParams.set('dateTimeRenderOption', 'SERIAL_NUMBER');
    const data = await this.request(url.toString());
    if (/!A1:ZZ1$/.test(range)) headerCache.set(key,{at:Date.now(),values:data.values||[]});
    return data.values || [];
  }

  async batchUpdateValues(spreadsheetId, data) {
    headerCache.clear();
    return this.request(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data })
    });
  }

  /* GRID_COLUMNS_AUTO_V5 */
  async ensureColumnCount(spreadsheetId, sheetName, requiredColumns) {
    const required = Number(requiredColumns || 0);
    if (!Number.isFinite(required) || required <= 0) return;

    const metadata = await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title,gridProperties(columnCount))`
    );

    const sheet = (metadata.sheets || []).find(
      (item) => String(item?.properties?.title || '') === String(sheetName || '')
    );

    if (!sheet?.properties) {
      throw new Error(`No se encontró la hoja "${sheetName}" para ampliar sus columnas.`);
    }

    const current = Number(sheet.properties.gridProperties?.columnCount || 0);
    if (current >= required) return;

    const length = required - current;
    await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({
          requests: [{
            appendDimension: {
              sheetId: sheet.properties.sheetId,
              dimension: 'COLUMNS',
              length
            }
          }]
        })
      }
    );
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

  async cargar({ fila = 0 } = {}) {
    if (Number(fila)>500000) throw new Error('Fila fuera del rango permitido.');
    this.exactRow = Number.isInteger(fila) && fila >= 2 ? fila : 0;
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
    const range = `${escaparHoja(this.hoja)}!A:ZZ`;
    if (this.exactRow) {
      const sheet = escaparHoja(this.hoja);
      const [headers, values] = await Promise.all([this.api.getValues(this.spreadsheetId, `${sheet}!A1:ZZ1`), this.api.getValues(this.spreadsheetId, `${sheet}!A${this.exactRow}:ZZ${this.exactRow}`)]);
      this.rows = []; this.rows[0] = headers[0] || []; this.rows[this.exactRow - 1] = values[0] || [];
    } else this.rows = await this.api.getValues(this.spreadsheetId, range);
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
    const ultimaColumnaNecesaria = inicio + faltantes.length - 1;

    // Google Sheets no permite escribir, por ejemplo, AS1 si la hoja física
    // solo llega hasta AR. Ampliamos primero la cuadrícula y luego agregamos
    // las columnas de control. Esto evita el error "Range exceeds grid limits".
    await this.api.ensureColumnCount(
      this.spreadsheetId,
      this.hoja,
      ultimaColumnaNecesaria
    );

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

  #getPrimero(rowNumber, nombres = []) {
    for (const nombre of nombres) {
      const valor = this.#get(rowNumber, nombre);
      if (valor) return valor;
    }
    return '';
  }

  #filaPorDocumento(documento) {
    const buscado = documentoComoTexto(documento);
    if (!buscado) return 0;
    for (let row = this.rows.length; row >= 2; row -= 1) {
      if (documentoComoTexto(this.#getRaw(row, 'N° documento')) === buscado) return row;
    }
    return 0;
  }

  /* LISTADO_AUTENTICADO_V61 */
  listarRegistros({ busqueda = '' } = {}) {
    const encabezados = (this.rows[0] || []).map((v) => texto(v));
    const q = normalizar(busqueda);
    const registros = [];
    /* CORTE_HISTORICO_PENDIENTES_V62 */
    const corteHistorico = String(process.env.BIOFILE_LISTADO_DESDE || '2026-08-13').trim();

    const fechaSolo = (valor) => {
      const s = String(valor ?? '').trim();
      if (!s) return '';
      let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
      m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      return '';
    };

    const valorListado = (valor, encabezado) => {
      if (valor === null || valor === undefined) return '';
      if (typeof valor === 'number' && normalizar(encabezado).includes('FECHA')) {
        /* FECHA_LOCAL_COLOMBIA_V63 */
        const ms = Date.UTC(1899, 11, 30) + Math.round(Number(valor) * 86400000);
        const d = new Date(ms);
        if (!Number.isNaN(d.getTime())) {
          const p = (n) => String(n).padStart(2, '0');
          const yyyy = d.getUTCFullYear();
          const mm = p(d.getUTCMonth() + 1);
          const dd = p(d.getUTCDate());
          const hh = p(d.getUTCHours());
          const mi = p(d.getUTCMinutes());
          const ss = p(d.getUTCSeconds());
          return yyyy + '-' + mm + '-' + dd + 'T' + hh + ':' + mi + ':' + ss + '-05:00';
        }
      }
      return texto(valor);
    };

    // Más recientes primero. Esto alinea el listado con la operación diaria y
    // evita que una cédula repetida seleccione silenciosamente una visita antigua.
    for (let row = this.rows.length; row >= 2; row -= 1) {
      const valores = this.rows[row - 1] || [];
      const registro = { _FILA_SHEETS: row };
      for (let i = 0; i < encabezados.length; i += 1) {
        const encabezado = encabezados[i];
        if (!encabezado) continue;
        registro[encabezado] = valorListado(valores[i], encabezado);
      }
      if (!texto(registro['N° documento'])) continue;
      const estadoListado = normalizar(registro['ESTADO_BIOFILE']);
      const fechaListado = fechaSolo(registro['Fecha de registro']);
      /* HISTORICO_INGRESADOS_BACKEND_V75 */
      if (!estadoListado && corteHistorico && fechaListado && fechaListado < corteHistorico) {
        // Estos registros existían antes de activar la trazabilidad ESTADO_BIOFILE.
        // Se devuelven al panel como históricos sin modificar Google Sheets y sin
        // mezclarlos con la cola operativa de pendientes actuales.
        registro['ESTADO_BIOFILE'] = 'HISTORICO';
        if (!texto(registro['MODO_INGRESO_BIOFILE'])) registro['MODO_INGRESO_BIOFILE'] = 'HISTORICO';
        registro['_HISTORICO_BIOFILE'] = true;
      }

      if (q) {
        const bolsa = normalizar(Object.values(registro).join(' '));
        if (!bolsa.includes(q)) continue;
      }
      registros.push(registro);
    }
    return registros;
  }

  obtenerPendientes({ max = Infinity, documento = '', fila = 0 } = {}) {
    const registros = [];
    const documentoBuscado = documentoComoTexto(documento);
    const filaBuscada = Number(fila || 0);

    for (let row = this.rows.length; row >= 2; row -= 1) {
      const numeroDocumento = documentoComoTexto(this.#getRaw(row, 'N° documento'));
      if (!numeroDocumento) continue;
      if (filaBuscada && row !== filaBuscada) continue;
      if (documentoBuscado && numeroDocumento !== documentoBuscado) continue;

      const estado = normalizar(this.#get(row, 'ESTADO_BIOFILE'));
      if (estado && !['PENDIENTE', 'ERROR', 'INTERRUMPIDO'].includes(estado)) continue;

      // Los ERROR históricos son potencialmente inseguros: antes de v6 un guardado
      // exitoso podía quedar marcado como ERROR. Solo se reintenta un ERROR cuando
      // v6 dejó constancia explícita de que nunca se intentó Guardar.
      if (['ERROR','INTERRUMPIDO'].includes(estado)) {
        const guardarIntentado = normalizar(this.#get(row, 'GUARDADO_INTENTADO_BIOFILE'));
        if (guardarIntentado !== 'NO') continue;
      }

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
        acuerdoComercialExcel: this.#getPrimero(row, [
          'Acuerdo comercial',
          'Acuerdo Comercial',
          'Nombre del Acuerdo Comercial, Contrato o Convenio',
          'ACUERDO_COMERCIAL'
        ]),
        empresaMisionExcel: this.#getPrimero(row, [
          'Empresa en misión',
          'Empresa en Misión',
          'Nombre de la Empresa en Misión',
          'EMPRESA_MISION'
        ]),
        empresaExcel: this.#getPrimero(row, [
          'Empresa en misión',
          'Empresa en Misión',
          'Nombre de la Empresa en Misión',
          'EMPRESA_MISION'
        ]),
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

  async marcarProcesando(row, usuario = '', jobId = '') {
    const actual = Number(this.#getRaw(row, 'INTENTOS_BIOFILE') || 0);
    await this.#actualizar(row, {
      ESTADO_BIOFILE: 'PROCESANDO',
      INTENTOS_BIOFILE: actual + 1,
      ERROR_BIOFILE: '',
      USUARIO_BIOFILE: usuario || this.#get(row, 'USUARIO_BIOFILE'),
      MODO_INGRESO_BIOFILE: 'AUTOMATICO',
      FECHA_BIOFILE_ISO: fechaIsoBogota(),
      JOB_ID_BIOFILE: jobId || this.#get(row, 'JOB_ID_BIOFILE'),
      SOLICITADO_POR_BIOFILE: usuario || this.#get(row, 'SOLICITADO_POR_BIOFILE'),
      GUARDADO_INTENTADO_BIOFILE: 'NO',
      GUARDADO_CONFIRMADO_BIOFILE: '',
      ULTIMA_ETAPA_BIOFILE: 'PREPARANDO',
      SESION_BIOFILE_USUARIO: ''
    });
  }

  async marcarSesionVerificada(row, usuario = '', jobId = '') {
    await this.#actualizar(row, {
      JOB_ID_BIOFILE: jobId || this.#get(row, 'JOB_ID_BIOFILE'),
      SESION_BIOFILE_USUARIO: usuario,
      ULTIMA_ETAPA_BIOFILE: 'SESION_VERIFICADA'
    });
  }

  async marcarGuardando(row, usuario = '', jobId = '') {
    await this.#actualizar(row, {
      ESTADO_BIOFILE: 'GUARDANDO',
      FECHA_BIOFILE_ISO: fechaIsoBogota(),
      JOB_ID_BIOFILE: jobId || this.#get(row, 'JOB_ID_BIOFILE'),
      USUARIO_BIOFILE: usuario || this.#get(row, 'USUARIO_BIOFILE'),
      GUARDADO_INTENTADO_BIOFILE: 'SI',
      ULTIMA_ETAPA_BIOFILE: 'GUARDAR_ENVIADO'
    });
  }

  async marcarOrdenCreada(row, numeroOrden, usuario = '', jobId = '') {
    await this.#actualizar(row, {
      ESTADO_BIOFILE: 'ORDEN_CREADA',
      NUMERO_OS_BIOFILE: numeroOrden || this.#get(row, 'NUMERO_OS_BIOFILE'),
      FECHA_BIOFILE: fechaHoraBogota(),
      FECHA_BIOFILE_ISO: fechaIsoBogota(),
      USUARIO_BIOFILE: usuario || this.#get(row, 'USUARIO_BIOFILE'),
      MODO_INGRESO_BIOFILE: 'AUTOMATICO',
      JOB_ID_BIOFILE: jobId || this.#get(row, 'JOB_ID_BIOFILE'),
      GUARDADO_INTENTADO_BIOFILE: 'SI',
      GUARDADO_CONFIRMADO_BIOFILE: 'SI',
      ULTIMA_ETAPA_BIOFILE: 'ORDEN_CREADA'
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
      MODO_INGRESO_BIOFILE: String(modo || 'AUTOMATICO').toUpperCase(),
      REGISTRADO_POR_BIOFILE: usuario || this.#get(row, 'REGISTRADO_POR_BIOFILE'),
      GUARDADO_CONFIRMADO_BIOFILE: normalizar(modo) === 'MANUAL' ? this.#get(row, 'GUARDADO_CONFIRMADO_BIOFILE') : 'SI',
      ULTIMA_ETAPA_BIOFILE: 'COMPLETADO'
    });
  }

  async marcarCompletadoManual(documento, usuarioResponsable = '', registradoPor = '') {
    const row = this.#filaPorDocumento(documento);
    if (!row) throw new Error('No se encontró ese documento en Google Sheets.');
    await this.marcarCompletado(row, this.#get(row, 'NUMERO_OS_BIOFILE'), usuarioResponsable, 'MANUAL');
    await this.#actualizar(row, { REGISTRADO_POR_BIOFILE: registradoPor || usuarioResponsable });
    return { row, usuarioResponsable, registradoPor: registradoPor || usuarioResponsable };
  }

  async marcarError(row, error, { parcial = false, numeroOrden = '', usuario = '', guardarIntentado = false, jobId = '' } = {}) {
    const estadoSeguro = parcial ? 'PARCIAL' : guardarIntentado ? 'REVISAR_BIOFILE' : 'ERROR';
    await this.#actualizar(row, {
      ESTADO_BIOFILE: estadoSeguro,
      NUMERO_OS_BIOFILE: numeroOrden || this.#get(row, 'NUMERO_OS_BIOFILE'),
      FECHA_BIOFILE: fechaHoraBogota(),
      FECHA_BIOFILE_ISO: fechaIsoBogota(),
      ERROR_BIOFILE: String(error?.message || error).slice(0, 5000),
      USUARIO_BIOFILE: usuario || this.#get(row, 'USUARIO_BIOFILE'),
      MODO_INGRESO_BIOFILE: 'AUTOMATICO',
      JOB_ID_BIOFILE: jobId || this.#get(row, 'JOB_ID_BIOFILE'),
      GUARDADO_INTENTADO_BIOFILE: guardarIntentado ? 'SI' : (this.#get(row, 'GUARDADO_INTENTADO_BIOFILE') || 'NO'),
      GUARDADO_CONFIRMADO_BIOFILE: parcial ? 'SI' : this.#get(row, 'GUARDADO_CONFIRMADO_BIOFILE'),
      ULTIMA_ETAPA_BIOFILE: estadoSeguro
    });
  }

  /* ELIMINADOS_RESTAURADO_V61 */
  async marcarEliminadoFila(row, actor = '', motivo = '') {
    const fila = Number(row || 0);
    if (!Number.isInteger(fila) || fila < 2 || fila > this.rows.length) throw new Error('Fila de Google Sheets no válida.');
    const estado = normalizar(this.#get(fila, 'ESTADO_BIOFILE'));
    if (estado === 'COMPLETADO') throw new Error('Un registro ya completado no se puede mover a Eliminados.');
    await this.#actualizar(fila, {
      ESTADO_BIOFILE: 'ELIMINADO',
      ELIMINADO_POR: actor,
      FECHA_ELIMINADO_ISO: fechaIsoBogota(),
      MOTIVO_ELIMINADO: String(motivo || '').slice(0, 1000),
      ULTIMA_ETAPA_BIOFILE: 'ELIMINADO'
    });
    return { row: fila, documento: this.#get(fila, 'N° documento'), eliminadoPor: actor, motivo: String(motivo || '') };
  }

  async marcarEliminado(documento, actor = '', motivo = '') {
    const row = this.#filaPorDocumento(documento);
    if (!row) throw new Error('No se encontró ese documento en Google Sheets.');
    return this.marcarEliminadoFila(row, actor, motivo);
  }

  async marcarCompletadoManualFila(row, usuarioResponsable = '', registradoPor = '') {
    const fila = Number(row || 0);
    if (!Number.isInteger(fila) || fila < 2 || fila > this.rows.length) throw new Error('Fila de Google Sheets no válida.');
    await this.marcarCompletado(fila, this.#get(fila, 'NUMERO_OS_BIOFILE'), usuarioResponsable, 'MANUAL');
    await this.#actualizar(fila, { REGISTRADO_POR_BIOFILE: registradoPor || usuarioResponsable });
    return { row: fila, usuarioResponsable, registradoPor: registradoPor || usuarioResponsable };
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
      if (estado === 'ELIMINADO') continue;
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
      else if (['ERROR', 'PARCIAL', 'REVISAR_BIOFILE'].includes(estado)) actual.errores += 1;
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

  datosFila(row) { return { headers: this.rows[0] || [], valores: this.rows[row - 1] || [] }; }
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
