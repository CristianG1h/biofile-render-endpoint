import crypto from 'node:crypto';
import { normalizar } from './util.js';

function base64url(valor) {
  return Buffer.from(valor)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function decodificarBase64url(valor) {
  const normalizado = String(valor || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const relleno = '='.repeat((4 - (normalizado.length % 4)) % 4);
  return Buffer.from(`${normalizado}${relleno}`, 'base64').toString('utf8');
}

function compararSeguro(a, b) {
  const aa = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function huellaCredencial(usuario) {
  return crypto
    .createHash('sha256')
    .update(`${usuario.usuario}\0${usuario.contrasena}`)
    .digest('hex')
    .slice(0, 20);
}

function usuarioPublico(usuario) {
  return {
    id: usuario.id,
    nombre: usuario.nombre,
    usuario: usuario.usuario
  };
}

export function crearGestorAuth({ usuarios = [], secreto = '', ttlMs = 12 * 60 * 60 * 1000 } = {}) {
  const lista = [...usuarios];
  const porId = new Map(lista.map((usuario) => [usuario.id, usuario]));
  const porLogin = new Map();

  for (const usuario of lista) {
    const claves = [usuario.id, usuario.usuario, usuario.nombre]
      .map(normalizar)
      .filter(Boolean);
    for (const clave of claves) {
      const existente = porLogin.get(clave);
      if (existente && existente.id !== usuario.id) {
        throw new Error(`El acceso multiusuario contiene un nombre repetido: ${clave}.`);
      }
      porLogin.set(clave, usuario);
    }
  }

  if (lista.length && String(secreto).length < 32) {
    throw new Error('SESSION_SECRET debe tener por lo menos 32 caracteres para activar el acceso multiusuario.');
  }

  const ttl = Math.max(60_000, Number(ttlMs) || 12 * 60 * 60 * 1000);

  function firmar(contenido) {
    return base64url(crypto.createHmac('sha256', secreto).update(contenido).digest());
  }

  function validarCredenciales(login, contrasena) {
    const usuario = porLogin.get(normalizar(login));
    if (!usuario || !compararSeguro(contrasena, usuario.contrasena)) return null;
    return usuario;
  }

  function crearToken(usuario, ahora = Date.now()) {
    const emitido = Math.floor(ahora / 1000);
    const payload = base64url(JSON.stringify({
      v: 1,
      sub: usuario.id,
      name: usuario.nombre,
      cv: huellaCredencial(usuario),
      iat: emitido,
      exp: Math.floor((ahora + ttl) / 1000)
    }));
    return `${payload}.${firmar(payload)}`;
  }

  function validarToken(token, ahora = Date.now()) {
    if (!lista.length || !secreto) return null;
    const [payload, firma, extra] = String(token || '').split('.');
    if (!payload || !firma || extra || !compararSeguro(firma, firmar(payload))) return null;

    try {
      const datos = JSON.parse(decodificarBase64url(payload));
      const usuario = porId.get(datos.sub);
      const ahoraSegundos = Math.floor(ahora / 1000);

      if (
        datos.v !== 1 ||
        !usuario ||
        !Number.isFinite(datos.iat) ||
        !Number.isFinite(datos.exp) ||
        datos.iat > ahoraSegundos + 60 ||
        datos.exp <= ahoraSegundos ||
        datos.cv !== huellaCredencial(usuario)
      ) {
        return null;
      }

      return usuario;
    } catch {
      return null;
    }
  }

  return {
    activo: lista.length > 0,
    cantidadUsuarios: lista.length,
    ttlMs: ttl,
    validarCredenciales,
    crearToken,
    validarToken,
    usuarioPublico
  };
}

export { compararSeguro, usuarioPublico };
