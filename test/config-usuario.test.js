import assert from 'node:assert/strict';
import test from 'node:test';
import { crearConfigUsuario } from '../src/config-usuario.js';

const base = {
  biofile: {
    usuario: 'LEGACY',
    contrasena: 'legacy',
    ordenUrl: 'https://example.test/ordenes'
  },
  browser: {
    authPath: '/tmp/biofile/auth/biofile.json',
    timeout: 45_000
  }
};

test('crea credenciales y sesión de navegador independientes por usuario', () => {
  const uno = crearConfigUsuario(base, {
    credencialesBiofile: { usuario: 'USUARIO UNO', contrasena: 'clave uno' },
    sesionBiofileId: 'usuario-uno'
  });
  const dos = crearConfigUsuario(base, {
    credencialesBiofile: { usuario: 'USUARIO DOS', contrasena: 'clave dos' },
    sesionBiofileId: 'usuario-dos'
  });

  assert.equal(uno.biofile.usuario, 'USUARIO UNO');
  assert.equal(dos.biofile.usuario, 'USUARIO DOS');
  assert.notEqual(uno.browser.authPath, dos.browser.authPath);
  assert.match(uno.browser.authPath, /^\/tmp\/biofile\/auth\/biofile-[a-f0-9]{16}\.json$/);
});

test('no modifica la configuración global y conserva el modo heredado', () => {
  const legacy = crearConfigUsuario(base);

  assert.equal(legacy.biofile.usuario, 'LEGACY');
  assert.equal(legacy.browser.authPath, base.browser.authPath);
  assert.equal(base.biofile.usuario, 'LEGACY');
  assert.equal(base.browser.authPath, '/tmp/biofile/auth/biofile.json');
});
