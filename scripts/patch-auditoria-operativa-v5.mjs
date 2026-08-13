import fs from 'node:fs';

const serverPath = new URL('../src/server.js', import.meta.url);
let server = fs.readFileSync(serverPath, 'utf8');

const importBase = "import { procesarRegistroBiofile } from './procesar-registro.js';";
const importExperiencia = "import { notificarExperiencia } from './experiencia.js';";
if (!server.includes(importExperiencia)) {
  if (!server.includes(importBase)) throw new Error('No se encontró import de procesarRegistroBiofile.');
  server = server.replace(importBase, importBase + '\n' + importExperiencia);
}

if (!server.includes('/* EXPERIENCIA_MANUAL_V1 */')) {
  const manual = "      const responsable = await resolverUsuarioResponsable(usuario, body.usuarioResponsable);\n      const base = await cargarBase();\n      const resultado = await base.marcarCompletadoManual(documento, responsable, usuario.usuario);";
  if (!server.includes(manual)) throw new Error('No se encontró el ingreso manual v5 para agregar experiencia.');

  server = server.replace(
    manual,
    "      const responsable = await resolverUsuarioResponsable(usuario, body.usuarioResponsable);\n      const base = await cargarBase();\n      const [registroExperiencia] = base.obtenerPendientes({ max: 1, documento });\n      const fechaExperienciaIso = new Date().toISOString();\n      const resultado = await base.marcarCompletadoManual(documento, responsable, usuario.usuario);\n      /* AUDITORIA_OPERATIVA_V5 */\n      await usuariosStore.registrarAuditoria(usuario.usuario, 'INGRESO_MANUAL', documento, 'Atribuido a: ' + responsable).catch(() => {});\n      /* EXPERIENCIA_MANUAL_V1 */\n      const experiencia = registroExperiencia\n        ? await notificarExperiencia({\n            registro: registroExperiencia,\n            numeroOrden: '',\n            usuario: responsable,\n            modoIngreso: 'MANUAL',\n            fechaIngresoBiofileIso: fechaExperienciaIso\n          })\n        : { ok: false, omitido: true, motivo: 'No se encontró registro pendiente para programar la encuesta.' };"
  );

  const respuestaManual = "        registradoPor: usuario.usuario,\n        modo: 'MANUAL'\n      });";
  if (!server.includes(respuestaManual)) throw new Error('No se encontró respuesta del ingreso manual v5.');
  server = server.replace(
    respuestaManual,
    "        registradoPor: usuario.usuario,\n        modo: 'MANUAL',\n        experiencia\n      });"
  );
}

const eliminado = "      const resultado = await base.marcarEliminado(documento, usuario.usuario, motivo);\n      responderJson(req, res, 200, { ok: true, ...resultado });";
if (server.includes(eliminado)) {
  server = server.replace(
    eliminado,
    "      const resultado = await base.marcarEliminado(documento, usuario.usuario, motivo);\n      await usuariosStore.registrarAuditoria(usuario.usuario, 'ENVIAR_A_ELIMINADOS', documento, motivo || 'Sin motivo especificado').catch(() => {});\n      responderJson(req, res, 200, { ok: true, ...resultado });"
  );
}

fs.writeFileSync(serverPath, server, 'utf8');
console.log('[BIOFILE] Auditoría operativa y experiencia manual habilitadas.');
