import fs from 'node:fs';
import crypto from 'node:crypto';
import { configParaUsuario } from './config.js';
import { crearSesion } from './browser.js';

const HEADERS_EMPRESAS = [
  'CLAVE_EMPRESA',
  'ACUERDO_COMERCIAL',
  'NOMBRE_CLIENTE',
  'IDENTIFICACION',
  'FECHA_CREACION',
  'PRIMERA_DETECCION_ISO',
  'ULTIMA_DETECCION_ISO',
  'FUENTE',
  'ACTIVO'
];
const HEADERS_SYNC = [
  'ULTIMO_INTENTO_ISO',
  'ULTIMO_EXITO_ISO',
  'ESTADO',
  'TOTAL_EMPRESAS',
  'NUEVAS_ULTIMA',
  'FECHA_DESDE',
  'FECHA_HASTA',
  'DURACION_MS',
  'ERROR'
];
const CACHE_MS = 5 * 60 * 1000;
const CLIENTES_URL_DEFAULT = 'https://vipso.biofile.com.co/InformeGerencial/Clientes.aspx';
const FECHA_INICIAL_DEFAULT = '01/01/2000';

export function normalizarClaveEmpresa(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/&/g, ' Y ')
    .replace(/\bSOCIEDAD\s+POR\s+ACCIONES\s+SIMPLIFICADA\b/g, ' SAS ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function texto(valor) {
  return String(valor ?? '').replace(/\s+/g, ' ').trim();
}

function ahoraIso() {
  return new Date().toISOString();
}

function activoDesdeValor(valor) {
  const v = String(valor ?? '').trim().toLowerCase();
  return !['false', '0', 'no', 'inactivo', ''].includes(v);
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
    try { return JSON.parse(google.credentialsJson); }
    catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON no contiene un JSON válido.'); }
  }
  if (!google.credentialsPath || !fs.existsSync(google.credentialsPath)) {
    throw new Error(`No se encontró la credencial de Google: ${google.credentialsPath || '(ruta vacía)'}`);
  }
  return JSON.parse(fs.readFileSync(google.credentialsPath, 'utf8'));
}

class SheetsClient {
  constructor(google) {
    this.credentials = cargarCredenciales(google);
    this.accessToken = '';
    this.expiraEn = 0;
  }

