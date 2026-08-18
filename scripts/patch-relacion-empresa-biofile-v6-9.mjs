import fs from 'node:fs';

const biofilePath = new URL('../src/biofile.js', import.meta.url);
const sheetsPath = new URL('../src/google-sheets.js', import.meta.url);
const procesarPath = new URL('../src/procesar-registro.js', import.meta.url);

const MARCA = 'RELACION_EMPRESA_BIOFILE_V69';

function reemplazarUna(texto, anterior, nuevo, etiqueta) {
  if (!texto.includes(anterior)) throw new Error(`No se encontró ${etiqueta}.`);
  return texto.replace(anterior, nuevo);
}

function agregarColumnasControl(texto, columnas) {
  const inicio = texto.indexOf('const COLUMNAS_CONTROL = [');
  if (inicio < 0) throw new Error('No se encontró COLUMNAS_CONTROL de Google Sheets.');
  const fin = texto.indexOf('\n];', inicio);
  if (fin < 0) throw new Error('No se encontró el cierre de COLUMNAS_CONTROL.');
  const bloque = texto.slice(inicio, fin);
  const faltantes = columnas.filter((columna) => !bloque.includes(`'${columna}'`));
  if (!faltantes.length) return texto;
  const prefijo = /,\s*$/.test(bloque) ? '' : ',';
  const agregado = prefijo + '\n' + faltantes.map((columna) => `  '${columna}'`).join(',\n');
  return texto.slice(0, fin) + agregado + texto.slice(fin);
}

// ==================== GOOGLE SHEETS ====================
let sheets = fs.readFileSync(sheetsPath, 'utf8');
if (!sheets.includes(`/* ${MARCA}_SHEETS */`)) {
  sheets = agregarColumnasControl(sheets, [
    'ACUERDO_COMERCIAL_BIOFILE',
    'EMPRESA_MISION_BIOFILE',
    'ORIGEN_RELACION_EMPRESA'
  ]);
  const finColumnas = sheets.indexOf('\n];', sheets.indexOf('const COLUMNAS_CONTROL = ['));
  sheets = sheets.slice(0, finColumnas + 3) + `\n\n/* ${MARCA}_SHEETS */` + sheets.slice(finColumnas + 3);

  sheets = reemplazarUna(
    sheets,
    `  #getRaw(rowNumber, nombre) {\n    const col = this.#col(nombre);\n    if (!col) return '';\n    return this.rows[rowNumber - 1]?.[col - 1] ?? '';\n  }`,
    `  #getRaw(rowNumber, nombre) {\n    const col = this.#col(nombre);\n    if (!col) return '';\n    return this.rows[rowNumber - 1]?.[col - 1] ?? '';\n  }\n\n  #getPrimero(rowNumber, nombres = []) {\n    for (const nombre of nombres) {\n      const valor = this.#get(rowNumber, nombre);\n      if (valor) return valor;\n    }\n    return '';\n  }`,
    '#getRaw en Google Sheets'
  );

  sheets = reemplazarUna(
    sheets,
    `        empresaExcel: this.#get(row, 'Empresa en misión'),`,
    `        acuerdoComercialExcel: this.#getPrimero(row, [\n          'Acuerdo comercial',\n          'Acuerdo Comercial',\n          'Nombre del Acuerdo Comercial, Contrato o Convenio',\n          'ACUERDO_COMERCIAL'\n        ]),\n        empresaMisionExcel: this.#getPrimero(row, [\n          'Empresa en misión',\n          'Empresa en Misión',\n          'Nombre de la Empresa en Misión',\n          'EMPRESA_MISION'\n        ]),\n        // Compatibilidad: la columna histórica sigue siendo la fuente principal\n        // cuando el Apps Script todavía no guarda columnas separadas.\n        empresaExcel: this.#getPrimero(row, [\n          'Empresa en misión',\n          'Empresa en Misión',\n          'Nombre de la Empresa en Misión',\n          'EMPRESA_MISION'\n        ]),`,
    'empresaExcel en obtenerPendientes'
  );

  fs.writeFileSync(sheetsPath, sheets, 'utf8');
}

