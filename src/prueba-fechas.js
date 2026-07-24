import assert from 'node:assert/strict';
import { convertirFechaBiofile } from './fecha.js';

assert.equal(convertirFechaBiofile(38001), '15/01/2004');
assert.equal(convertirFechaBiofile(35781), '17/12/1997');
assert.equal(convertirFechaBiofile('2004-01-15'), '15/01/2004');
assert.equal(convertirFechaBiofile('17/12/1997'), '17/12/1997');
console.log('Pruebas de fechas correctas.');
