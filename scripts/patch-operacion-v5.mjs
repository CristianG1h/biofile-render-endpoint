import fs from 'node:fs';

const biofilePath = new URL('../src/biofile.js', import.meta.url);
const sheetsPath = new URL('../src/google-sheets.js', import.meta.url);
const serverPath = new URL('../src/server.js', import.meta.url);

function reemplazarEntre(texto, inicio, fin, nuevo, etiqueta) {
  const a = texto.indexOf(inicio);
  const b = texto.indexOf(fin, a + inicio.length);
  if (a < 0 || b < 0) throw new Error('No se encontró ' + etiqueta + '.');
  return texto.slice(0, a) + nuevo + texto.slice(b);
}

// ==================== LUGARES DE NACIMIENTO ====================
let biofile = fs.readFileSync(biofilePath, 'utf8');
if (!biofile.includes('/* LUGARES_NACIMIENTO_V5 */')) {
  const importBase = "import { asegurarDirectorio, fechaArchivo, normalizar } from './util.js';";
  if (!biofile.includes(importBase)) throw new Error('No se encontró import util.js en biofile.js.');
  biofile = biofile.replace(
    importBase,
    importBase + "\nimport { capitalDepartamentoColombia, capitalPais, variantesPais, esColombia } from './lugares-nacimiento.js';"
  );

  const separador = String.raw`/* LUGARES_NACIMIENTO_V5 */
function separarCiudadNacimiento(valor) {
  const original = String(valor ?? '').trim().replace(/\s+/g, ' ');
  if (!original) return { original: '', municipio: '', departamento: '', pais: '', opcionEsperada: '' };

  // Acepta tanto MUNICIPIO (DEPARTAMENTO, PAIS) como CIUDAD (PAIS).
  const conParentesis = original.match(/^(.+?)\s*\(\s*([^)]+?)\s*\)$/);
  if (conParentesis) {
    let municipio = conParentesis[1].trim();
    const partes = conParentesis[2].split(',').map((x) => x.trim()).filter(Boolean);
    let departamento = '';
    let pais = '';
    if (partes.length >= 2) {
      pais = partes[partes.length - 1];
      departamento = partes.slice(0, -1).join(', ');
    } else {
      pais = partes[0] || '';
    }

    const m = normalizar(municipio);
    const d = normalizar(departamento);
    const p = normalizar(pais);
    if (['BOGOTA', 'BOGOTA D C'].includes(m) && d === 'BOGOTA D C' && p === 'COLOMBIA') {
      municipio = 'BOGOTÁ';
      departamento = 'BOGOTÁ D.C.';
      pais = 'COLOMBIA';
    }

    return {
      original,
      municipio,
      departamento,
      pais,
      opcionEsperada: departamento
        ? municipio + ' (' + departamento + ', ' + pais + ')'
        : municipio + ' (' + pais + ')'
    };
  }

  const departamentos = [
    'AMAZONAS', 'ANTIOQUIA', 'ARAUCA', 'ARCHIPIELAGO DE SAN ANDRES PROVIDENCIA Y SANTA CATALINA',
    'ATLANTICO', 'BOGOTA D C', 'BOLIVAR', 'BOYACA', 'CALDAS', 'CAQUETA', 'CASANARE', 'CAUCA',
    'CESAR', 'CHOCO', 'CORDOBA', 'CUNDINAMARCA', 'GUAINIA', 'GUAVIARE', 'HUILA', 'LA GUAJIRA',
    'MAGDALENA', 'META', 'NARINO', 'NORTE DE SANTANDER', 'PUTUMAYO', 'QUINDIO', 'RISARALDA',
    'SANTANDER', 'SUCRE', 'TOLIMA', 'VALLE DEL CAUCA', 'VAUPES', 'VICHADA'
  ].sort((a, b) => b.length - a.length);

  const n = normalizar(original);
  for (const dep of departamentos) {
    const sufijo = ' ' + dep;
    if (!n.endsWith(sufijo)) continue;
    const muni = n.slice(0, -sufijo.length).trim();
    if (muni) {
      return {
        original,
        municipio: muni,
        departamento: dep,
        pais: 'COLOMBIA',
        opcionEsperada: muni + ' (' + dep + ', COLOMBIA)'
      };
    }
  }

  const partes = original.split(',').map((x) => x.trim()).filter(Boolean);
  if (partes.length >= 3) {
    const municipio = partes[0];
    const departamento = partes[1];
    const pais = partes.slice(2).join(', ');
    return {
      original,
      municipio,
      departamento,
      pais,
      opcionEsperada: municipio + ' (' + departamento + ', ' + pais + ')'
    };
  }
  if (partes.length === 2) {
    return {
      original,
      municipio: partes[0],
      departamento: '',
      pais: partes[1],
      opcionEsperada: partes[0] + ' (' + partes[1] + ')'
    };
  }

  // Compatibilidad con registros antiguos que solo traían municipio.
  return { original, municipio: original, departamento: '', pais: 'COLOMBIA', opcionEsperada: '' };
}

`;

  biofile = reemplazarEntre(
    biofile,
    'function separarCiudadNacimiento(valor) {',
    'async function visible(locator) {',
    separador,
    'separarCiudadNacimiento'
  );

  const metodo = String.raw`  async #seleccionarCiudadNacimiento(locator, valor, etiqueta) {
    const lugar = separarCiudadNacimiento(valor);
    if (!lugar.municipio) throw new Error('El valor para ' + etiqueta + ' está vacío.');

    const pais = lugar.pais || 'COLOMBIA';
    const paises = variantesPais(pais);
    const departamento = normalizar(lugar.departamento);
    const aliasesCiudad = {
      'BOGOTA D C': ['BOGOTA'],
      'BOGOTA': ['BOGOTA'],
      'VILLA DE SAN DIEGO DE UBATE': ['UBATE'],
      'SAN ANDRES DE TUMACO': ['TUMACO'],
      'GUADALAJARA DE BUGA': ['BUGA']
    };
    const originalN = normalizar(lugar.municipio);
    const ciudadesSolicitadas = [...new Set([lugar.municipio, ...(aliasesCiudad[originalN] || [])])];

    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.evaluate((el) => {
      el.setAttribute('autocomplete', 'off');
      el.setAttribute('autocorrect', 'off');
      el.setAttribute('spellcheck', 'false');
    }).catch(() => {});

    const leer = async () => String(await locator.inputValue().catch(() => '')).trim().replace(/\s+/g, ' ');
    const escribir = async (ciudad) => {
      await locator.click({ clickCount: 3 }).catch(() => {});
      await locator.fill('');
      const texto = normalizar(ciudad) === 'BOGOTA D C' ? 'BOGOTA' : String(ciudad);
      await locator.pressSequentially(texto, { delay: 90 });
      await this.page.waitForTimeout(700);
    };

    const coincideLugar = (valorFinal, ciudad, fallback = false) => {
      const finalN = normalizar(valorFinal);
      const ciudadN = normalizar(ciudad);
      if (!finalN || !ciudadN) return false;
      const cabecera = normalizar(String(valorFinal).split('(')[0].split(',')[0]);
      const ciudadOk = cabecera === ciudadN || cabecera.startsWith(ciudadN) || ciudadN.startsWith(cabecera);
      if (!ciudadOk) return false;

      const paisOk = paises.some((p) => p && finalN.includes(p));
      if (!paisOk) return false;

      // En Colombia, para el intento exacto se exige además el departamento.
      // En el respaldo por capital no, porque Bogotá (capital de Cundinamarca)
      // aparece en BIOFILE como Bogotá D.C.
      if (esColombia(pais) && departamento && !fallback) {
        return finalN.includes(departamento);
      }
      return true;
    };

    const intentar = async (ciudad, fallback = false) => {
      await escribir(ciudad);
      const marca = 'biofile-lugar-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      const encontrado = await this.page.evaluate(({ ciudad, paises, departamento, marca, esCO, fallback }) => {
        const norm = (v) => String(v || '')
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-zA-Z0-9]+/g, ' ').trim().toUpperCase();
        const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        const c = norm(ciudad);
        const dep = norm(departamento);
        const ps = (paises || []).map(norm).filter(Boolean);
        const nodos = [...document.querySelectorAll(
          'li,a,button,[role="option"],.dropdown-item,.ui-menu-item,.tt-suggestion,.autocomplete-suggestion,div,span,td'
        )];
        const candidatos = [];
        const vistos = new Set();

        for (const el of nodos) {
          if (!visible(el)) continue;
          const txt = String(el.textContent || '').trim().replace(/\s+/g, ' ');
          if (!txt || txt.length > 180 || vistos.has(txt)) continue;
          const n = norm(txt);
          const cabeza = norm(txt.split('(')[0].split(',')[0]);
          let score = 0;
          if (cabeza === c) score += 120;
          else if (cabeza.startsWith(c) || c.startsWith(cabeza)) score += 90;
          else if (n.includes(c)) score += 55;
          else continue;

          const paisOk = ps.some((p) => p && n.includes(p));
          if (paisOk) score += 80;
          if (esCO && dep && !fallback && n.includes(dep)) score += 45;
          const tag = el.tagName;
          if (tag === 'LI' || el.getAttribute('role') === 'option') score += 20;
          else if (tag === 'A' || tag === 'BUTTON') score += 14;
          else if (tag === 'DIV') score += 4;
          score -= Math.min(el.childElementCount, 8) * 2;
          vistos.add(txt);
          candidatos.push({ el, txt, score, paisOk, depOk: !dep || n.includes(dep) });
        }

        candidatos.sort((a, b) => b.score - a.score || a.txt.length - b.txt.length);
        const mejor = candidatos.find((x) => x.paisOk && (fallback || !esCO || !dep || x.depOk) && x.score >= 175)
          || candidatos.find((x) => x.paisOk && x.score >= 155);
        if (!mejor) return { texto: '', opciones: candidatos.slice(0, 8).map((x) => x.txt) };
        mejor.el.setAttribute('data-biofile-lugar-opcion', marca);
        return { texto: mejor.txt, opciones: candidatos.slice(0, 8).map((x) => x.txt) };
      }, { ciudad, paises, departamento, marca, esCO: esColombia(pais), fallback }).catch(() => ({ texto: '', opciones: [] }));

      if (encontrado.texto) {
        const selector = '[data-biofile-lugar-opcion="' + marca + '"]';
        await this.page.locator(selector).first().click({ force: true }).catch(() => {});
        await this.page.waitForTimeout(450);
        const final = await leer();
        if (coincideLugar(final, ciudad, fallback)) {
          return { ok: true, final, opcion: encontrado.texto, fallback, opciones: encontrado.opciones || [] };
        }
      }

      // Respaldo por teclado para menús cuyo DOM no permite identificar el LI.
      for (let pos = 0; pos <= 15; pos += 1) {
        await escribir(ciudad);
        await locator.focus().catch(() => {});
        for (let i = 0; i < pos; i += 1) {
          await this.page.keyboard.press('ArrowDown').catch(() => {});
          await this.page.waitForTimeout(55);
        }
        await this.page.keyboard.press('Enter').catch(() => {});
        await this.page.waitForTimeout(350);
        const final = await leer();
        if (coincideLugar(final, ciudad, fallback)) {
          return { ok: true, final, opcion: final, fallback, opciones: encontrado.opciones || [] };
        }
      }
      return { ok: false, opciones: encontrado.opciones || [] };
    };

    let resultado = null;
    let opcionesVistas = [];
    for (const ciudad of ciudadesSolicitadas) {
      const r = await intentar(ciudad, false);
      opcionesVistas = r.opciones || opcionesVistas;
      if (r.ok) {
        resultado = r;
        break;
      }
    }

    if (!resultado) {
      const capital = esColombia(pais)
        ? capitalDepartamentoColombia(lugar.departamento)
        : capitalPais(pais);
      if (capital && !ciudadesSolicitadas.some((c) => normalizar(c) === normalizar(capital))) {
        const r = await intentar(capital, true);
        opcionesVistas = r.opciones || opcionesVistas;
        if (r.ok) resultado = r;
      }
    }

    if (!resultado) {
      const capital = esColombia(pais)
        ? capitalDepartamentoColombia(lugar.departamento)
        : capitalPais(pais);
      throw new Error(
        'No se pudo seleccionar la ciudad de nacimiento "' + lugar.municipio + '" en ' + pais + '. ' +
        (capital ? 'También se intentó la capital de respaldo "' + capital + '". ' : '') +
        'Opciones detectadas: ' + (opcionesVistas.length ? opcionesVistas.join(' | ') : 'BIOFILE no expuso opciones identificables') + '.'
      );
    }

    await locator.evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }).catch(() => {});

    const datosLog = {
      valorGoogleSheets: lugar.original,
      municipioOriginal: lugar.municipio,
      pais,
      departamento: lugar.departamento || '',
      valorFinal: resultado.final,
      opcionSeleccionada: resultado.opcion
    };
    if (resultado.fallback) {
      this.logger?.warn('Ciudad de nacimiento no encontrada; se aplicó capital de respaldo.', datosLog);
    } else {
      this.logger?.info('Ciudad de nacimiento seleccionada correctamente en BIOFILE.', datosLog);
    }
  }

`;

  biofile = reemplazarEntre(
    biofile,
    '  async #seleccionarCiudadNacimiento(locator, valor, etiqueta) {',
    '  async #seleccionarAutocompletado(locator, valor, etiqueta) {',
    metodo,
    '#seleccionarCiudadNacimiento'
  );
  fs.writeFileSync(biofilePath, biofile, 'utf8');
}

