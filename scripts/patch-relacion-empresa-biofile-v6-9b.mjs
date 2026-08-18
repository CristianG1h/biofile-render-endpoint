import fs from 'node:fs';

const biofilePath = new URL('../src/biofile.js', import.meta.url);
const sheetsPath = new URL('../src/google-sheets.js', import.meta.url);
const procesarPath = new URL('../src/procesar-registro.js', import.meta.url);
const MARCA = 'RELACION_EMPRESA_BIOFILE_V69B';

function reemplazarUna(texto, anterior, nuevo, etiqueta) {
  if (!texto.includes(anterior)) throw new Error(`No se encontró ${etiqueta}.`);
  return texto.replace(anterior, nuevo);
}

function agregarColumnasControl(texto, columnas) {
  const inicio = texto.indexOf('const COLUMNAS_CONTROL = [');
  if (inicio < 0) throw new Error('No se encontró COLUMNAS_CONTROL.');
  const fin = texto.indexOf('\n];', inicio);
  if (fin < 0) throw new Error('No se encontró cierre de COLUMNAS_CONTROL.');
  let bloque = texto.slice(inicio, fin);
  const faltantes = columnas.filter((c) => !bloque.includes(`'${c}'`));
  if (!faltantes.length) return texto;
  if (!/,\s*$/.test(bloque)) bloque += ',';
  bloque += '\n' + faltantes.map((c) => `  '${c}'`).join(',\n');
  return texto.slice(0, inicio) + bloque + texto.slice(fin);
}

// -------- Google Sheets: leer relación explícita cuando exista y guardar auditoría --------
let sheets = fs.readFileSync(sheetsPath, 'utf8');
if (!sheets.includes(`/* ${MARCA}_SHEETS */`)) {
  sheets = agregarColumnasControl(sheets, [
    'ACUERDO_COMERCIAL_BIOFILE',
    'EMPRESA_MISION_BIOFILE',
    'ORIGEN_RELACION_EMPRESA'
  ]);

  const finColumnas = sheets.indexOf('\n];', sheets.indexOf('const COLUMNAS_CONTROL = ['));
  sheets = sheets.slice(0, finColumnas + 3) + `\n\n/* ${MARCA}_SHEETS */` + sheets.slice(finColumnas + 3);

  const getRaw = `  #getRaw(rowNumber, nombre) {\n    const col = this.#col(nombre);\n    if (!col) return '';\n    return this.rows[rowNumber - 1]?.[col - 1] ?? '';\n  }`;
  if (!sheets.includes('#getPrimero(rowNumber')) {
    sheets = reemplazarUna(sheets, getRaw, getRaw + `\n\n  #getPrimero(rowNumber, nombres = []) {\n    for (const nombre of nombres) {\n      const valor = this.#get(rowNumber, nombre);\n      if (valor) return valor;\n    }\n    return '';\n  }`, '#getRaw');
  }

  const empresaLegacy = `        empresaExcel: this.#get(row, 'Empresa en misión'),`;
  if (sheets.includes(empresaLegacy)) {
    sheets = sheets.replace(empresaLegacy, `        acuerdoComercialExcel: this.#getPrimero(row, [\n          'Acuerdo comercial',\n          'Acuerdo Comercial',\n          'Nombre del Acuerdo Comercial, Contrato o Convenio',\n          'ACUERDO_COMERCIAL'\n        ]),\n        empresaMisionExcel: this.#getPrimero(row, [\n          'Empresa en misión',\n          'Empresa en Misión',\n          'Nombre de la Empresa en Misión',\n          'EMPRESA_MISION'\n        ]),\n        empresaExcel: this.#getPrimero(row, [\n          'Empresa en misión',\n          'Empresa en Misión',\n          'Nombre de la Empresa en Misión',\n          'EMPRESA_MISION'\n        ]),`);
  } else if (!sheets.includes('acuerdoComercialExcel:')) {
    throw new Error('No se encontró empresaExcel para agregar la relación empresarial.');
  }

  fs.writeFileSync(sheetsPath, sheets, 'utf8');
}

