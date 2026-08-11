import crypto from 'node:crypto';
import fs from 'node:fs';

const HEADERS_USUARIOS = [
  'ID', 'USUARIO', 'PASSWORD_HASH', 'PASSWORD_ENC', 'ROL', 'ACTIVO',
  'CREADO_POR', 'CREADO_EN', 'ACTUALIZADO_POR', 'ACTUALIZADO_EN'
];
const HEADERS_AUDITORIA = ['FECHA', 'ACTOR', 'ACCION', 'USUARIO_OBJETIVO', 'DETALLE'];

function normalizarUsuario(valor) {
  return String(valor || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();
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

function b64(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function desdeB64(valor) {
  return Buffer.from(String(valor || ''), 'base64url');
}

function ahoraIso() {
  return new Date().toISOString();
}

function rolGestionable(valor) {
  const rol = String(valor || '').trim().toLowerCase();
  if (!['user', 'admin'].includes(rol)) {
    throw new Error('El rol debe ser user o admin. Los superadmin solo se crean desde Render.');
  }
  return rol;
}

function activoDesdeValor(valor) {
  const v = String(valor ?? '').trim().toLowerCase();
  return !['false', '0', 'no', 'inactivo'].includes(v);
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
    return this.request(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      body: JSON.stringify({ range, majorDimension: 'ROWS', values })
    });
  }

  async append(spreadsheetId, range, values) {
    return this.request(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: JSON.stringify({ values })
    });
  }
}

export class UsuariosBiofileStore {
  constructor({ google, hojaUsuarios, hojaAuditoria, encryptionKey }) {
    this.google = google;
    this.spreadsheetId = extraerSpreadsheetId(google.urlOId);
    this.hojaUsuarios = hojaUsuarios;
    this.hojaAuditoria = hojaAuditoria;
    this.encryptionSecret = String(encryptionKey || '');
    this.client = new SheetsClient(google);
    this.inicializado = false;
  }

  disponible() {
    return this.encryptionSecret.length >= 32;
  }

