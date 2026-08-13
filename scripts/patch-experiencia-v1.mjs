import fs from 'node:fs';

const procesarPath = new URL('../src/procesar-registro.js', import.meta.url);
const serverPath = new URL('../src/server.js', import.meta.url);

function asegurarImport(texto, importBase, importNuevo, archivo) {
  if (texto.includes(importNuevo)) return texto;
  if (!texto.includes(importBase)) throw new Error(`No se encontró import base en ${archivo}.`);
  return texto.replace(importBase, importBase + '\n' + importNuevo);
}

// ==================== AUTOMATICO ====================
let procesar = fs.readFileSync(procesarPath, 'utf8');
procesar = asegurarImport(
  procesar,
  "import { aplicarDatosRegistroBiofile } from './aplicar-datos-registro.js';",
  "import { notificarExperiencia } from './experiencia.js';",
  'procesar-registro.js'
);

if (!procesar.includes('/* EXPERIENCIA_AUTOMATICO_V1 */')) {
  const objetivo = "    await base.marcarCompletado(registro.row, numeroOrden, usuario.usuario, 'AUTOMATICO');\n\n    const resultado = {";
  if (!procesar.includes(objetivo)) throw new Error('No se encontró punto de completado automático.');

  const reemplazo = `    await base.marcarCompletado(registro.row, numeroOrden, usuario.usuario, 'AUTOMATICO');\n\n    /* EXPERIENCIA_AUTOMATICO_V1 */\n    const experiencia = await notificarExperiencia({\n      registro,\n      numeroOrden,\n      usuario: usuario.usuario,\n      modoIngreso: 'AUTOMATICO',\n      fechaIngresoBiofileIso: new Date().toISOString(),\n      logger\n    });\n\n    const resultado = {`;
  procesar = procesar.replace(objetivo, reemplazo);

  const campo = '      duracionSegundos: duracionSegundos(inicio)\n';
  if (!procesar.includes(campo)) throw new Error('No se encontró resultado automático para anexar experiencia.');
  procesar = procesar.replace(campo, '      duracionSegundos: duracionSegundos(inicio),\n      experiencia\n');
}

fs.writeFileSync(procesarPath, procesar, 'utf8');

// ==================== MANUAL ====================
let server = fs.readFileSync(serverPath, 'utf8');
server = asegurarImport(
  server,
  "import { procesarRegistroBiofile } from './procesar-registro.js';",
  "import { notificarExperiencia } from './experiencia.js';",
  'server.js'
);

if (!server.includes('/* EXPERIENCIA_MANUAL_V1 */')) {
  const objetivo = `    const base = await cargarBase();\n    const resultado = await base.marcarCompletadoManual(documento, usuario.usuario);\n    responderJson(req, res, 200, {\n      ok: true,\n      documento,\n      fila: resultado.row,\n      usuario: usuarioPublico(usuario),\n      modo: 'MANUAL'\n    });`;

  if (!server.includes(objetivo)) throw new Error('No se encontró endpoint manual esperado.');

  const reemplazo = `    const base = await cargarBase();\n    const [registroExperiencia] = base.obtenerPendientes({ max: 1, documento });\n    const fechaExperienciaIso = new Date().toISOString();\n    const resultado = await base.marcarCompletadoManual(documento, usuario.usuario);\n\n    /* EXPERIENCIA_MANUAL_V1 */\n    const experiencia = registroExperiencia\n      ? await notificarExperiencia({\n          registro: registroExperiencia,\n          numeroOrden: '',\n          usuario: usuario.usuario,\n          modoIngreso: 'MANUAL',\n          fechaIngresoBiofileIso: fechaExperienciaIso\n        })\n      : {\n          ok: false,\n          omitido: true,\n          motivo: 'No se encontró un registro PENDIENTE o con ERROR antes de marcar el ingreso manual.'\n        };\n\n    responderJson(req, res, 200, {\n      ok: true,\n      documento,\n      fila: resultado.row,\n      usuario: usuarioPublico(usuario),\n      modo: 'MANUAL',\n      experiencia\n    });`;

  server = server.replace(objetivo, reemplazo);
}

fs.writeFileSync(serverPath, server, 'utf8');
console.log('[PATCH] Integración de experiencia V1 aplicada.');
