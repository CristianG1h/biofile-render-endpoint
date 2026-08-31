import fs from 'node:fs';
import crypto from 'node:crypto';
import { normalizar } from './util.js';

export const TIPOS_EVALUACION_BIOFILE = Object.freeze([
  'EVALUACIÓN MÉDICA OCUPACIONAL DE INGRESO',
  'EVALUACIÓN MÉDICA OCUPACIONAL PERIÓDICO',
  'EVALUACIÓN MÉDICA OCUPACIONAL EGRESO',
  'EVALUACIÓN MÉDICA POST INCAPACIDAD'
]);

const HEADERS_EMPRESAS = [
  'CLAVE_EMPRESA',
  'EMPRESA_BUSCADA',
  'ACUERDO_EXACTO',
  'ULTIMA_REVISION_ISO',
  'PROXIMA_REVISION_ISO',
  'ESTADO',
  'ERROR'
];

const HEADERS_PAQUETES = [
  'CLAVE_EMPRESA',
  'PAQUETE',
  'TIPO_EVALUACION',
  'ACTIVO',
  'ACTUALIZADO_ISO'
];

const CACHE_LECTURA_MS = 60 * 1000;

export function claveEmpresaCatalogo(valor) {
  return normalizar(valor).replace(/\s+/g, ' ').trim();
}

export function normalizarTipoEvaluacion(valor) {
  const buscado = normalizar(valor);
  if (!buscado) return TIPOS_EVALUACION_BIOFILE[0];
  const exacto = TIPOS_EVALUACION_BIOFILE.find((tipo) => normalizar(tipo) === buscado);
  if (exacto) return exacto;

  if (/POST\s+INCAPACIDAD/.test(buscado)) return 'EVALUACIÓN MÉDICA POST INCAPACIDAD';
  if (/PERIODIC/.test(buscado)) return 'EVALUACIÓN MÉDICA OCUPACIONAL PERIÓDICO';
  if (/EGRES/.test(buscado)) return 'EVALUACIÓN MÉDICA OCUPACIONAL EGRESO';
  if (/INGRES/.test(buscado)) return 'EVALUACIÓN MÉDICA OCUPACIONAL DE INGRESO';

  return '';
}

export function esTipoEvaluacionPermitido(valor) {
  return Boolean(normalizarTipoEvaluacion(valor));
}

function extraerSpreadsheetId(urlOId) {
  const valor = String(urlOId || '').trim();
  const match = valor.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(valor)) return valor;
  throw new Error('GOOGLE_SHEETS_URL no contiene un ID válido de Google Sheets.');
}

function escaparHoja(nombre) {
  return `'${String(nombre).replace(/'/g, "''")}'`;
}