// ==================== GOOGLE SHEETS: ATRIBUCIÓN Y ELIMINADOS ====================
let sheets = fs.readFileSync(sheetsPath, 'utf8');
if (!sheets.includes('/* ESTADOS_OPERACION_V5 */')) {
  const colMarker = "  'MODO_INGRESO_BIOFILE'\n];";
  if (!sheets.includes(colMarker)) throw new Error('No se encontró COLUMNAS_CONTROL.');
  sheets = sheets.replace(
    colMarker,
    "  'MODO_INGRESO_BIOFILE',\n  /* ESTADOS_OPERACION_V5 */\n  'REGISTRADO_POR_BIOFILE',\n  'ELIMINADO_POR',\n  'FECHA_ELIMINADO_ISO',\n  'MOTIVO_ELIMINADO'\n];"
  );

  sheets = sheets.replace(
    "      MODO_INGRESO_BIOFILE: String(modo || 'AUTOMATICO').toUpperCase()\n    });",
    "      MODO_INGRESO_BIOFILE: String(modo || 'AUTOMATICO').toUpperCase(),\n      REGISTRADO_POR_BIOFILE: usuario || this.#get(row, 'REGISTRADO_POR_BIOFILE')\n    });"
  );

  const manualInicio = "  async marcarCompletadoManual(documento, usuario = '') {";
  const manualFin = "  async marcarError(row, error, { parcial = false, numeroOrden = '', usuario = '' } = {}) {";
  const manualNuevo = String.raw`  async marcarCompletadoManual(documento, usuarioResponsable = '', registradoPor = '') {
    const row = this.#filaPorDocumento(documento);
    if (!row) throw new Error('No se encontró ese documento en Google Sheets.');
    await this.marcarCompletado(row, this.#get(row, 'NUMERO_OS_BIOFILE'), usuarioResponsable, 'MANUAL');
    await this.#actualizar(row, { REGISTRADO_POR_BIOFILE: registradoPor || usuarioResponsable });
    return { row, usuarioResponsable, registradoPor: registradoPor || usuarioResponsable };
  }

`;
  sheets = reemplazarEntre(sheets, manualInicio, manualFin, manualNuevo, 'marcarCompletadoManual');

  const antesStats = "  obtenerEstadisticasUsuarios({ desde = '', hasta = '' } = {}) {";
  const eliminado = String.raw`  async marcarEliminado(documento, actor = '', motivo = '') {
    const row = this.#filaPorDocumento(documento);
    if (!row) throw new Error('No se encontró ese documento en Google Sheets.');
    const estado = normalizar(this.#get(row, 'ESTADO_BIOFILE'));
    if (estado === 'COMPLETADO') throw new Error('Un registro ya completado no se puede mover a Eliminados.');
    await this.#actualizar(row, {
      ESTADO_BIOFILE: 'ELIMINADO',
      ELIMINADO_POR: actor,
      FECHA_ELIMINADO_ISO: fechaIsoBogota(),
      MOTIVO_ELIMINADO: String(motivo || '').slice(0, 1000)
    });
    return {
      row,
      documento: this.#get(row, 'N° documento'),
      eliminadoPor: actor,
      motivo: String(motivo || '')
    };
  }

`;
  if (!sheets.includes(antesStats)) throw new Error('No se encontró obtenerEstadisticasUsuarios.');
  sheets = sheets.replace(antesStats, eliminado + antesStats);
  fs.writeFileSync(sheetsPath, sheets, 'utf8');
}

