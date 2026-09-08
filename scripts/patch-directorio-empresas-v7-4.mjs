import fs from 'node:fs';

const serverPath = new URL('../src/server.js', import.meta.url);
const directorioPath = new URL('../src/directorio-empresas-biofile.js', import.meta.url);
let server = fs.readFileSync(serverPath, 'utf8');
let directorio = fs.readFileSync(directorioPath, 'utf8');
const MARCA = 'DIRECTORIO_EMPRESAS_BIOFILE_V74';

// Mantener el módulo importable en pruebas sin exigir Playwright instalado,
// corregir OAuth y evitar confundir empresas cuyo nombre contiene "TOTAL"
// (por ejemplo VIVIENDA TOTAL SAS) con una fila de totales del informe.
directorio = directorio
  .replace("import { crearSesion } from './browser.js';\n", '')
  .replace("grant_type: 'urn:ietf:params:oauth2:grant-type:jwt-bearer'", "grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer'")
  .replace(
    "if (!acuerdo || normalizarClaveEmpresa(acuerdo).includes('TOTAL')) continue;",
    "if (!acuerdo || /^TOTAL(?: GENERAL)?(?:\\s|$)/.test(normalizarClaveEmpresa(acuerdo))) continue;"
  )
  .replace(
    '    sesion = await crearSesion(cfg, logger);',
    "    const { crearSesion } = await import('./browser.js');\n    sesion = await crearSesion(cfg, logger);"
  );

// BIOFILE no renderiza "Buscar" como <button>. En Clientes.aspx el control real
// es un <td class="BHEnabledBuscar" onclick="BuscarDatosParaExcel(...)"> con una
// imagen Buscar.png dentro. Se prioriza ese selector exacto y se conservan
// fallbacks por si BIOFILE cambia nuevamente el HTML.
const pulsarBuscarViejo = `async function pulsarBuscar(page) {
  const candidatos = [
    page.getByRole('button', { name: /buscar/i }),
    page.locator('button:has-text("Buscar")'),
    page.locator('input[type="submit"][value*="Buscar" i]'),
    page.locator('[title*="Buscar" i]'),
    page.locator('a:has-text("Buscar")')
  ];
  for (const loc of candidatos) {
    if (await visible(loc)) {
      await loc.first().click();
      return;
    }
  }
  const img = page.locator('img[alt*="Buscar" i], img[title*="Buscar" i]').first();
  if (await visible(img)) {
    await img.click();
    return;
  }
  throw new Error('No se encontró el botón Buscar en Clientes de BIOFILE.');
}`;

const pulsarBuscarNuevo = `async function pulsarBuscar(page) {
  const contextos = page.frames();
  for (const ctx of contextos) {
    const exactos = [
      ctx.locator('td.BHEnabledBuscar[onclick*="BuscarDatosParaExcel"][onclick*="Lista-de-Clientes"]'),
      ctx.locator('td[onclick*="BuscarDatosParaExcel"][onclick*="Lista-de-Clientes"]'),
      ctx.locator('td.BHEnabledBuscar[onclick*="BuscarDatosParaExcel"]'),
      ctx.locator('[onclick*="BuscarDatosParaExcel"]')
    ];
    for (const loc of exactos) {
      if (await visible(loc)) {
        await loc.first().click();
        return;
      }
    }
  }

  for (const ctx of contextos) {
    const candidatos = [
      ctx.getByRole('button', { name: /buscar/i }),
      ctx.locator('button:has-text("Buscar")'),
      ctx.locator('input[type="submit"][value*="Buscar" i]'),
      ctx.locator('[title*="Buscar" i]'),
      ctx.locator('a:has-text("Buscar")')
    ];
    for (const loc of candidatos) {
      if (await visible(loc)) {
        await loc.first().click();
        return;
      }
    }

    const img = ctx.locator('img[src*="Buscar.png" i], img[alt*="Buscar" i], img[title*="Buscar" i]').first();
    if (await visible(img)) {
      const padre = img.locator('xpath=..');
      if (await visible(padre)) await padre.click();
      else await img.click();
      return;
    }
  }
  throw new Error('No se encontró el control Buscar de Clientes de BIOFILE.');
}`;