  #claveCifrado() {
    if (!this.disponible()) {
      throw new Error('Falta BIOFILE_ENCRYPTION_KEY en Render o tiene menos de 32 caracteres.');
    }
    return crypto.createHash('sha256').update(this.encryptionSecret, 'utf8').digest();
  }

  #hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, 64);
    return `s1:${b64(salt)}:${b64(hash)}`;
  }

  #verificarPassword(password, almacenado) {
    try {
      const [version, saltB64, hashB64] = String(almacenado || '').split(':');
      if (version !== 's1') return false;
      const esperado = desdeB64(hashB64);
      const actual = crypto.scryptSync(String(password), desdeB64(saltB64), esperado.length);
      return actual.length === esperado.length && crypto.timingSafeEqual(actual, esperado);
    } catch {
      return false;
    }
  }

  #cifrarPassword(password) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.#claveCifrado(), iv);
    const ciphertext = Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${b64(iv)}:${b64(tag)}:${b64(ciphertext)}`;
  }

  #descifrarPassword(valor) {
    const [version, ivB64, tagB64, cipherB64] = String(valor || '').split(':');
    if (version !== 'v1') throw new Error('La contraseña cifrada tiene un formato no compatible.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.#claveCifrado(), desdeB64(ivB64));
    decipher.setAuthTag(desdeB64(tagB64));
    return Buffer.concat([decipher.update(desdeB64(cipherB64)), decipher.final()]).toString('utf8');
  }

  async inicializar() {
    if (this.inicializado) return;
    if (!this.disponible()) return;

    const meta = await this.client.metadata(this.spreadsheetId);
    const titulos = new Set((meta.sheets || []).map((s) => s?.properties?.title).filter(Boolean));
    for (const hoja of [this.hojaUsuarios, this.hojaAuditoria]) {
      if (!titulos.has(hoja)) {
        await this.client.crearHoja(this.spreadsheetId, hoja);
        titulos.add(hoja);
      }
    }

    await this.#asegurarHeaders(this.hojaUsuarios, HEADERS_USUARIOS);
    await this.#asegurarHeaders(this.hojaAuditoria, HEADERS_AUDITORIA);
    this.inicializado = true;
  }

  async #asegurarHeaders(hoja, headers) {
    const range = `${escaparHoja(hoja)}!A1:${String.fromCharCode(64 + headers.length)}1`;
    const actual = (await this.client.leer(this.spreadsheetId, range))[0] || [];
    const coincide = headers.every((h, i) => String(actual[i] || '') === h);
    if (!coincide) await this.client.escribir(this.spreadsheetId, range, [headers]);
  }

  async #filasUsuarios() {
    await this.inicializar();
    if (!this.disponible()) return [];
    const filas = await this.client.leer(this.spreadsheetId, `${escaparHoja(this.hojaUsuarios)}!A2:J`);
    return filas.map((r, i) => ({
      row: i + 2,
      id: String(r[0] || ''),
      usuario: String(r[1] || ''),
      passwordHash: String(r[2] || ''),
      passwordEnc: String(r[3] || ''),
      rol: String(r[4] || 'user').toLowerCase(),
      activo: activoDesdeValor(r[5]),
      creadoPor: String(r[6] || ''),
      creadoEn: String(r[7] || ''),
      actualizadoPor: String(r[8] || ''),
      actualizadoEn: String(r[9] || '')
    })).filter((u) => u.id && u.usuario);
  }

  #publico(u) {
    return {
      id: u.id,
      usuario: u.usuario,
      rol: u.rol,
      activo: u.activo,
      creadoPor: u.creadoPor,
      creadoEn: u.creadoEn,
      actualizadoPor: u.actualizadoPor,
      actualizadoEn: u.actualizadoEn,
      fuente: 'panel'
    };
  }

  async listar() {
    const filas = await this.#filasUsuarios();
    return filas.map((u) => this.#publico(u)).sort((a, b) => a.usuario.localeCompare(b.usuario, 'es'));
  }

  async autenticar(nombre, password) {
    const buscado = normalizarUsuario(nombre);
    const filas = await this.#filasUsuarios();
    const usuario = filas.find((u) => normalizarUsuario(u.usuario) === buscado);
    if (!usuario) return { estado: 'no_encontrado', usuario: null };
    if (!usuario.activo) return { estado: 'inactivo', usuario: this.#publico(usuario) };
    if (!this.#verificarPassword(password, usuario.passwordHash)) return { estado: 'incorrecto', usuario: null };

    return {
      estado: 'ok',
      usuario: {
        ...this.#publico(usuario),
        contrasena: this.#descifrarPassword(usuario.passwordEnc)
      }
    };
  }

  async crear({ usuario, contrasena, rol, actor }) {
    const nombre = String(usuario || '').trim();
    const password = String(contrasena || '');
    if (!nombre) throw new Error('El usuario BIOFILE es obligatorio.');
    if (!password) throw new Error('La contraseña BIOFILE es obligatoria.');
    const rolFinal = rolGestionable(rol);

    const filas = await this.#filasUsuarios();
    if (filas.some((u) => normalizarUsuario(u.usuario) === normalizarUsuario(nombre))) {
      throw new Error('Ya existe un usuario administrado con ese nombre.');
    }

    const id = crypto.randomUUID();
    const fecha = ahoraIso();
    const fila = [
      id, nombre, this.#hashPassword(password), this.#cifrarPassword(password), rolFinal, 'TRUE',
      actor, fecha, actor, fecha
    ];
    await this.client.append(this.spreadsheetId, `${escaparHoja(this.hojaUsuarios)}!A:J`, [fila]);
    await this.registrarAuditoria(actor, 'CREAR_USUARIO', nombre, `Rol: ${rolFinal}`);
    return this.#publico({
      row: 0, id, usuario: nombre, rol: rolFinal, activo: true,
      creadoPor: actor, creadoEn: fecha, actualizadoPor: actor, actualizadoEn: fecha
    });
  }

  async actualizar(id, cambios, actor) {
    const filas = await this.#filasUsuarios();
    const actual = filas.find((u) => u.id === id);
    if (!actual) throw new Error('Usuario administrado no encontrado.');

    const usuario = cambios.usuario === undefined ? actual.usuario : String(cambios.usuario || '').trim();
    if (!usuario) throw new Error('El usuario BIOFILE no puede quedar vacío.');
    if (filas.some((u) => u.id !== id && normalizarUsuario(u.usuario) === normalizarUsuario(usuario))) {
      throw new Error('Ya existe otro usuario con ese nombre.');
    }

    const rol = cambios.rol === undefined ? actual.rol : rolGestionable(cambios.rol);
    const activo = cambios.activo === undefined ? actual.activo : Boolean(cambios.activo);
    let passwordHash = actual.passwordHash;
    let passwordEnc = actual.passwordEnc;
    if (cambios.contrasena !== undefined && String(cambios.contrasena) !== '') {
      passwordHash = this.#hashPassword(cambios.contrasena);
      passwordEnc = this.#cifrarPassword(cambios.contrasena);
    }

    const fecha = ahoraIso();
    const fila = [
      actual.id, usuario, passwordHash, passwordEnc, rol, activo ? 'TRUE' : 'FALSE',
      actual.creadoPor, actual.creadoEn, actor, fecha
    ];
    await this.client.escribir(this.spreadsheetId, `${escaparHoja(this.hojaUsuarios)}!A${actual.row}:J${actual.row}`, [fila]);

    const cambiosAudit = [];
    if (usuario !== actual.usuario) cambiosAudit.push(`usuario: ${actual.usuario} -> ${usuario}`);
    if (rol !== actual.rol) cambiosAudit.push(`rol: ${actual.rol} -> ${rol}`);
    if (activo !== actual.activo) cambiosAudit.push(`estado: ${actual.activo ? 'activo' : 'inactivo'} -> ${activo ? 'activo' : 'inactivo'}`);
    if (cambios.contrasena) cambiosAudit.push('contraseña actualizada');
    await this.registrarAuditoria(actor, 'ACTUALIZAR_USUARIO', usuario, cambiosAudit.join(' | ') || 'Sin cambios visibles');

    return this.#publico({ ...actual, usuario, rol, activo, actualizadoPor: actor, actualizadoEn: fecha });
  }

  async registrarAuditoria(actor, accion, usuarioObjetivo, detalle = '') {
    if (!this.disponible()) return;
    await this.inicializar();
    await this.client.append(this.spreadsheetId, `${escaparHoja(this.hojaAuditoria)}!A:E`, [[
      ahoraIso(), String(actor || ''), String(accion || ''), String(usuarioObjetivo || ''), String(detalle || '')
    ]]);
  }

  async listarAuditoria(limit = 100) {
    await this.inicializar();
    if (!this.disponible()) return [];
    const filas = await this.client.leer(this.spreadsheetId, `${escaparHoja(this.hojaAuditoria)}!A2:E`);
    return filas.slice(-Math.max(1, Math.min(Number(limit) || 100, 500))).reverse().map((r) => ({
      fecha: String(r[0] || ''), actor: String(r[1] || ''), accion: String(r[2] || ''),
      usuarioObjetivo: String(r[3] || ''), detalle: String(r[4] || '')
    }));
  }
}

export { normalizarUsuario };