// ==================== API: MANUAL ATRIBUIBLE Y ELIMINAR ====================
let server = fs.readFileSync(serverPath, 'utf8');
if (!server.includes('/* OPERACION_API_V5 */')) {
  const antesManejar = 'async function manejar(req, res) {';
  const helper = String.raw`/* OPERACION_API_V5 */
async function resolverUsuarioResponsable(actor, solicitado = '') {
  const nombre = String(solicitado || '').trim();
  if (!nombre) return actor.usuario;
  if (actor.rol !== 'superadmin') {
    if (normalizarUsuario(nombre) !== normalizarUsuario(actor.usuario)) {
      throw new Error('Solo un Super Admin puede atribuir un ingreso manual a otro usuario.');
    }
    return actor.usuario;
  }

  const administrados = usuariosStore.disponible() ? await usuariosStore.listar() : [];
  const candidatos = [
    ...config.usuariosEntorno.map((u) => ({ usuario: u.usuario, activo: u.activo !== false })),
    ...administrados
  ];
  const encontrado = candidatos.find((u) => normalizarUsuario(u.usuario) === normalizarUsuario(nombre));
  if (!encontrado) throw new Error('El usuario responsable indicado no existe.');
  if (encontrado.activo === false) throw new Error('El usuario responsable está inactivo.');
  return encontrado.usuario;
}

`;
  if (!server.includes(antesManejar)) throw new Error('No se encontró manejar().');
  server = server.replace(antesManejar, helper + antesManejar);

  const manualStart = "  if (req.method === 'POST' && url.pathname === '/api/registros/marcar-manual') {";
  const statsStart = "  if (req.method === 'GET' && url.pathname === '/api/admin/estadisticas') {";
  const bloque = String.raw`  if (req.method === 'POST' && url.pathname === '/api/registros/marcar-manual') {
    const body = await leerJson(req);
    const documento = String(body.documento || '').trim();
    if (!documentoValido(documento)) {
      responderJson(req, res, 400, { ok: false, error: 'Documento no válido.' });
      return;
    }
    try {
      const responsable = await resolverUsuarioResponsable(usuario, body.usuarioResponsable);
      const base = await cargarBase();
      const resultado = await base.marcarCompletadoManual(documento, responsable, usuario.usuario);
      responderJson(req, res, 200, {
        ok: true,
        documento,
        fila: resultado.row,
        usuario: usuarioPublico(usuario),
        atribuidoA: responsable,
        registradoPor: usuario.usuario,
        modo: 'MANUAL'
      });
    } catch (error) {
      responderJson(req, res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/registros/eliminar') {
    const body = await leerJson(req);
    const documento = String(body.documento || '').trim();
    const motivo = String(body.motivo || '').trim();
    if (!documentoValido(documento)) {
      responderJson(req, res, 400, { ok: false, error: 'Documento no válido.' });
      return;
    }
    const activo = [...jobs.values()].find((j) =>
      j.documento === documento && ['en_cola', 'procesando'].includes(j.estado)
    );
    if (activo) {
      responderJson(req, res, 409, {
        ok: false,
        error: 'Este paciente está en cola o procesándose. Espere a que termine antes de enviarlo a Eliminados.'
      });
      return;
    }
    try {
      const base = await cargarBase();
      const resultado = await base.marcarEliminado(documento, usuario.usuario, motivo);
      responderJson(req, res, 200, { ok: true, ...resultado });
    } catch (error) {
      responderJson(req, res, 400, { ok: false, error: error.message });
    }
    return;
  }

`;
  server = reemplazarEntre(server, manualStart, statsStart, bloque, 'endpoints manual/eliminar');
  fs.writeFileSync(serverPath, server, 'utf8');
}

console.log('[BIOFILE] Lugares de nacimiento, atribución manual y Eliminados v5 habilitados.');
