import assert from 'node:assert/strict';
import test from 'node:test';
import { crearGestorAuth } from '../src/auth.js';

const usuarios = [
  {
    id: 'usuario-prueba',
    nombre: 'USUARIO PRUEBA',
    usuario: 'USUARIO PRUEBA',
    contrasena: 'Clave segura de prueba'
  }
];

function gestor() {
  return crearGestorAuth({
    usuarios,
    secreto: 'secreto-de-pruebas-con-mas-de-32-caracteres',
    ttlMs: 60 * 60 * 1000
  });
}

test('acepta el usuario sin depender de mayúsculas o tildes', () => {
  const usuario = gestor().validarCredenciales('usuario prueba', 'Clave segura de prueba');
  assert.equal(usuario?.id, 'usuario-prueba');
});

test('la contraseña continúa siendo sensible a mayúsculas', () => {
  assert.equal(gestor().validarCredenciales('USUARIO PRUEBA', 'clave segura de prueba'), null);
});

test('crea y valida un token sin incluir la contraseña', () => {
  const auth = gestor();
  const token = auth.crearToken(usuarios[0], 1_800_000_000_000);
  const usuario = auth.validarToken(token, 1_800_000_100_000);

  assert.equal(usuario?.id, 'usuario-prueba');
  assert.equal(token.includes(usuarios[0].contrasena), false);
});

test('rechaza tokens alterados o vencidos', () => {
  const auth = gestor();
  const ahora = 1_800_000_000_000;
  const token = auth.crearToken(usuarios[0], ahora);

  assert.equal(auth.validarToken(`${token}x`, ahora), null);
  assert.equal(auth.validarToken(token, ahora + 61 * 60 * 1000), null);
});

test('nunca expone la contraseña en el usuario público', () => {
  const publico = gestor().usuarioPublico(usuarios[0]);
  assert.deepEqual(publico, {
    id: 'usuario-prueba',
    nombre: 'USUARIO PRUEBA',
    usuario: 'USUARIO PRUEBA'
  });
  assert.equal('contrasena' in publico, false);
});

test('exige un secreto robusto cuando hay usuarios', () => {
  assert.throws(
    () => crearGestorAuth({ usuarios, secreto: 'corto' }),
    /por lo menos 32 caracteres/
  );
});

test('rechaza nombres de acceso que podrían abrir la cuenta equivocada', () => {
  assert.throws(
    () => crearGestorAuth({
      usuarios: [
        usuarios[0],
        {
          id: 'otro-id',
          nombre: 'OTRA PERSONA',
          usuario: 'usuario prueba',
          contrasena: 'otra clave'
        }
      ],
      secreto: 'secreto-de-pruebas-con-mas-de-32-caracteres'
    }),
    /nombre repetido/
  );
});
