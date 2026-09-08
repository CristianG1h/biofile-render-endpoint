import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizarClaveEmpresa, filasTablaAClientes, rangoSincronizacionEmpresas } from '../src/directorio-empresas-biofile.js';

assert.equal(normalizarClaveEmpresa('  Regina 11 S.A.S. '), 'REGINA 11 S A S');
assert.equal(normalizarClaveEmpresa('ACME & CIA'), 'ACME Y CIA');

const rows = [
  ['Nombre del Acuerdo Comercial, Contrato o Convenio', 'N°. de Identificación', 'Nombre del Cliente', 'Fecha Creación'],
  ['REGINA 11 SAS', '901234567', 'REGINA 11 SAS', '08/09/2026'],
  ['VIVIENDA TOTAL SAS', '900111222', 'VIVIENDA TOTAL SAS', '07/09/2026']
];
const clientes = filasTablaAClientes(rows);
assert.equal(clientes.length, 2);
assert.equal(clientes[0].acuerdo, 'REGINA 11 SAS');
assert.equal(clientes[1].identificacion, '900111222');

const full = rangoSincronizacionEmpresas({}, { completo: false });
assert.equal(full.completo, true);
assert.match(full.desde, /^\d{2}\/\d{2}\/\d{4}$/);
assert.match(full.hasta, /^\d{2}\/\d{2}\/\d{4}$/);

const incremental = rangoSincronizacionEmpresas({ ultimoExitoIso: '2026-09-08T12:00:00.000Z' }, { completo: false });
assert.equal(incremental.completo, false);
assert.equal(incremental.desde, '06/09/2026');

const directorioFuente = fs.readFileSync(new URL('../src/directorio-empresas-biofile.js', import.meta.url), 'utf8');
assert.match(directorioFuente, /BHEnabledBuscar/);
assert.match(directorioFuente, /BuscarDatosParaExcel/);
assert.match(directorioFuente, /Lista-de-Clientes/);

console.log('Directorio empresas BIOFILE v7.4: pruebas OK');
