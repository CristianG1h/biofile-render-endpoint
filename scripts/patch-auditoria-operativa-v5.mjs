import fs from 'node:fs';

const serverPath = new URL('../src/server.js', import.meta.url);
let server = fs.readFileSync(serverPath, 'utf8');

if (!server.includes('/* AUDITORIA_OPERATIVA_V5 */')) {
  const manual = "      const resultado = await base.marcarCompletadoManual(documento, responsable, usuario.usuario);\n      responderJson(req, res, 200, {";
  if (!server.includes(manual)) throw new Error('No se encontró el ingreso manual v5 para agregar auditoría.');
  server = server.replace(
    manual,
    "      const resultado = await base.marcarCompletadoManual(documento, responsable, usuario.usuario);\n      /* AUDITORIA_OPERATIVA_V5 */\n      await usuariosStore.registrarAuditoria(usuario.usuario, 'INGRESO_MANUAL', documento, 'Atribuido a: ' + responsable).catch(() => {});\n      responderJson(req, res, 200, {"
  );

  const eliminado = "      const resultado = await base.marcarEliminado(documento, usuario.usuario, motivo);\n      responderJson(req, res, 200, { ok: true, ...resultado });";
  if (!server.includes(eliminado)) throw new Error('No se encontró el endpoint Eliminados v5 para agregar auditoría.');
  server = server.replace(
    eliminado,
    "      const resultado = await base.marcarEliminado(documento, usuario.usuario, motivo);\n      await usuariosStore.registrarAuditoria(usuario.usuario, 'ENVIAR_A_ELIMINADOS', documento, motivo || 'Sin motivo especificado').catch(() => {});\n      responderJson(req, res, 200, { ok: true, ...resultado });"
  );

  fs.writeFileSync(serverPath, server, 'utf8');
}

console.log('[BIOFILE] Auditoría operativa v5 habilitada.');
