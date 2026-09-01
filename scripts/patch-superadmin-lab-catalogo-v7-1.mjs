import fs from 'node:fs';

const serverPath = new URL('../src/server.js', import.meta.url);
let server = fs.readFileSync(serverPath, 'utf8');

if (server.includes('/* SUPERADMIN_LAB_CATALOGO_V71 */')) {
  console.log('[BIOFILE] Super Admin laboratorio de catálogo v7.1 ya instalado.');
  process.exit(0);
}

const anchor = "  if (url.pathname === '/api/superadmin/usuarios' && req.method === 'GET') {";
if (!server.includes(anchor)) {
  throw new Error('No se encontró el punto de inserción de Super Admin.');
}

const endpoints = [
  "  /* SUPERADMIN_LAB_CATALOGO_V71 */",
  "  if (req.method === 'GET' && url.pathname === '/api/superadmin/catalogo/actual') {",
  "    if (!requiereRol(usuario, ['superadmin'])) {",
  "      responderJson(req, res, 403, { ok: false, error: 'Solo un Super Admin puede usar el laboratorio BIOFILE.' });",
  "      return;",
  "    }",
  "",
  "    const empresa = String(url.searchParams.get('empresa') || '').trim();",
  "    if (empresa.length < 3) {",
  "      responderJson(req, res, 400, { ok: false, error: 'Indica una empresa válida.' });",
  "      return;",
  "    }",
  "",
  "    const catalogo = await catalogoStore.obtener(empresa);",
  "    responderJson(req, res, 200, { ok: true, empresa, catalogo, encontrado: Boolean(catalogo) });",
  "    return;",
  "  }",
  "",
  "  if (req.method === 'POST' && url.pathname === '/api/superadmin/catalogo/probar') {",
  "    if (!requiereRol(usuario, ['superadmin'])) {",
  "      responderJson(req, res, 403, { ok: false, error: 'Solo un Super Admin puede usar el laboratorio BIOFILE.' });",
  "      return;",
  "    }",
  "",
  "    const body = await leerJson(req);",
  "    const empresa = String(body.empresa || '').trim();",
  "    const guardar = body.guardar === true;",
  "    if (empresa.length < 3 || empresa.length > 180) {",
  "      responderJson(req, res, 400, { ok: false, error: 'Indica una empresa válida.' });",
  "      return;",
  "    }",
  "",
  "    const inicio = Date.now();",
  "    const previo = await catalogoStore.obtener(empresa).catch(() => null);",
  "    try {",
  "      const investigacion = await investigarPaquetesEmpresaBiofile({ empresa: previo?.acuerdoExacto || empresa, usuario });",
  "      let catalogoGuardado = previo;",
  "      if (guardar) {",
  "        catalogoGuardado = await catalogoStore.guardarInvestigacion({",
  "          empresaBuscada: empresa,",
  "          acuerdoExacto: investigacion.acuerdoExacto || empresa,",
  "          paquetes: investigacion.paquetes,",
  "          estado: 'OK',",
  "          error: ''",
  "        });",
  "      }",
  "      responderJson(req, res, 200, {",
  "        ok: true, empresa, guardar, duracionMs: Date.now() - inicio, previo, investigacion, catalogoGuardado",
  "      });",
  "    } catch (error) {",
  "      responderJson(req, res, 422, {",
  "        ok: false, empresa, guardar, duracionMs: Date.now() - inicio, error: error.message, previo,",
  "        detalleCatalogo: error.detalleCatalogo || null, detalleProductoServicio: error.detalleProductoServicio || null",
  "      });",
  "    }",
  "    return;",
  "  }",
  ""
].join('\n');

server = server.replace(anchor, endpoints + anchor);
fs.writeFileSync(serverPath, server, 'utf8');
console.log('[BIOFILE] v7.1: laboratorio Super Admin para probar catálogo BIOFILE habilitado.');