if (directorio.includes(pulsarBuscarViejo)) {
  directorio = directorio.replace(pulsarBuscarViejo, pulsarBuscarNuevo);
}
fs.writeFileSync(directorioPath, directorio, 'utf8');

if (server.includes(`/* ${MARCA} */`)) {
  console.log('[Directorio] v7.4 ya instalado.');
  process.exit(0);
}
if (!server.includes('CATALOGO_PAQUETES_BIOFILE_V7_SERVER')) {
  throw new Error('Primero debe ejecutarse patch-catalogo-paquetes-v7.mjs.');
}

function reemplazarUna(texto, buscar, reemplazo, etiqueta) {
  if (!texto.includes(buscar)) throw new Error('No se encontró ' + etiqueta + '.');
  return texto.replace(buscar, reemplazo);
}

const importAnchor = "import { UsuariosBiofileStore, normalizarUsuario } from './usuarios-store.js';";
server = reemplazarUna(
  server,
  importAnchor,
  importAnchor + "\nimport { DirectorioEmpresasBiofileStore, sincronizarEmpresasDesdeBiofile } from './directorio-empresas-biofile.js';",
  'el import de usuarios'
);

const camposAnchor = 'const CAMPOS_EDITABLES = new Set([';
const soporte = `/* ${MARCA} */
const directorioEmpresasStore = new DirectorioEmpresasBiofileStore({ google: config.google });
let sincronizacionEmpresasActiva = null;
const DIRECTORIO_SYNC_INTERVAL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.BIOFILE_CLIENTES_SYNC_INTERVAL_MS || 24 * 60 * 60 * 1000)
);

function usuarioDirectorioEmpresas(preferido = null) {
  if (preferido?.usuario && preferido?.contrasena) return preferido;
  return typeof usuarioCatalogoAutomatico === 'function' ? usuarioCatalogoAutomatico() : (config.usuariosEntorno[0] || null);
}

async function directorioVencido() {
  const estado = await directorioEmpresasStore.obtenerEstado().catch(() => ({}));
  const ultimo = Date.parse(estado.ultimoExitoIso || '') || 0;
  return { estado, vencido: !ultimo || Date.now() - ultimo >= DIRECTORIO_SYNC_INTERVAL_MS };
}

function programarSincronizacionEmpresas({ force = false, completo = false, usuarioPreferido = null } = {}) {
  if (sincronizacionEmpresasActiva) return sincronizacionEmpresasActiva;
  sincronizacionEmpresasActiva = (async () => {
    const control = await directorioVencido();
    if (!force && !control.vencido) return { omitida: true, motivo: 'directorio_fresco', estado: control.estado };
    const usuario = usuarioDirectorioEmpresas(usuarioPreferido);
    if (!usuario) throw new Error('No hay un usuario BIOFILE disponible para actualizar el directorio de empresas.');
    const usarCompleto = completo || !control.estado?.ultimoExitoIso;
    console.log('[CLIENTES] Iniciando sincronización ' + (usarCompleto ? 'completa' : 'incremental') + '.');
    const resultado = await sincronizarEmpresasDesdeBiofile({ usuario, store: directorioEmpresasStore, completo: usarCompleto });
    console.log('[CLIENTES] Sincronización terminada:', resultado.totalEmpresas, 'empresas; nuevas:', resultado.nuevas);
    return resultado;
  })().finally(() => { sincronizacionEmpresasActiva = null; });
  return sincronizacionEmpresasActiva;
}

async function estadoDirectorioEmpresas() {
  const estado = await directorioEmpresasStore.obtenerEstado();
  return {
    ...estado,
    sincronizando: Boolean(sincronizacionEmpresasActiva),
    intervaloMs: DIRECTORIO_SYNC_INTERVAL_MS,
    proximaRevisionIso: estado.ultimoExitoIso
      ? new Date((Date.parse(estado.ultimoExitoIso) || Date.now()) + DIRECTORIO_SYNC_INTERVAL_MS).toISOString()
      : ''
  };
}

`;
server = reemplazarUna(server, camposAnchor, soporte + camposAnchor, 'CAMPOS_EDITABLES');