// ==================== PROCESAR REGISTRO ====================
let procesar = fs.readFileSync(procesarPath, 'utf8');
if (!procesar.includes(`/* ${MARCA}_PROCESAR */`)) {
  procesar = reemplazarUna(
    procesar,
    "import { notificarExperiencia } from './experiencia.js';",
    "import { notificarExperiencia } from './experiencia.js';\nimport { resolverRelacionEmpresaRegistro } from './relacion-empresa.js';\n\n/* RELACION_EMPRESA_BIOFILE_V69_PROCESAR */",
    'import de experiencia en procesar-registro.js'
  );

  procesar = reemplazarUna(
    procesar,
    `    const defaults = {\n      ...configUsuario.defaults,\n      empresaMision: configUsuario.usarEmpresaExcel && registro.empresaExcel\n        ? registro.empresaExcel\n        : configUsuario.defaults.empresaMision\n    };\n\n    const resultadoLlenado = await biofile.llenarOrden(registro, defaults);`,
    `    const relacionEmpresa = await resolverRelacionEmpresaRegistro(registro, {\n      fallbackAcuerdo: configUsuario.defaults.acuerdo || 'PARTICULARES',\n      fallbackEmpresaMision: configUsuario.defaults.empresaMision || 'PARTICULARES',\n      logger\n    });\n\n    const defaults = {\n      ...configUsuario.defaults,\n      acuerdo: relacionEmpresa.acuerdo,\n      empresaMision: relacionEmpresa.empresaMision,\n      acuerdoFallback: configUsuario.defaults.acuerdo || 'PARTICULARES',\n      empresaMisionFallback: configUsuario.defaults.empresaMision || 'PARTICULARES'\n    };\n\n    logger.info('Relación empresarial preparada para BIOFILE.', {\n      acuerdo: defaults.acuerdo,\n      empresaMision: defaults.empresaMision,\n      fallback: Boolean(relacionEmpresa.fallback),\n      fuente: relacionEmpresa.fuente || relacionEmpresa.motivo || 'sin-fuente',\n      catalogo: relacionEmpresa.catalogo || ''\n    });\n\n    const resultadoLlenado = await biofile.llenarOrden(registro, defaults);`,
    'bloque defaults de empresa en procesar-registro.js'
  );

  procesar = reemplazarUna(
    procesar,
    `    await base.marcarOrdenCreada(registro.row, numeroOrden, usuario.usuario);`,
    `    await base.marcarOrdenCreada(registro.row, numeroOrden, usuario.usuario);\n\n    const relacionAplicada = resultadoLlenado?.relacionEmpresa || {\n      acuerdo: defaults.acuerdo,\n      empresaMision: defaults.empresaMision,\n      fallback: Boolean(relacionEmpresa.fallback),\n      fuente: relacionEmpresa.fuente || relacionEmpresa.motivo || ''\n    };\n\n    await base.actualizarCampos(registro.row, {\n      ACUERDO_COMERCIAL_BIOFILE: relacionAplicada.acuerdo || defaults.acuerdoFallback,\n      EMPRESA_MISION_BIOFILE: relacionAplicada.empresaMision || defaults.empresaMisionFallback,\n      ORIGEN_RELACION_EMPRESA: relacionAplicada.fallback\n        ? 'FALLBACK_PARTICULARES'\n        : String(relacionAplicada.fuente || 'CATALOGO_EXCEL')\n    });`,
    'marcarOrdenCreada en procesar-registro.js'
  );

  procesar = reemplazarUna(
    procesar,
    `      experiencia\n    };`,
    `      experiencia,\n      relacionEmpresa: resultadoLlenado?.relacionEmpresa || null\n    };`,
    'resultado final de procesar-registro.js'
  );

  fs.writeFileSync(procesarPath, procesar, 'utf8');
}

