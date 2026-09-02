import assert from 'node:assert/strict';
import {
  construirUrlMetodoAutocomplete,
  extraerOpcionesAutocomplete,
  limpiarOpcionesCatalogo,
  resolverOpcionUnica,
  textoBusquedaAutocomplete
} from '../src/autocomplete-biofile.js';

const respuestaReal = { d: [
  '{"First":"PAQUETE ADMINISTRATIVO","Second":"PAQUETE ADMINISTRATIVO"}',
  '{"First":"PAQUETE OPERATIVO","Second":"PAQUETE OPERATIVO"}'
] };
assert.deepEqual(extraerOpcionesAutocomplete(respuestaReal), [
  'PAQUETE ADMINISTRATIVO', 'PAQUETE OPERATIVO'
]);
assert.deepEqual(limpiarOpcionesCatalogo([
  'NO APLICA', ' PAQUETE ADMINISTRATIVO ', 'paquete administrativo', 'PAQUETE OPERATIVO'
]), ['PAQUETE ADMINISTRATIVO', 'PAQUETE OPERATIVO']);
assert.equal(construirUrlMetodoAutocomplete({
  paginaActual: 'https://vipso.biofile.com.co/Factura/OrdenesServiciosSaludOcupacional.aspx',
  servicePath: '', serviceMethod: 'Factura_OrdenesServiciosPaquetesAutocomplete'
}), 'https://vipso.biofile.com.co/Factura/OrdenesServiciosSaludOcupacional.aspx/Factura_OrdenesServiciosPaquetesAutocomplete');
assert.equal(textoBusquedaAutocomplete(
  'Tipo de Evaluación Médica o Procedimiento',
  'EVALUACIÓN MÉDICA OCUPACIONAL DE INGRESO'
), 'INGRES');
assert.equal(textoBusquedaAutocomplete(
  'Tipo de Evaluación Médica o Procedimiento',
  'EVALUACIÓN MÉDICA OCUPACIONAL PERIÓDICO'
), 'PERIOD');
assert.equal(textoBusquedaAutocomplete(
  'Tipo de Evaluación Médica o Procedimiento',
  'EVALUACIÓN MÉDICA OCUPACIONAL EGRESO'
), 'EGRES');
assert.equal(textoBusquedaAutocomplete(
  'Tipo de Evaluación Médica o Procedimiento',
  'EVALUACIÓN MÉDICA POST INCAPACIDAD'
), 'POST');
assert.equal(textoBusquedaAutocomplete(
  'Nombre del Acuerdo Comercial, Contrato o Convenio',
  'COMPAÑIA PRODUCTORA DE ENVASES METALICOS S A S'
), 'COMPAÑIA PRODUCTORA DE ENVASES METALICOS S A S');
assert.equal(resolverOpcionUnica([
  'COMPAÑIA PRODUCTORA DE ENVASES METALICOS S A S PROENMETAL S.A.S.'
], 'PROENMETAL'), 'COMPAÑIA PRODUCTORA DE ENVASES METALICOS S A S PROENMETAL S.A.S.');
assert.equal(resolverOpcionUnica([
  'PROENMETAL NORTE S.A.S.', 'PROENMETAL SUR S.A.S.'
], 'PROENMETAL'), '');
console.log('[BIOFILE] Pruebas de autocompletado y paquetes superadas.');
