import fs from 'node:fs';
import path from 'node:path';

export function normalizar(valor) {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toUpperCase();
}

export function texto(valor) {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'number') {
    return Number.isInteger(valor) ? String(valor) : String(valor);
  }
  if (valor instanceof Date) return valor;
  if (typeof valor === 'object') {
    if ('hyperlink' in valor && valor.hyperlink) return String(valor.hyperlink);
    if ('text' in valor && valor.text) return String(valor.text);
    if ('result' in valor && valor.result !== undefined) return texto(valor.result);
    if ('richText' in valor && Array.isArray(valor.richText)) {
      return valor.richText.map((x) => x.text ?? '').join('');
    }
  }
  return String(valor).trim();
}

export function booleano(valor, defecto = false) {
  if (valor === undefined || valor === null || valor === '') return defecto;
  return ['1', 'TRUE', 'SI', 'SÍ', 'YES', 'ON'].includes(normalizar(valor));
}

export function entero(valor, defecto) {
  const n = Number(valor);
  return Number.isFinite(n) ? Math.trunc(n) : defecto;
}

export function fechaArchivo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function asegurarDirectorio(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function leerJsonSiExiste(ruta, defecto = {}) {
  try {
    return JSON.parse(fs.readFileSync(ruta, 'utf8'));
  } catch {
    return defecto;
  }
}

export function rutaAbsoluta(ruta) {
  return path.isAbsolute(ruta) ? ruta : path.resolve(process.cwd(), ruta);
}

export function limpiarNombreArchivo(nombre) {
  return String(nombre).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
