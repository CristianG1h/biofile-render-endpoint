import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  convertirFilasARegistros,
  filtrarRegistros,
  listarRegistrosGoogleSheets
} from '../src/google-sheets.js';

const filas = [
  ['N° documento', 'Primer nombre', 'Primer apellido', 'Fecha de registro'],
  ['12345', 'Aura', 'Acuña', '08/08/2026 10:30'],
  [],
  ['67890', 'Luisa', 'Ríos', '08/08/2026 11:00']
];

test('convierte las filas conservando encabezados y número exacto de Sheets', () => {
  const registros = convertirFilasARegistros(filas);

  assert.equal(registros.length, 2);
  assert.deepEqual(registros[0], {
    __fila: 2,
    'N° documento': '12345',
    'Primer nombre': 'Aura',
    'Primer apellido': 'Acuña',
    'Fecha de registro': '08/08/2026 10:30'
  });
  assert.equal(registros[1].__fila, 4);
});

test('busca sin depender de mayúsculas ni tildes', () => {
  const registros = convertirFilasARegistros(filas);

  assert.deepEqual(filtrarRegistros(registros, 'acuna').map((r) => r.__fila), [2]);
  assert.deepEqual(filtrarRegistros(registros, '67890').map((r) => r.__fila), [4]);
  assert.equal(filtrarRegistros(registros, 'persona inexistente').length, 0);
});

test('una búsqueda vacía conserva todos los registros', () => {
  const registros = convertirFilasARegistros(filas);
  assert.equal(filtrarRegistros(registros, ''), registros);
});

test('reutiliza token y lectura de Google durante la caché corta', async (t) => {
  const fetchOriginal = globalThis.fetch;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  let solicitudesToken = 0;
  let solicitudesHoja = 0;

  globalThis.fetch = async (url, options = {}) => {
    const destino = String(url);
    if (destino === 'https://oauth2.googleapis.com/token') {
      solicitudesToken += 1;
      return new Response(JSON.stringify({ access_token: 'token-de-prueba', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (destino.startsWith('https://sheets.googleapis.com/v4/spreadsheets/')) {
      solicitudesHoja += 1;
      assert.equal(options.headers.authorization, 'Bearer token-de-prueba');
      assert.match(destino, /valueRenderOption=FORMATTED_VALUE/);
      return new Response(JSON.stringify({ values: filas }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    throw new Error(`Petición inesperada en la prueba: ${destino}`);
  };
  t.after(() => { globalThis.fetch = fetchOriginal; });

  const opciones = {
    urlOId: '12345678901234567890',
    hoja: 'Hoja 1',
    credentialsJson: JSON.stringify({
      client_email: 'cache-test@example.test',
      private_key: privateKeyPem
    }),
    cacheMs: 5_000
  };
  const todos = await listarRegistrosGoogleSheets(opciones);
  const filtrados = await listarRegistrosGoogleSheets({ ...opciones, busqueda: 'rios' });

  assert.equal(todos.length, 2);
  assert.deepEqual(filtrados.map((registro) => registro.__fila), [4]);
  assert.equal(solicitudesToken, 1);
  assert.equal(solicitudesHoja, 1);
});