// -------- Procesamiento: resolver desde el catálogo antes de llenar BIOFILE --------
let procesar = fs.readFileSync(procesarPath, 'utf8');
if (!procesar.includes(`/* ${MARCA}_PROCESAR */`)) {
  if (!procesar.includes("import { resolverRelacionEmpresaRegistro } from './relacion-empresa.js';")) {
    procesar = reemplazarUna(
      procesar,
      "import { notificarExperiencia } from './experiencia.js';",
      "import { notificarExperiencia } from './experiencia.js';\nimport { resolverRelacionEmpresaRegistro } from './relacion-empresa.js';",
      'import notificarExperiencia'
    );
  }

  const anclaLlenado = `    const resultadoLlenado = await biofile.llenarOrden(registro, defaults);`;
  const preparar = `    /* ${MARCA}_PROCESAR */\n    const relacionEmpresa = await resolverRelacionEmpresaRegistro(registro, {\n      fallbackAcuerdo: configUsuario.defaults.acuerdo || 'PARTICULARES',\n      fallbackEmpresaMision: configUsuario.defaults.empresaMision || 'PARTICULARES',\n      logger\n    });\n\n    defaults.acuerdoFallback = configUsuario.defaults.acuerdo || 'PARTICULARES';\n    defaults.empresaMisionFallback = configUsuario.defaults.empresaMision || 'PARTICULARES';\n    defaults.acuerdo = relacionEmpresa.acuerdo;\n    defaults.empresaMision = relacionEmpresa.empresaMision;\n\n    logger.info('Relación empresarial preparada para BIOFILE.', {\n      acuerdo: defaults.acuerdo,\n      empresaMision: defaults.empresaMision,\n      fallback: Boolean(relacionEmpresa.fallback),\n      fuente: relacionEmpresa.fuente || relacionEmpresa.motivo || 'sin-fuente',\n      catalogo: relacionEmpresa.catalogo || ''\n    });\n\n`;
  procesar = reemplazarUna(procesar, anclaLlenado, preparar + anclaLlenado, 'resultadoLlenado');

  const anclaOrden = `    await base.marcarOrdenCreada(registro.row, numeroOrden, usuario.usuario);`;
  const auditoria = `${anclaOrden}\n\n    const relacionAplicada = resultadoLlenado?.relacionEmpresa || {\n      acuerdo: defaults.acuerdo,\n      empresaMision: defaults.empresaMision,\n      fallback: Boolean(relacionEmpresa.fallback),\n      fuente: relacionEmpresa.fuente || relacionEmpresa.motivo || ''\n    };\n\n    await base.actualizarCampos(registro.row, {\n      ACUERDO_COMERCIAL_BIOFILE: relacionAplicada.acuerdo || defaults.acuerdoFallback,\n      EMPRESA_MISION_BIOFILE: relacionAplicada.empresaMision || defaults.empresaMisionFallback,\n      ORIGEN_RELACION_EMPRESA: relacionAplicada.fallback\n        ? 'FALLBACK_PARTICULARES'\n        : String(relacionAplicada.fuente || 'CATALOGO_EXCEL')\n    });`;
  procesar = reemplazarUna(procesar, anclaOrden, auditoria, 'marcarOrdenCreada');
  fs.writeFileSync(procesarPath, procesar, 'utf8');
}

