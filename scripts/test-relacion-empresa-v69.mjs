import assert from 'node:assert/strict';
import { construirIndiceRelaciones, resolverRelacionEnIndice } from '../src/relacion-empresa.js';

const indice = construirIndiceRelaciones([
  ['TEMPORALES AVANZADOS SAS', 'RIVERPEZ INTERNATIONAL S.A.S'],
  ['GESTLAB S.A.S', 'GESTLAB S.A.S'],
  ['GESTLAB S.A.S', 'CANGURO INTERNATIONAL SAS'],
  ['HUMAN RESOURCES MANAGMENT SA', 'HUMAN RESOURCES MANAGMENT SA'],
  ['ACUERDO UNICO SAS', 'EMPRESA MISION UNICA SAS'],
  ['ACUERDO A SAS', 'MISION COMPARTIDA SAS'],
  ['ACUERDO B SAS', 'MISION COMPARTIDA SAS']
], {
  version: 'TEST',
  relations: 7,
  specialAliases: {
    RIVER: { principal: 'TEMPORALES AVANZADOS SAS', mision: 'RIVERPEZ INTERNATIONAL S.A.S' }
  }
});

assert.deepEqual(
  resolverRelacionEnIndice(indice, { empresa: 'RIVERPEZ INTERNATIONAL S.A.S' }),
  {
    acuerdo: 'TEMPORALES AVANZADOS SAS',
    empresaMision: 'RIVERPEZ INTERNATIONAL S.A.S',
    fuente: 'mision-exacta'
  }
);

assert.deepEqual(
  resolverRelacionEnIndice(indice, { acuerdo: 'GESTLAB S.A.S' }),
  {
    acuerdo: 'GESTLAB S.A.S',
    empresaMision: 'GESTLAB S.A.S',
    fuente: 'acuerdo-self'
  }
);

assert.deepEqual(
  resolverRelacionEnIndice(indice, { acuerdo: 'ACUERDO UNICO SAS' }),
  {
    acuerdo: 'ACUERDO UNICO SAS',
    empresaMision: 'EMPRESA MISION UNICA SAS',
    fuente: 'acuerdo-unica-mision'
  }
);

assert.deepEqual(
  resolverRelacionEnIndice(indice, {
    acuerdo: 'TEMPORALES AVANZADOS SAS',
    empresaMision: 'RIVERPEZ INTERNATIONAL S.A.S'
  }),
  {
    acuerdo: 'TEMPORALES AVANZADOS SAS',
    empresaMision: 'RIVERPEZ INTERNATIONAL S.A.S',
    fuente: 'par-explicito-validado'
  }
);

assert.equal(
  resolverRelacionEnIndice(indice, { empresa: 'MISION COMPARTIDA SAS' })?.ambiguo,
  true
);

assert.equal(
  resolverRelacionEnIndice(indice, { empresa: 'EMPRESA NUEVA NO CATALOGADA' }),
  null
);

console.log('[TEST] Relación empresarial v6.9 validada.');