function base64url(valor) {
  return Buffer.from(valor)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function cargarCredenciales(google) {
  if (google.credentialsJson) {
    try {
      return JSON.parse(google.credentialsJson);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON no contiene un JSON válido.');
    }
  }
  if (!google.credentialsPath || !fs.existsSync(google.credentialsPath)) {
    throw new Error(`No se encontró la credencial de Google: ${google.credentialsPath || '(ruta vacía)'}`);
  }
  return JSON.parse(fs.readFileSync(google.credentialsPath, 'utf8'));
}

function activoDesdeValor(valor) {
  const v = String(valor ?? '').trim().toLowerCase();
  return !['false', '0', 'no', 'inactivo', ''].includes(v);
}

function ahoraIso() {
  return new Date().toISOString();
}

function siguienteRevisionIso(ttlMs) {
  return new Date(Date.now() + ttlMs).toISOString();
}

class SheetsClient {
  constructor(google) {
    this.google = google;
    this.credentials = cargarCredenciales(google);
    this.accessToken = '';
    this.expiraEn = 0;
  }

  async token() {
    const ahora = Math.floor(Date.now() / 1000);
    if (this.accessToken && ahora < this.expiraEn - 60) return this.accessToken;

    const credentials = this.credentials;
    if (!credentials.client_email || !credentials.private_key) {
      throw new Error('El JSON de Google no contiene client_email o private_key.');
    }

    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({
      iss: credentials.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: ahora,
      exp: ahora + 3600
    }));
    const unsigned = `${header}.${payload}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const privateKey = String(credentials.private_key).replace(/\\n/g, '\n');
    const assertion = `${unsigned}.${base64url(signer.sign(privateKey))}`;

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
    const texto = await response.text();
    let data = {};
    try { data = texto ? JSON.parse(texto) : {}; } catch { data = {}; }
    if (!response.ok) {
      throw new Error(`Error de Google Sheets: ${data?.error?.message || texto || response.status}`);
    }
    return data;
  }

  async metadata(spreadsheetId) {
    return this.request(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`);
  }

  async crearHoja(spreadsheetId, title) {
    return this.request(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] })
    });
  }

  async leer(spreadsheetId, range) {
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`);
    url.searchParams.set('majorDimension', 'ROWS');
    url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');
    const data = await this.request(url.toString());
    return data.values || [];
  }

  async escribir(spreadsheetId, range, values) {
    return this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        body: JSON.stringify({ range, majorDimension: 'ROWS', values })
      }
    );
  }

  async append(spreadsheetId, range, values) {
    return this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        body: JSON.stringify({ values })
      }
    );
  }
}

export class CatalogoPaquetesBiofileStore {
  constructor({
    google,
    hojaEmpresas = 'CATALOGO_EMPRESAS_BIOFILE',
    hojaPaquetes = 'CATALOGO_PAQUETES_BIOFILE',
    ttlMs = 24 * 60 * 60 * 1000
  }) {
    this.google = google;
    this.spreadsheetId = extraerSpreadsheetId(google.urlOId);
    this.hojaEmpresas = hojaEmpresas;
    this.hojaPaquetes = hojaPaquetes;
    this.ttlMs = Math.max(60 * 1000, Number(ttlMs) || 24 * 60 * 60 * 1000);
    this.client = new SheetsClient(google);
    this.inicializado = false;
    this.cache = new Map();
    this.colaEscritura = Promise.resolve();
  }

  async inicializar() {
    if (this.inicializado) return;

    const meta = await this.client.metadata(this.spreadsheetId);
    const titulos = new Set((meta.sheets || []).map((s) => s?.properties?.title).filter(Boolean));
    for (const hoja of [this.hojaEmpresas, this.hojaPaquetes]) {
      if (!titulos.has(hoja)) {
        await this.client.crearHoja(this.spreadsheetId, hoja);
        titulos.add(hoja);
      }
    }

    await this.#asegurarHeaders(this.hojaEmpresas, HEADERS_EMPRESAS);
    await this.#asegurarHeaders(this.hojaPaquetes, HEADERS_PAQUETES);
    this.inicializado = true;
  }

  async #asegurarHeaders(hoja, headers) {
    const ultima = String.fromCharCode(64 + headers.length);
    const range = `${escaparHoja(hoja)}!A1:${ultima}1`;
    const actual = (await this.client.leer(this.spreadsheetId, range))[0] || [];
    const coincide = headers.every((h, i) => String(actual[i] || '') === h);
    if (!coincide) await this.client.escribir(this.spreadsheetId, range, [headers]);
  }

  async #leerTodo() {
    await this.inicializar();
    const [empresasRaw, paquetesRaw] = await Promise.all([
      this.client.leer(this.spreadsheetId, `${escaparHoja(this.hojaEmpresas)}!A2:G`),
      this.client.leer(this.spreadsheetId, `${escaparHoja(this.hojaPaquetes)}!A2:E`)
    ]);

    const empresas = empresasRaw.map((r, i) => ({
      row: i + 2,
      clave: String(r[0] || ''),
      empresaBuscada: String(r[1] || ''),
      acuerdoExacto: String(r[2] || ''),
      ultimaRevisionIso: String(r[3] || ''),
      proximaRevisionIso: String(r[4] || ''),
      estado: String(r[5] || ''),
      error: String(r[6] || '')
    })).filter((x) => x.clave);

    const paquetes = paquetesRaw.map((r, i) => ({
      row: i + 2,
      clave: String(r[0] || ''),
      paquete: String(r[1] || ''),
      tipoEvaluacion: String(r[2] || ''),
      activo: activoDesdeValor(r[3]),
      actualizadoIso: String(r[4] || '')
    })).filter((x) => x.clave && x.paquete);

    return { empresas, paquetes };
  }

  #armarCatalogo(clave, empresas, paquetes) {
    const empresa = empresas.find((x) => x.clave === clave);
    if (!empresa) return null;
    const activos = paquetes
      .filter((x) => x.clave === clave && x.activo)
      .map((x) => ({
        nombre: x.paquete,
        tipoEvaluacion: normalizarTipoEvaluacion(x.tipoEvaluacion) || String(x.tipoEvaluacion || '')
      }))
      .filter((x) => x.nombre && x.tipoEvaluacion)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

    const revisada = Date.parse(empresa.ultimaRevisionIso || '') || 0;
    return {
      clave,
      empresaBuscada: empresa.empresaBuscada,
      acuerdoExacto: empresa.acuerdoExacto || empresa.empresaBuscada,
      ultimaRevisionIso: empresa.ultimaRevisionIso || '',
      proximaRevisionIso: empresa.proximaRevisionIso || '',
      estado: empresa.estado || '',
      error: empresa.error || '',
      fresca: normalizar(empresa.estado) === 'OK' && Boolean(revisada && Date.now() - revisada < this.ttlMs),
      paquetes: activos
    };
  }

  async obtener(empresa) {
    const clave = claveEmpresaCatalogo(empresa);
    if (!clave) return null;

    const cache = this.cache.get(clave);
    if (cache && Date.now() - cache.cargadoEn < CACHE_LECTURA_MS) return cache.catalogo;

    const { empresas, paquetes } = await this.#leerTodo();
    const empresaEncontrada = empresas.find((x) =>
      x.clave === clave ||
      claveEmpresaCatalogo(x.empresaBuscada) === clave ||
      claveEmpresaCatalogo(x.acuerdoExacto) === clave
    );
    const claveReal = empresaEncontrada?.clave || clave;
    const catalogo = this.#armarCatalogo(claveReal, empresas, paquetes);
    this.cache.set(clave, { cargadoEn: Date.now(), catalogo });
    if (claveReal !== clave) this.cache.set(claveReal, { cargadoEn: Date.now(), catalogo });
    return catalogo;
  }

  async obtenerPaquetes(empresa, tipoEvaluacion = '') {
    const catalogo = await this.obtener(empresa);
    if (!catalogo) return [];
    const tipo = normalizarTipoEvaluacion(tipoEvaluacion);
    if (!tipo) return catalogo.paquetes;
    return catalogo.paquetes.filter((p) => normalizar(p.tipoEvaluacion) === normalizar(tipo));
  }

  async validarPaquete(empresa, tipoEvaluacion, paquete) {
    const nombrePaquete = String(paquete || '').trim();
    if (!nombrePaquete || normalizar(nombrePaquete) === normalizar('NO APLICA')) {
      return { ok: true, paquete: 'NO APLICA', catalogo: await this.obtener(empresa) };
    }

    const tipo = normalizarTipoEvaluacion(tipoEvaluacion);
    if (!tipo) return { ok: false, error: 'Tipo de evaluación no permitido.' };

    const catalogo = await this.obtener(empresa);
    if (!catalogo) {
      return { ok: false, error: 'La empresa todavía no tiene catálogo de paquetes disponible.' };
    }

    const encontrado = catalogo.paquetes.find((p) =>
      normalizar(p.nombre) === normalizar(nombrePaquete) &&
      normalizar(p.tipoEvaluacion) === normalizar(tipo)
    );
    if (!encontrado) {
      return {
        ok: false,
        error: `El paquete "${nombrePaquete}" no está activo para ${tipo} en esta empresa.`
      };
    }
    return { ok: true, paquete: encontrado.nombre, catalogo };
  }

  async guardarInvestigacion({
    empresaBuscada,
    acuerdoExacto,
    paquetes = [],
    estado = 'OK',
    error = ''
  }) {
    const clave = claveEmpresaCatalogo(empresaBuscada || acuerdoExacto);
    if (!clave) throw new Error('No se puede guardar un catálogo sin empresa.');

    const tarea = async () => {
      const { empresas, paquetes: existentes } = await this.#leerTodo();
      const fecha = ahoraIso();
      const siguiente = siguienteRevisionIso(this.ttlMs);
      const empresaActual = empresas.find((x) => x.clave === clave);
      const filaEmpresa = [
        clave,
        String(empresaBuscada || acuerdoExacto || '').trim(),
        String(acuerdoExacto || empresaBuscada || '').trim(),
        fecha,
        siguiente,
        estado,
        String(error || '')
      ];

      if (empresaActual) {
        await this.client.escribir(
          this.spreadsheetId,
          `${escaparHoja(this.hojaEmpresas)}!A${empresaActual.row}:G${empresaActual.row}`,
          [filaEmpresa]
        );
      } else {
        await this.client.append(
          this.spreadsheetId,
          `${escaparHoja(this.hojaEmpresas)}!A:G`,
          [filaEmpresa]
        );
      }

      const normalizados = [];
      const vistos = new Set();
      for (const item of paquetes || []) {
        const nombre = String(item?.nombre || item?.paquete || '').trim();
        const tipo = normalizarTipoEvaluacion(item?.tipoEvaluacion || item?.tipo || '');
        if (!nombre || !tipo) continue;
        const id = `${normalizar(nombre)}|${normalizar(tipo)}`;
        if (vistos.has(id)) continue;
        vistos.add(id);
        normalizados.push({ nombre, tipo });
      }

      for (const anterior of existentes.filter((x) => x.clave === clave && x.activo)) {
        const sigue = normalizados.some((n) =>
          normalizar(n.nombre) === normalizar(anterior.paquete) &&
          normalizar(n.tipo) === normalizar(anterior.tipoEvaluacion)
        );
        if (!sigue) {
          await this.client.escribir(
            this.spreadsheetId,
            `${escaparHoja(this.hojaPaquetes)}!A${anterior.row}:E${anterior.row}`,
            [[clave, anterior.paquete, anterior.tipoEvaluacion, 'FALSE', fecha]]
          );
        }
      }

      for (const item of normalizados) {
        const actual = existentes.find((x) =>
          x.clave === clave &&
          normalizar(x.paquete) === normalizar(item.nombre) &&
          normalizar(x.tipoEvaluacion) === normalizar(item.tipo)
        );
        const fila = [clave, item.nombre, item.tipo, 'TRUE', fecha];
        if (actual) {
          await this.client.escribir(
            this.spreadsheetId,
            `${escaparHoja(this.hojaPaquetes)}!A${actual.row}:E${actual.row}`,
            [fila]
          );
        } else {
          await this.client.append(
            this.spreadsheetId,
            `${escaparHoja(this.hojaPaquetes)}!A:E`,
            [fila]
          );
        }
      }

      this.cache.clear();
      return this.obtener(empresaBuscada || acuerdoExacto);
    };

    this.colaEscritura = this.colaEscritura.catch(() => {}).then(tarea);
    return this.colaEscritura;
  }

  async guardarError(empresaBuscada, error) {
    const previo = await this.obtener(empresaBuscada).catch(() => null);
    return this.guardarInvestigacion({
      empresaBuscada,
      acuerdoExacto: previo?.acuerdoExacto || empresaBuscada,
      paquetes: previo?.paquetes || [],
      estado: 'ERROR',
      error: String(error?.message || error || '').slice(0, 500)
    });
  }
}