const loginAnchor = "  if (req.method === 'POST' && url.pathname === '/api/auth/login') {";
const publico = `  if (req.method === 'GET' && url.pathname === '/api/directorio/empresas') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const q = String(url.searchParams.get('q') || '').trim();
    const limit = Math.max(1, Math.min(25, Number(url.searchParams.get('limit') || 10)));
    const control = await directorioVencido().catch(() => ({ estado: {}, vencido: false }));
    if (control.vencido) programarSincronizacionEmpresas({ force: false }).catch((error) => console.warn('[CLIENTES] Actualización automática:', error.message));
    const empresas = await directorioEmpresasStore.buscar(q, limit);
    responderJson(req, res, 200, {
      ok: true,
      empresas,
      totalEmpresas: Number(control.estado?.totalEmpresas || 0),
      ultimoExitoIso: control.estado?.ultimoExitoIso || '',
      sincronizando: Boolean(sincronizacionEmpresasActiva)
    });
    return;
  }

`;
server = reemplazarUna(server, loginAnchor, publico + loginAnchor, 'el endpoint de login');

const logoutAnchor = "  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {\n    if (autenticacion.token) sesiones.delete(autenticacion.token);\n    responderJson(req, res, 200, { ok: true });\n    return;\n  }\n";
const privados = `

  if (req.method === 'GET' && url.pathname === '/api/superadmin/directorio/estado') {
    if (!requiereRol(usuario, ['superadmin'])) {
      responderJson(req, res, 403, { ok: false, error: 'Solo un superadministrador puede consultar el directorio de empresas.' });
      return;
    }
    responderJson(req, res, 200, { ok: true, directorio: await estadoDirectorioEmpresas() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/superadmin/directorio/sincronizar') {
    if (!requiereRol(usuario, ['superadmin'])) {
      responderJson(req, res, 403, { ok: false, error: 'Solo un superadministrador puede actualizar el directorio de empresas.' });
      return;
    }
    const body = await leerJson(req);
    if (!sincronizacionEmpresasActiva) {
      programarSincronizacionEmpresas({
        force: true,
        completo: body.completo === true,
        usuarioPreferido: usuario
      }).catch((error) => console.error('[CLIENTES] Sincronización manual:', error.message));
    }
    responderJson(req, res, 202, {
      ok: true,
      sincronizando: true,
      mensaje: body.completo === true
        ? 'Sincronización completa iniciada.'
        : 'Actualización de empresas iniciada.'
    });
    return;
  }
`;
server = reemplazarUna(server, logoutAnchor, logoutAnchor + privados, 'el endpoint logout');

const startupAnchor = 'if (usuariosStore.disponible()) {';
const startup = `directorioEmpresasStore.inicializar().then(() => {
  setTimeout(() => {
    programarSincronizacionEmpresas({ force: false }).catch((error) => console.error('[CLIENTES] Sincronización automática:', error.message));
  }, 15_000).unref?.();
}).catch((error) => {
  console.error('[CLIENTES] No fue posible preparar el directorio interno:', error.message);
});

const timerDirectorioEmpresas = setInterval(() => {
  programarSincronizacionEmpresas({ force: false }).catch((error) => console.error('[CLIENTES] Revisión periódica:', error.message));
}, 60 * 60 * 1000);
timerDirectorioEmpresas.unref?.();

`;
server = reemplazarUna(server, startupAnchor, startup + startupAnchor, 'la inicialización de usuarios');

if (!server.includes(MARCA) ||
    !server.includes('/api/directorio/empresas') ||
    !server.includes('/api/superadmin/directorio/estado') ||
    !server.includes('/api/superadmin/directorio/sincronizar') ||
    !server.includes('programarSincronizacionEmpresas')) {
  throw new Error('Directorio empresas v7.4 quedó incompleto.');
}

fs.writeFileSync(serverPath, server, 'utf8');
console.log('[Directorio] v7.4: sincronización diaria y manual de empresas BIOFILE habilitada.');
