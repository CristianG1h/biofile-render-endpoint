import { limpiarNombreArchivo } from './util.js';

export function extraerIdDrive(url) {
  const s = String(url || '');
  const patrones = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/
  ];
  for (const p of patrones) {
    const m = s.match(p);
    if (m) return m[1];
  }
  return '';
}

function detectarMime(buffer, contentType = '') {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  if (ct.startsWith('image/')) return ct;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return ct || 'application/octet-stream';
}

function extension(mime) {
  return ({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp'
  })[mime] || 'bin';
}

async function descargar(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!response.ok) throw new Error(`No se pudo descargar el archivo. HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const mimeType = detectarMime(buffer, response.headers.get('content-type') || '');
  if (mimeType.includes('html')) {
    throw new Error('Google Drive devolvió una página HTML. Verifica que el archivo permita acceso mediante el enlace.');
  }
  return { buffer, mimeType };
}

export async function descargarArchivoEnMemoria(url, prefijo = 'archivo') {
  if (!url) throw new Error(`No existe enlace para ${prefijo}.`);
  const id = extraerIdDrive(url);
  const urls = id
    ? [
        `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`,
        `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`
      ]
    : [url];

  let ultimoError;
  for (const destino of urls) {
    try {
      const { buffer, mimeType } = await descargar(destino);
      return {
        name: limpiarNombreArchivo(`${prefijo}-${id || Date.now()}.${extension(mimeType)}`),
        mimeType,
        buffer
      };
    } catch (error) {
      ultimoError = error;
    }
  }
  throw ultimoError || new Error(`No se pudo descargar ${prefijo}.`);
}
