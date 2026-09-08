import assert from 'node:assert/strict';
import { construirIndiceRelaciones, resolverRelacionEnIndice } from '../src/relacion-empresa.js';

const indice = construirIndiceRelaciones([
  ['TEMPORALES AVANZADOS SAS', 'RIVERPEZ INTERNATIONAL S.A.S'],
  ['GESTLAB S.A.S', 'GESTLAB S.A.S'],
  ['GESTLAB S.A.S', 'CANGURO INTERNATIONAL SAS'],
  // Reproduce el dato real del catálogo V2.7: la misión tiene un error leve de digitación.
  ['HUMAN RESOURCES MANAGMENT SA', 'HUMAN RESOURCES MANAGMENDT SA'],
  ['ACUERDO UNICO SAS', 'EMPRESA MISION UNICA SAS'],
  ['ACUERDO A SAS', 'MISION COMPARTIDA SAS'],
  ['ACUERDO B SAS', 'MISION COMPARTIDA SAS'],
  // Caso real reportado desde el panel: REGINA 11 también aparece como misión
  // de otro acuerdo, pero su relación propia debe tener prioridad.
  ['REGINA 11 SAS', 'REGINA 11 SAS'],
  ['RIVERPEZ INTERNACIONAL S A S', 'REGINA 11 SAS']
], {
  version: 'TEST',
  relations: 9,
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
  resolverRelacionEnIndice(indice, { acuerdo: 'HUMAN RESOURCES MANAGMENT SA' }),
  {
    acuerdo: 'HUMAN RESOURCES MANAGMENT SA',
    empresaMision: 'HUMAN RESOURCES MANAGMENT SA',
    fuente: 'acuerdo-unica-mision-nombre-equivalente'
  }
);

assert.deepEqual(
  resolverRelacionEnIndice(indice, {
    acuerdo: 'HUMAN RESOURCES MANAGMENT SA',
    empresaMision: 'HUMAN RESOURCES MANAGMENT SA'
  }),
  {
    acuerdo: 'HUMAN RESOURCES MANAGMENT SA',
    empresaMision: 'HUMAN RESOURCES MANAGMENT SA',
    fuente: 'par-explicito-nombre-equivalente'
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

assert.deepEqual(
  resolverRelacionEnIndice(indice, {
    acuerdo: 'PARTICULARES',
    empresaMision: 'REGINA 11 SAS'
  }),
  {
    acuerdo: 'REGINA 11 SAS',
    empresaMision: 'REGINA 11 SAS',
    fuente: 'mision-recuperada-acuerdo-particulares'
  }
);

assert.deepEqual(
  resolverRelacionEnIndice(indice, {
    acuerdo: 'GESTLAB S.A.S',
    empresaMision: 'PARTICULARES'
  }),
  {
    acuerdo: 'GESTLAB S.A.S',
    empresaMision: 'GESTLAB S.A.S',
    fuente: 'acuerdo-recuperado-mision-particulares'
  }
);

assert.equal(
  resolverRelacionEnIndice(indice, {
    acuerdo: 'ACUERDO A SAS',
    empresaMision: 'EMPRESA MISION UNICA SAS'
  })?.ambiguo,
  true
);

assert.equal(
  resolverRelacionEnIndice(indice, { empresa: 'MISION COMPARTIDA SAS' })?.ambiguo,
  true
);

assert.equal(
  resolverRelacionEnIndice(indice, { empresa: 'EMPRESA NUEVA NO CATALOGADA' }),
  null
);

console.log('[TEST] Relación empresarial v7.3 validada, incluido PARTICULARES + misión real y HUMAN con typo equivalente.');