// ==================== BIOFILE ====================
let biofile = fs.readFileSync(biofilePath, 'utf8');
if (!biofile.includes(`/* ${MARCA}_BIOFILE */`)) {
  biofile = reemplazarUna(
    biofile,
    `    const campoNormalizado = normalizar(etiqueta);`,
    `    const campoNormalizado = normalizar(etiqueta);\n    /* RELACION_EMPRESA_BIOFILE_V69_BIOFILE */`,
    'campoNormalizado en autocompletado'
  );

  biofile = reemplazarUna(
    biofile,
    `      'NOMBRE DEL ACUERDO COMERCIAL CONTRATO O CONVENIO': {\n        buscar: 'PART',\n        seleccionar: 'PARTICULARES'\n      },\n\n      'NOMBRE DE LA EMPRESA EN MISION': {\n        buscar: 'PART',\n        seleccionar: 'PARTICULARES'\n      },`,
    `      'NOMBRE DEL ACUERDO COMERCIAL CONTRATO O CONVENIO': {\n        // Se escribe el nombre canónico completo obtenido del catálogo del Excel\n        // y se exige seleccionar exactamente esa opción en BIOFILE.\n        buscar: valorOriginal,\n        seleccionar: valorOriginal\n      },\n\n      'NOMBRE DE LA EMPRESA EN MISION': {\n        buscar: valorOriginal,\n        seleccionar: valorOriginal\n      },`,
    'reglas PARTICULARES fijas de Acuerdo/Misión'
  );

  const anclaMetodo = `  async #seleccionarAutocompletado(locator, valor, etiqueta) {`;
  const helper = `  async #esperarProcesamientoBiofile(timeoutMs = 7000) {\n    const limite = Date.now() + timeoutMs;\n    let vioProcesamiento = false;\n\n    while (Date.now() < limite) {\n      const ocupado = await this.page.evaluate(() => {\n        const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));\n        return [...document.querySelectorAll('div,span,p,td')].some((el) => {\n          if (!visible(el)) return false;\n          const texto = String(el.textContent || '').trim().replace(/\\s+/g, ' ');\n          if (!texto || texto.length > 90) return false;\n          return /^(procesando datos|procesando|cargando)(\\.{0,3})$/i.test(texto);\n        });\n      }).catch(() => false);\n\n      if (!ocupado) {\n        if (vioProcesamiento) await this.page.waitForTimeout(180);\n        return;\n      }\n\n      vioProcesamiento = true;\n      await this.page.waitForTimeout(120);\n    }\n\n    this.logger?.warn('BIOFILE continuó mostrando procesamiento; se continuará con validación estricta de los campos.');\n  }\n\n`;
  if (!biofile.includes(anclaMetodo)) throw new Error('No se encontró #seleccionarAutocompletado.');
  biofile = biofile.replace(anclaMetodo, helper + anclaMetodo);

  biofile = reemplazarUna(
    biofile,
    `    // Estos datos pertenecen a la orden actual y deben quedar con los valores definidos.\n    await this.#llenar('tipoEvaluacion', 'Tipo de Evaluación Médica o Procedimiento', defaults.tipoEvaluacion, { autocomplete: true });\n    await this.#llenar('acuerdoComercial', 'Nombre del Acuerdo Comercial, Contrato o Convenio', defaults.acuerdo, { autocomplete: true });\n    await this.#llenar('empresaMision', 'Nombre de la Empresa en Misión', defaults.empresaMision, { autocomplete: true });\n    await this.#llenar('paquete', 'Nombre del Paquete', defaults.paquete, { autocomplete: true });`,
    `    // Estos datos pertenecen a la orden actual y deben quedar con los valores definidos.\n    await this.#llenar('tipoEvaluacion', 'Tipo de Evaluación Médica o Procedimiento', defaults.tipoEvaluacion, { autocomplete: true });\n\n    const acuerdoSolicitado = String(defaults.acuerdo || '').trim();\n    const misionSolicitada = String(defaults.empresaMision || '').trim();\n    const acuerdoFallback = String(defaults.acuerdoFallback || 'PARTICULARES').trim();\n    const misionFallback = String(defaults.empresaMisionFallback || 'PARTICULARES').trim();\n    let relacionEmpresaAplicada = {\n      acuerdo: acuerdoSolicitado,\n      empresaMision: misionSolicitada,\n      fallback: false,\n      fuente: 'catalogo-excel'\n    };\n\n    try {\n      await this.#esperarProcesamientoBiofile();\n      await this.#llenar('acuerdoComercial', 'Nombre del Acuerdo Comercial, Contrato o Convenio', acuerdoSolicitado, { autocomplete: true });\n      await this.#esperarProcesamientoBiofile();\n      await this.#llenar('empresaMision', 'Nombre de la Empresa en Misión', misionSolicitada, { autocomplete: true });\n      await this.#esperarProcesamientoBiofile();\n    } catch (errorRelacion) {\n      const yaEraFallback =\n        normalizar(acuerdoSolicitado) === normalizar(acuerdoFallback) &&\n        normalizar(misionSolicitada) === normalizar(misionFallback);\n\n      if (yaEraFallback) throw errorRelacion;\n\n      this.logger?.warn('No fue posible seleccionar la relación empresarial exacta; se aplicará PARTICULARES.', {\n        acuerdoSolicitado,\n        misionSolicitada,\n        error: errorRelacion.message\n      });\n\n      await this.#esperarProcesamientoBiofile();\n      await this.#llenar('acuerdoComercial', 'Nombre del Acuerdo Comercial, Contrato o Convenio', acuerdoFallback, { autocomplete: true });\n      await this.#esperarProcesamientoBiofile();\n      await this.#llenar('empresaMision', 'Nombre de la Empresa en Misión', misionFallback, { autocomplete: true });\n      await this.#esperarProcesamientoBiofile();\n\n      relacionEmpresaAplicada = {\n        acuerdo: acuerdoFallback,\n        empresaMision: misionFallback,\n        fallback: true,\n        fuente: 'fallback-error-biofile',\n        errorOriginal: errorRelacion.message\n      };\n    }\n\n    await this.#llenar('paquete', 'Nombre del Paquete', defaults.paquete, { autocomplete: true });`,
    'bloque de Acuerdo Comercial y Empresa en Misión en llenarOrden'
  );

  biofile = reemplazarUna(
    biofile,
    `    return { pacienteExistente };\n  }\n\n  async #llenarProductoInferior(defaults) {`,
    `    return { pacienteExistente, relacionEmpresa: relacionEmpresaAplicada };\n  }\n\n  async #llenarProductoInferior(defaults) {`,
    'return de llenarOrden'
  );

  fs.writeFileSync(biofilePath, biofile, 'utf8');
}

console.log('[BIOFILE] v6.9: Acuerdo Comercial + Empresa en Misión desde catálogo Excel, selección exacta y fallback seguro a PARTICULARES.');
