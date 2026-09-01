import assert from 'node:assert/strict';
import {
  construirUrlMetodoAutocomplete,
  extraerOpcionesAutocomplete,
  limpiarOpcionesCatalogo
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
console.log('[BIOFILE] Pruebas de autocompletado y paquetes superadas.');
