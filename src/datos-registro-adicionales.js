import crypto from 'node:crypto';
import fs from 'node:fs';
import { normalizar, texto } from './util.js';

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

async function obtenerTokenGoogle(google) {
  const credentials = cargarCredenciales(google);
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('El JSON de Google no contiene client_email o private_key.');
  }

  const ahora = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
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

  return data.access_token;
}

async function leerRango({ spreadsheetId, range, token }) {
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`
  );
  url.searchParams.set('majorDimension', 'ROWS');
  url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');
  url.searchParams.set('dateTimeRenderOption', 'SERIAL_NUMBER');

  const response = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${token}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Error de Google Sheets: ${data?.error?.message || response.status}`);
  }
  return data.values?.[0] || [];
}

function valorPorEncabezado(headers, fila, nombres) {
  for (const nombre of nombres) {
    const indice = headers.findIndex((header) => normalizar(header) === normalizar(nombre));
    if (indice >= 0) {
      const valor = texto(fila[indice]);
      if (valor) return valor;
    }
  }
  return '';
}

function valorPorPalabras(headers, fila, palabras, excluidas = []) {
  const requeridas = palabras.map(normalizar);
  const prohibidas = excluidas.map(normalizar);
  const indice = headers.findIndex((header) => {
    const encabezado = normalizar(header);
    return requeridas.every((palabra) => encabezado.includes(palabra))
      && prohibidas.every((palabra) => !encabezado.includes(palabra));
  });
  return indice >= 0 ? texto(fila[indice]) : '';
}

/**
 * Lee campos nuevos y opcionales sin cambiar la clase BaseGoogleSheets existente.
 * Así el despliegue sigue siendo compatible con hojas antiguas que todavía no
 * tengan Localidad, Municipio residencia, EPS, AFP o ARL. También acepta
 * la localidad guardada en la columna Zona para conservar el receptor antiguo.
 */
export async function obtenerDatosRegistroAdicionales({ google, row, logger }) {
  const fila = Number(row || 0);
  if (!Number.isInteger(fila) || fila < 2) return {};

  try {
    const spreadsheetId = extraerSpreadsheetId(google.urlOId);
    const token = await obtenerTokenGoogle(google);
    const hoja = escaparHoja(google.hoja);

    const [headers, valores] = await Promise.all([
      leerRango({ spreadsheetId, range: `${hoja}!A1:ZZ1`, token }),
      leerRango({ spreadsheetId, range: `${hoja}!A${fila}:ZZ${fila}`, token })
    ]);

    const localidadExplicita = valorPorEncabezado(headers, valores, [
      'Localidad',
      'Localidad Bogotá',
      'Localidad Bogota',
      'Localidad de Bogotá',
      'Localidad de Bogota',
      'Localidad de residencia',
      'Localidad donde vive'
    ]) || valorPorPalabras(headers, valores, ['LOCALIDAD'], ['NACIMIENTO']);

    // El receptor antiguo ya conoce la propiedad "zona". Para no reemplazarlo
    // ni perder sus correos, el formulario guarda la localidad en la columna
    // Zona. Solo se interpreta como localidad cuando el valor no es URBANA/RURAL.
    const valorZona = valorPorEncabezado(headers, valores, ['Zona']);
    const zonaNormalizada = normalizar(valorZona);
    const localidadDesdeZona = ['URBANA', 'RURAL'].includes(zonaNormalizada)
      ? ''
      : valorZona;

    const localidad = localidadExplicita || localidadDesdeZona;

    const resultado = {
      localidad,
      municipioResidencia: valorPorEncabezado(headers, valores, [
        'Municipio residencia',
        'Municipio o ciudad donde vive',
        'Municipio donde vive'
      ]),
      eps: valorPorEncabezado(headers, valores, ['EPS', 'Eps']),
      afp: valorPorEncabezado(headers, valores, [
        'AFP',
        'Afp',
        'Fondo de pensiones (AFP)',
        'Fondo de pensiones'
      ]),
      arl: valorPorEncabezado(headers, valores, ['ARL', 'Arl'])
    };

    logger?.info('Datos adicionales leídos desde Google Sheets.', {
      fila,
      localidad: resultado.localidad || 'vacía',
      municipioResidencia: resultado.municipioResidencia || 'vacío',
      eps: resultado.eps || 'NO REFIERE',
      afp: resultado.afp || 'NO REFIERE',
      arl: resultado.arl || 'NO REFIERE'
    });

    if (!resultado.localidad) {
      const encabezadosLocalidad = headers
        .filter((header) => normalizar(header).includes('LOCALIDAD'))
        .map((header) => String(header));
      logger?.warn('La fila no contiene una localidad. Se usará la predeterminada.', {
        fila,
        encabezadosLocalidad
      });
    }

    return resultado;
  } catch (error) {
    // Son columnas nuevas y opcionales. Una hoja antigua debe continuar funcionando.
    logger?.warn('No fue posible leer los campos nuevos; se usarán los valores anteriores.', {
      fila,
      detalle: error.message
    });
    return {};
  }
}
