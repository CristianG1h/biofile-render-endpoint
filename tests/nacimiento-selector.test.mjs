import test from 'node:test';
import assert from 'node:assert/strict';
import { coincideNacimiento, resolverNacimiento, separarCiudadNacimiento } from '../src/nacimiento-selector.js';

test('no confunde municipios por prefijo ni departamentos por subcadena',()=>{
  assert.equal(coincideNacimiento('SAN PEDRO DE URABA (ANTIOQUIA, COLOMBIA)','SAN PEDRO (ANTIOQUIA, COLOMBIA)'),false);
  assert.equal(coincideNacimiento('SAN PEDRO (NORTE DE SANTANDER, COLOMBIA)','SAN PEDRO (SANTANDER, COLOMBIA)'),false);
  assert.equal(coincideNacimiento('CARTAGO (COSTA RICA)','CARTAGO (VALLE DEL CAUCA, COLOMBIA)'),false);
  assert.equal(coincideNacimiento('MEDELLIN (ANTIOQUIA, COLOMBIA)','ABEJORRAL (ANTIOQUIA, COLOMBIA)'),false);
  assert.equal(coincideNacimiento('CARACAS (VENEZUELA)','MARACAIBO (VENEZUELA)'),false);
});
test('acepta solo equivalencias explícitas y alias del país en ambos sentidos',()=>{
  assert.ok(coincideNacimiento('BOGOTÁ (BOGOTÁ D.C., COLOMBIA)','BOGOTA D.C. (BOGOTA D.C., COLOMBIA)'));
  assert.ok(coincideNacimiento('UBATÉ (CUNDINAMARCA, COLOMBIA)','VILLA DE SAN DIEGO DE UBATE (CUNDINAMARCA, COLOMBIA)'));
  assert.ok(coincideNacimiento('MARACAIBO (VENEZUELA)','MARACAIBO (REPUBLICA BOLIVARIANA DE VENEZUELA)'));
  assert.ok(coincideNacimiento('MARACAIBO (REPUBLICA BOLIVARIANA DE VENEZUELA)','MARACAIBO (VENEZUELA)'));
});
test('registro antiguo sin departamento no elige entre homónimos',()=>{
  const opciones=['ARMENIA (QUINDÍO, COLOMBIA)','ARMENIA (ANTIOQUIA, COLOMBIA)'];
  assert.equal(resolverNacimiento(opciones,'ARMENIA'),'');
  assert.equal(resolverNacimiento(opciones,'ARMENIA (QUINDIO, COLOMBIA)'),opciones[0]);
});
test('departamento con comas y país libre se conservan',()=>{
  const v='PROVIDENCIA (ARCHIPIELAGO DE SAN ANDRES, PROVIDENCIA Y SANTA CATALINA, COLOMBIA)';
  assert.equal(separarCiudadNacimiento(v).departamento,'ARCHIPIELAGO DE SAN ANDRES, PROVIDENCIA Y SANTA CATALINA');
  assert.ok(coincideNacimiento(v,v));
  assert.ok(coincideNacimiento('CIUDAD INVENTADA (PAIS DE PRUEBA)','CIUDAD INVENTADA (PAIS DE PRUEBA)'));
  assert.equal(resolverNacimiento(['CIUDAD INVENTADA'],'CIUDAD INVENTADA (PAIS DE PRUEBA)'),'');
});