  async token() {
    const ahora = Math.floor(Date.now() / 1000);
    if (this.accessToken && ahora < this.expiraEn - 60) return this.accessToken;
    const c = this.credentials;
    if (!c.client_email || !c.private_key) throw new Error('El JSON de Google no contiene client_email o private_key.');
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({
      iss: c.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: ahora,
      exp: ahora + 3600
    }));
    const unsigned = `${header}.${payload}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const assertion = `${unsigned}.${base64url(signer.sign(String(c.private_key).replace(/\\n/g, '\n')))}`;
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth2:grant-type:jwt-bearer', assertion })
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
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
    if (!response.ok) throw new Error(`Error de Google Sheets: ${data?.error?.message || raw || response.status}`);
    return data;
  }

  async metadata(id) {
    return this.request(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties`);
  }

  async crearHoja(id, title) {
    return this.request(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] })
    });
  }

  async leer(id, range) {
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}`);
    url.searchParams.set('majorDimension', 'ROWS');
    url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');
    const data = await this.request(url.toString());
    return data.values || [];
  }

  async escribir(id, range, values) {
    return this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      { method: 'PUT', body: JSON.stringify({ range, majorDimension: 'ROWS', values }) }
    );
  }
}

export class DirectorioEmpresasBiofileStore {
  constructor({
    google,
    hojaEmpresas = process.env.BIOFILE_CLIENTES_SHEET || 'DIRECTORIO_EMPRESAS_BIOFILE',
    hojaSync = process.env.BIOFILE_CLIENTES_SYNC_SHEET || 'SYNC_EMPRESAS_BIOFILE'
  }) {
    this.spreadsheetId = extraerSpreadsheetId(google.urlOId);
    this.hojaEmpresas = hojaEmpresas;
    this.hojaSync = hojaSync;
    this.client = new SheetsClient(google);
    this.inicializado = false;
    this.cache = null;
    this.colaEscritura = Promise.resolve();
  }

  async inicializar() {
    if (this.inicializado) return;
    const meta = await this.client.metadata(this.spreadsheetId);
    const titulos = new Set((meta.sheets || []).map((s) => s?.properties?.title).filter(Boolean));
    for (const hoja of [this.hojaEmpresas, this.hojaSync]) {
      if (!titulos.has(hoja)) {
        await this.client.crearHoja(this.spreadsheetId, hoja);
        titulos.add(hoja);
      }
    }
    await this.#asegurarHeaders(this.hojaEmpresas, HEADERS_EMPRESAS);
    await this.#asegurarHeaders(this.hojaSync, HEADERS_SYNC);
    this.inicializado = true;
  }

  async #asegurarHeaders(hoja, headers) {
    const ultima = String.fromCharCode(64 + headers.length);
    const range = `${escaparHoja(hoja)}!A1:${ultima}1`;
    const actual = (await this.client.leer(this.spreadsheetId, range))[0] || [];
    if (!headers.every((h, i) => String(actual[i] || '') === h)) {
      await this.client.escribir(this.spreadsheetId, range, [headers]);
    }
  }

  async #leerEmpresasForzado() {
    await this.inicializar();
    const rows = await this.client.leer(this.spreadsheetId, `${escaparHoja(this.hojaEmpresas)}!A2:I`);
    const items = rows.map((r) => ({
      clave: texto(r[0]),
      acuerdo: texto(r[1]),
      cliente: texto(r[2]),
      identificacion: texto(r[3]),
      fechaCreacion: texto(r[4]),
      primeraDeteccionIso: texto(r[5]),
      ultimaDeteccionIso: texto(r[6]),
      fuente: texto(r[7]),
      activo: activoDesdeValor(r[8])
    })).filter((x) => x.clave && x.acuerdo);
    this.cache = { cargadoEn: Date.now(), items };
    return items;
  }

  async listar() {
    if (this.cache && Date.now() - this.cache.cargadoEn < CACHE_MS) return this.cache.items;
    return this.#leerEmpresasForzado();
  }

  async obtenerEstado() {
    await this.inicializar();
    const rows = await this.client.leer(this.spreadsheetId, `${escaparHoja(this.hojaSync)}!A2:I2`);
    const r = rows[0] || [];
    const items = await this.listar();
    const nuevas = [...items]
      .sort((a, b) => String(b.primeraDeteccionIso).localeCompare(String(a.primeraDeteccionIso)))
      .slice(0, 12)
      .map((x) => ({ acuerdo: x.acuerdo, cliente: x.cliente, primeraDeteccionIso: x.primeraDeteccionIso }));
    return {
      ultimoIntentoIso: texto(r[0]),
      ultimoExitoIso: texto(r[1]),
      estado: texto(r[2]) || 'PENDIENTE',
      totalEmpresas: Number(r[3] || items.length || 0),
      nuevasUltima: Number(r[4] || 0),
      fechaDesde: texto(r[5]),
      fechaHasta: texto(r[6]),
      duracionMs: Number(r[7] || 0),
      error: texto(r[8]),
      recientes: nuevas
    };
  }

  async buscar(q = '', limit = 12) {
    const items = (await this.listar()).filter((x) => x.activo !== false);
    const consulta = normalizarClaveEmpresa(q);
    const max = Math.max(1, Math.min(50, Number(limit) || 12));
    if (!consulta) {
      return items.slice(0, max).map((x) => ({ acuerdo: x.acuerdo, cliente: x.cliente }));
    }
    const compacta = consulta.replace(/\s+/g, '');
    const puntuados = [];
    for (const x of items) {
      const a = normalizarClaveEmpresa(x.acuerdo);
      const c = normalizarClaveEmpresa(x.cliente);
      const ac = a.replace(/\s+/g, '');
      const cc = c.replace(/\s+/g, '');
      let score = 0;
      if (a === consulta || c === consulta) score = 10000;
      else if (ac === compacta || cc === compacta) score = 9800;
      else if (a.startsWith(consulta) || c.startsWith(consulta)) score = 8500;
      else if (ac.startsWith(compacta) || cc.startsWith(compacta)) score = 8200;
      else if (a.includes(consulta) || c.includes(consulta)) score = 6500;
      else if (ac.includes(compacta) || cc.includes(compacta)) score = 6200;
      else {
        const tokens = consulta.split(' ').filter((t) => t.length >= 2);
        const universo = `${a} ${c}`;
        const hits = tokens.filter((t) => universo.includes(t)).length;
        if (hits) score = 3000 + Math.round(2500 * hits / Math.max(1, tokens.length));
      }
      if (score) puntuados.push({ x, score });
    }
    return puntuados
      .sort((a, b) => b.score - a.score || a.x.acuerdo.localeCompare(b.x.acuerdo, 'es'))
      .slice(0, max)
      .map(({ x }) => ({ acuerdo: x.acuerdo, cliente: x.cliente }));
  }

  async guardarSincronizacion(clientes, { fechaDesde, fechaHasta, duracionMs = 0 } = {}) {
    const tarea = async () => {
      await this.inicializar();
      const existentes = await this.#leerEmpresasForzado();
      const mapa = new Map(existentes.map((x) => [x.clave, { ...x }]));
      const detectadasIso = ahoraIso();
      let nuevas = 0;

      for (const raw of clientes || []) {
        const acuerdo = texto(raw.acuerdo || raw.nombreAcuerdo || raw.cliente);
        const clave = normalizarClaveEmpresa(acuerdo);
        if (!clave || acuerdo.length < 2) continue;
        const previa = mapa.get(clave);
        if (!previa) nuevas += 1;
        mapa.set(clave, {
          clave,
          acuerdo,
          cliente: texto(raw.cliente) || previa?.cliente || '',
          identificacion: texto(raw.identificacion) || previa?.identificacion || '',
          fechaCreacion: texto(raw.fechaCreacion) || previa?.fechaCreacion || '',
          primeraDeteccionIso: previa?.primeraDeteccionIso || detectadasIso,
          ultimaDeteccionIso: detectadasIso,
          fuente: 'BIOFILE_CLIENTES',
          activo: true
        });
      }

      const items = [...mapa.values()].sort((a, b) => a.acuerdo.localeCompare(b.acuerdo, 'es', { sensitivity: 'base' }));
      const values = [HEADERS_EMPRESAS, ...items.map((x) => [
        x.clave, x.acuerdo, x.cliente, x.identificacion, x.fechaCreacion,
        x.primeraDeteccionIso, x.ultimaDeteccionIso, x.fuente || 'BIOFILE_CLIENTES', x.activo !== false ? 'TRUE' : 'FALSE'
      ])];
      await this.client.escribir(this.spreadsheetId, `${escaparHoja(this.hojaEmpresas)}!A1:I${values.length}`, values);

      const meta = [
        ahoraIso(), detectadasIso, 'OK', items.length, nuevas,
        texto(fechaDesde), texto(fechaHasta), Number(duracionMs || 0), ''
      ];
      await this.client.escribir(this.spreadsheetId, `${escaparHoja(this.hojaSync)}!A1:I2`, [HEADERS_SYNC, meta]);
      this.cache = { cargadoEn: Date.now(), items };
      return { totalEmpresas: items.length, nuevas, ultimoExitoIso: detectadasIso };
    };
    this.colaEscritura = this.colaEscritura.catch(() => {}).then(tarea);
    return this.colaEscritura;
  }

  async guardarError(error, { fechaDesde = '', fechaHasta = '', duracionMs = 0 } = {}) {
    const tarea = async () => {
      await this.inicializar();
      const anterior = await this.obtenerEstado().catch(() => ({ totalEmpresas: 0, ultimoExitoIso: '' }));
      const meta = [
        ahoraIso(), anterior.ultimoExitoIso || '', 'ERROR', anterior.totalEmpresas || 0, 0,
        texto(fechaDesde), texto(fechaHasta), Number(duracionMs || 0), texto(error?.message || error)
      ];
      await this.client.escribir(this.spreadsheetId, `${escaparHoja(this.hojaSync)}!A1:I2`, [HEADERS_SYNC, meta]);
    };
    this.colaEscritura = this.colaEscritura.catch(() => {}).then(tarea);
    return this.colaEscritura;
  }
}

function fechaBogota(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function isoADdMmYyyy(iso) {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : '';
}

function restarDiasIso(iso, dias) {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  const date = new Date(Date.UTC(y, m - 1, d - Number(dias || 0), 12, 0, 0));
  return date.toISOString().slice(0, 10);
}

export function rangoSincronizacionEmpresas(estado = {}, { completo = false } = {}) {
  const hoy = fechaBogota();
  const inicial = String(process.env.BIOFILE_CLIENTES_FECHA_INICIAL || FECHA_INICIAL_DEFAULT).trim();
  if (completo || !estado.ultimoExitoIso) {
    return { desde: inicial, hasta: isoADdMmYyyy(hoy), completo: true };
  }
  const ultima = String(estado.ultimoExitoIso).slice(0, 10);
  const solapeDias = Math.max(1, Math.min(7, Number(process.env.BIOFILE_CLIENTES_SOLAPE_DIAS || 2)));
  return {
    desde: isoADdMmYyyy(restarDiasIso(ultima, solapeDias)),
    hasta: isoADdMmYyyy(hoy),
    completo: false
  };
}

async function visible(locator) {
  try { return (await locator.count()) > 0 && await locator.first().isVisible(); }
  catch { return false; }
}

async function llenarFechas(page, desde, hasta) {
  const selectores = [
    'input[placeholder*="dd/mm" i]',
    'input[placeholder*="aaaa" i]',
    'input[type="text"]'
  ];
  let candidatos = [];
  for (const sel of selectores) {
    const loc = page.locator(sel);
    const n = Math.min(await loc.count(), 40);
    const visibles = [];
    for (let i = 0; i < n; i += 1) {
      const x = loc.nth(i);
      if (await x.isVisible().catch(() => false)) visibles.push(x);
    }
    if (visibles.length >= 2) {
      const conPlaceholderFecha = [];
      for (const x of visibles) {
        const ph = await x.getAttribute('placeholder').catch(() => '');
        if (/dd\/mm|aaaa|fecha/i.test(String(ph || ''))) conPlaceholderFecha.push(x);
      }
      candidatos = conPlaceholderFecha.length >= 2 ? conPlaceholderFecha : visibles;
      if (candidatos.length >= 2) break;
    }
  }
  if (candidatos.length < 2) throw new Error('No se encontraron los campos Fecha Creación Desde/Hasta en Clientes de BIOFILE.');
  await candidatos[0].fill(desde);
  await candidatos[1].fill(hasta);
}

async function pulsarBuscar(page) {
  const candidatos = [
    page.getByRole('button', { name: /buscar/i }),
    page.locator('button:has-text("Buscar")'),
    page.locator('input[type="submit"][value*="Buscar" i]'),
    page.locator('[title*="Buscar" i]'),
    page.locator('a:has-text("Buscar")')
  ];
  for (const loc of candidatos) {
    if (await visible(loc)) {
      await loc.first().click();
      return;
    }
  }
  const img = page.locator('img[alt*="Buscar" i], img[title*="Buscar" i]').first();
  if (await visible(img)) {
    await img.click();
    return;
  }
  throw new Error('No se encontró el botón Buscar en Clientes de BIOFILE.');
}

function normalizarHeader(valor) {
  return normalizarClaveEmpresa(valor);
}

function indiceHeader(headers, patrones) {
  return headers.findIndex((h) => patrones.some((p) => p.test(h)));
}

export function filasTablaAClientes(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  let headerIndex = -1;
  let indices = null;
  for (let i = 0; i < Math.min(rows.length, 8); i += 1) {
    const headers = (rows[i] || []).map(normalizarHeader);
    const acuerdo = indiceHeader(headers, [/ACUERDO.*COMERCIAL/, /CONTRATO.*CONVENIO/, /ACUERDO/]);
    const identificacion = indiceHeader(headers, [/IDENTIFICACION/, /NIT/]);
    const cliente = indiceHeader(headers, [/NOMBRE.*CLIENTE/, /^CLIENTE$/]);
    const fecha = indiceHeader(headers, [/FECHA.*CREACION/, /CREACION/]);
    if (acuerdo >= 0 && (cliente >= 0 || identificacion >= 0)) {
      headerIndex = i;
      indices = { acuerdo, identificacion, cliente, fecha };
      break;
    }
  }
  if (headerIndex < 0 || !indices) return [];
  const out = [];
  for (const cells of rows.slice(headerIndex + 1)) {
    if (!Array.isArray(cells) || !cells.length) continue;
    const acuerdo = texto(cells[indices.acuerdo]);
    if (!acuerdo || normalizarClaveEmpresa(acuerdo).includes('TOTAL')) continue;
    out.push({
      acuerdo,
      identificacion: indices.identificacion >= 0 ? texto(cells[indices.identificacion]) : '',
      cliente: indices.cliente >= 0 ? texto(cells[indices.cliente]) : '',
      fechaCreacion: indices.fecha >= 0 ? texto(cells[indices.fecha]) : ''
    });
  }
  return out;
}

async function extraerTablasFrame(frame) {
  const tablas = frame.locator('table');
  const n = Math.min(await tablas.count().catch(() => 0), 30);
  const encontrados = [];
  for (let i = 0; i < n; i += 1) {
    const tabla = tablas.nth(i);
    if (!await tabla.isVisible().catch(() => false)) continue;
    const rows = await tabla.locator('tr').evaluateAll((trs) => trs.map((tr) =>
      Array.from(tr.querySelectorAll('th,td')).map((td) => (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim())
    )).catch(() => []);
    const clientes = filasTablaAClientes(rows);
    if (clientes.length) encontrados.push(...clientes);
  }
  return encontrados;
}

async function extraerClientesPagina(page) {
  const out = [];
  for (const frame of page.frames()) {
    out.push(...await extraerTablasFrame(frame));
  }
  const mapa = new Map();
  for (const x of out) {
    const k = normalizarClaveEmpresa(x.acuerdo);
    if (k && !mapa.has(k)) mapa.set(k, x);
  }
  return [...mapa.values()];
}

async function botonSiguiente(page) {
  const candidatos = [];
  for (const frame of page.frames()) {
    candidatos.push(
      frame.locator('[title*="Siguiente" i]:visible'),
      frame.locator('a:has-text("Siguiente"):visible'),
      frame.locator('button:has-text("Siguiente"):visible'),
      frame.locator('.ui-pg-button:has(.ui-icon-seek-next):visible'),
      frame.locator('a[aria-label*="Next" i]:visible,button[aria-label*="Next" i]:visible')
    );
  }
  for (const loc of candidatos) {
    if (!await visible(loc)) continue;
    const x = loc.first();
    const disabled = await x.getAttribute('disabled').catch(() => null);
    const ariaDisabled = await x.getAttribute('aria-disabled').catch(() => null);
    const cls = await x.getAttribute('class').catch(() => '');
    if (disabled !== null || ariaDisabled === 'true' || /disabled|ui-state-disabled/i.test(String(cls || ''))) continue;
    return x;
  }
  return null;
}

async function extraerTodasLasPaginas(page) {
  const mapa = new Map();
  let firmaAnterior = '';
  const maxPaginas = Math.max(1, Math.min(500, Number(process.env.BIOFILE_CLIENTES_MAX_PAGINAS || 250)));
  for (let pagina = 1; pagina <= maxPaginas; pagina += 1) {
    await page.waitForTimeout(pagina === 1 ? 1800 : 900);
    const items = await extraerClientesPagina(page);
    for (const x of items) {
      const k = normalizarClaveEmpresa(x.acuerdo);
      if (!k) continue;
      const previa = mapa.get(k) || {};
      mapa.set(k, {
        acuerdo: x.acuerdo || previa.acuerdo || '',
        cliente: x.cliente || previa.cliente || '',
        identificacion: x.identificacion || previa.identificacion || '',
        fechaCreacion: x.fechaCreacion || previa.fechaCreacion || ''
      });
    }
    const firma = items.slice(0, 5).map((x) => normalizarClaveEmpresa(x.acuerdo)).join('|');
    if (pagina > 1 && firma && firma === firmaAnterior) break;
    firmaAnterior = firma;
    const siguiente = await botonSiguiente(page);
    if (!siguiente) break;
    await siguiente.click().catch(() => {});
  }
  return [...mapa.values()];
}

export async function sincronizarEmpresasDesdeBiofile({ usuario, store, completo = false } = {}) {
  if (!usuario?.usuario || !usuario?.contrasena) throw new Error('No hay credenciales BIOFILE disponibles para sincronizar empresas.');
  if (!store) throw new Error('No se recibió el directorio interno de empresas.');

  const inicio = Date.now();
  const estado = await store.obtenerEstado().catch(() => ({}));
  const rango = rangoSincronizacionEmpresas(estado, { completo });
  const cfg = configParaUsuario(usuario);
  const clientesUrl = String(process.env.BIOFILE_CLIENTES_URL || CLIENTES_URL_DEFAULT).trim();
  const logger = {
    info: (m) => console.log('[CLIENTES]', m),
    warn: (m) => console.warn('[CLIENTES]', m)
  };
  let sesion;
  try {
    sesion = await crearSesion(cfg, logger);
    await sesion.asegurarLogin();
    const { page } = sesion;
    await page.goto(clientesUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    if (/IniciarSesion/i.test(page.url())) {
      await sesion.asegurarLogin();
      await page.goto(clientesUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
    }
    await llenarFechas(page, rango.desde, rango.hasta);
    await pulsarBuscar(page);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    const clientes = await extraerTodasLasPaginas(page);
    if (!clientes.length) {
      throw new Error(`BIOFILE no devolvió empresas entre ${rango.desde} y ${rango.hasta}. Se canceló la actualización para no reemplazar el directorio con un resultado vacío.`);
    }
    const resultado = await store.guardarSincronizacion(clientes, {
      fechaDesde: rango.desde,
      fechaHasta: rango.hasta,
      duracionMs: Date.now() - inicio
    });
    return {
      ok: true,
      ...resultado,
      encontradasEnBiofile: clientes.length,
      fechaDesde: rango.desde,
      fechaHasta: rango.hasta,
      completo: rango.completo,
      duracionMs: Date.now() - inicio
    };
  } catch (error) {
    await store.guardarError(error, {
      fechaDesde: rango.desde,
      fechaHasta: rango.hasta,
      duracionMs: Date.now() - inicio
    }).catch(() => {});
    if (sesion?.page) {
      await sesion.page.screenshot({ path: `${cfg.paths.screenshots}/sync-clientes-error.png`, fullPage: true }).catch(() => {});
    }
    throw error;
  } finally {
    await sesion?.browser?.close().catch(() => {});
  }
}