// -------- BIOFILE: seleccionar texto exacto, esperar postback y usar fallback --------
let biofile = fs.readFileSync(biofilePath, 'utf8');
if (!biofile.includes(`/* ${MARCA}_BIOFILE */`)) {
  biofile = reemplazarUna(
    biofile,
    `    const campoNormalizado = normalizar(etiqueta);`,
    `    const campoNormalizado = normalizar(etiqueta);\n    /* ${MARCA}_BIOFILE */`,
    'campoNormalizado de autocompletado'
  );

  biofile = reemplazarUna(
    biofile,
    `      'NOMBRE DEL ACUERDO COMERCIAL CONTRATO O CONVENIO': {\n        buscar: 'PART',\n        seleccionar: 'PARTICULARES'\n      },\n\n      'NOMBRE DE LA EMPRESA EN MISION': {\n        buscar: 'PART',\n        seleccionar: 'PARTICULARES'\n      },`,
    `      'NOMBRE DEL ACUERDO COMERCIAL CONTRATO O CONVENIO': {\n        buscar: valorOriginal,\n        seleccionar: valorOriginal\n      },\n\n      'NOMBRE DE LA EMPRESA EN MISION': {\n        buscar: valorOriginal,\n        seleccionar: valorOriginal\n      },`,
    'reglas fijas PARTICULARES de Acuerdo/Misión'
  );

  const anclaAutocomplete = `  async #seleccionarAutocompletado(locator, valor, etiqueta) {`;
  const espera = `  async #esperarProcesamientoBiofile(timeoutMs = 7000) {\n    const limite = Date.now() + timeoutMs;\n    let vioProcesamiento = false;\n    while (Date.now() < limite) {\n      const ocupado = await this.page.evaluate(() => {\n        const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));\n        return [...document.querySelectorAll('div,span,p,td')].some((el) => {\n          if (!visible(el)) return false;\n          const t = String(el.textContent || '').trim().replace(/\\s+/g, ' ');\n          return t.length <= 90 && /^(procesando datos|procesando|cargando)(\\.{0,3})$/i.test(t);\n        });\n      }).catch(() => false);\n      if (!ocupado) {\n        if (vioProcesamiento) await this.page.waitForTimeout(180);\n        return;\n      }\n      vioProcesamiento = true;\n      await this.page.waitForTimeout(120);\n    }\n    this.logger?.warn('BIOFILE continuó mostrando procesamiento; se validarán estrictamente los campos.');\n  }\n\n`;
  if (!biofile.includes('#esperarProcesamientoBiofile(')) {
    biofile = reemplazarUna(biofile, anclaAutocomplete, espera + anclaAutocomplete, '#seleccionarAutocompletado');
  }

  const bloqueViejo = `    // Estos datos pertenecen a la orden actual y deben quedar con los valores definidos.\n    await this.#llenar('tipoEvaluacion', 'Tipo de Evaluación Médica o Procedimiento', defaults.tipoEvaluacion, { autocomplete: true });\n    await this.#llenar('acuerdoComercial', 'Nombre del Acuerdo Comercial, Contrato o Convenio', defaults.acuerdo, { autocomplete: true });\n    await this.#llenar('empresaMision', 'Nombre de la Empresa en Misión', defaults.empresaMision, { autocomplete: true });\n    await this.#llenar('paquete', 'Nombre del Paquete', defaults.paquete, { autocomplete: true });`;

  const bloqueNuevo = `    // Estos datos pertenecen a la orden actual y deben quedar con los valores definidos.\n    await this.#llenar('tipoEvaluacion', 'Tipo de Evaluación Médica o Procedimiento', defaults.tipoEvaluacion, { autocomplete: true });\n\n    const acuerdoSolicitado = String(defaults.acuerdo || '').trim();\n    const misionSolicitada = String(defaults.empresaMision || '').trim();\n    const acuerdoFallback = String(defaults.acuerdoFallback || 'PARTICULARES').trim();\n    const misionFallback = String(defaults.empresaMisionFallback || 'PARTICULARES').trim();\n    let relacionEmpresaAplicada = {\n      acuerdo: acuerdoSolicitado,\n      empresaMision: misionSolicitada,\n      fallback: false,\n      fuente: 'catalogo-excel'\n    };\n\n    try {\n      await this.#esperarProcesamientoBiofile();\n      await this.#llenar('acuerdoComercial', 'Nombre del Acuerdo Comercial, Contrato o Convenio', acuerdoSolicitado, { autocomplete: true });\n      await this.#esperarProcesamientoBiofile();\n      await this.#llenar('empresaMision', 'Nombre de la Empresa en Misión', misionSolicitada, { autocomplete: true });\n      await this.#esperarProcesamientoBiofile();\n    } catch (errorRelacion) {\n      const yaEraFallback = normalizar(acuerdoSolicitado) === normalizar(acuerdoFallback) &&\n        normalizar(misionSolicitada) === normalizar(misionFallback);\n      if (yaEraFallback) throw errorRelacion;\n\n      this.logger?.warn('La relación empresarial exacta no pudo seleccionarse; se usará PARTICULARES.', {\n        acuerdoSolicitado,\n        misionSolicitada,\n        error: errorRelacion.message\n      });\n\n      await this.#esperarProcesamientoBiofile();\n      await this.#llenar('acuerdoComercial', 'Nombre del Acuerdo Comercial, Contrato o Convenio', acuerdoFallback, { autocomplete: true });\n      await this.#esperarProcesamientoBiofile();\n      await this.#llenar('empresaMision', 'Nombre de la Empresa en Misión', misionFallback, { autocomplete: true });\n      await this.#esperarProcesamientoBiofile();\n\n      relacionEmpresaAplicada = {\n        acuerdo: acuerdoFallback,\n        empresaMision: misionFallback,\n        fallback: true,\n        fuente: 'fallback-error-biofile',\n        errorOriginal: errorRelacion.message\n      };\n    }\n\n    await this.#llenar('paquete', 'Nombre del Paquete', defaults.paquete, { autocomplete: true });`;
  biofile = reemplazarUna(biofile, bloqueViejo, bloqueNuevo, 'bloque Acuerdo/Misión de llenarOrden');

  biofile = reemplazarUna(
    biofile,
    `    return { pacienteExistente };\n  }\n\n  async #llenarProductoInferior(defaults) {`,
    `    return { pacienteExistente, relacionEmpresa: relacionEmpresaAplicada };\n  }\n\n  async #llenarProductoInferior(defaults) {`,
    'return de llenarOrden'
  );

  fs.writeFileSync(biofilePath, biofile, 'utf8');
}

console.log('[BIOFILE] v6.9b: relación Acuerdo/Misión exacta con fallback seguro a PARTICULARES.');
