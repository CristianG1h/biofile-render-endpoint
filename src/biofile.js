import { activity, checkCancelled } from './jobs/execution.js';
import fs from 'node:fs';
import path from 'node:path';
import { descargarArchivoEnMemoria } from './drive.js';
import { asegurarDirectorio, fechaArchivo, normalizar } from './util.js';
import { capitalDepartamentoColombia, capitalPais, variantesPais, esColombia } from './lugares-nacimiento.js';
import {
  construirUrlMetodoAutocomplete,
  extraerOpcionesAutocomplete,
  limpiarOpcionesCatalogo,
  resolverOpcionUnica,
  textoBusquedaAutocomplete
} from './autocomplete-biofile.js';

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


/* LUGARES_NACIMIENTO_V5 */
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

async function visible(locator) {
  try {
    return (await locator.count()) > 0 && await locator.first().isVisible();
  } catch {
    return false;
  }
}

export class BiofileClient {
  constructor({ page, context, config, logger }) {
    this.page = page;
    this.context = context;
    this.config = config;
    this.logger = logger;
    this.pacienteExistenteActual = false;
  }

  async abrirOrdenNueva() {
    const yaEstaEnOrdenes =
  /OrdenesServiciosSaludOcupacional/i.test(
    this.page.url()
  );

if (!yaEstaEnOrdenes) {
  this.logger?.info(
    'Abriendo el formulario de órdenes de Biofile.'
  );

  await this.page.goto(
    this.config.biofile.ordenUrl,
    {
      waitUntil: 'domcontentloaded'
    }
  );

  await this.page.waitForTimeout(700);
} else {
  this.logger?.info(
    'El formulario de órdenes ya está abierto; no se recargará.'
  );
}

const loginVisible = await visible(
  this.page.locator(
    'input[type="password"]:visible'
  )
);

if (
  /IniciarSesion/i.test(this.page.url()) ||
  loginVisible
) {
  throw new Error(
    'La sesión de Biofile expiró durante el proceso.'
  );
}

    // Si Biofile dejó visible una orden anterior, intenta limpiar el formulario con Nuevo.
    try {
      const documento = await this.#controlCercaDeEtiqueta('numeroDocumento', 'N°. de Identificación');
      const numeroOrden = await this.#controlCercaDeEtiqueta('numeroOrden', 'N°. O.S.').catch(() => null);
      const tieneDocumento = !this.#esVacioActual(await this.#valorActual(documento));
      const tieneOrden = numeroOrden
        ? !this.#esVacioActual(await this.#valorActual(numeroOrden))
        : false;

      if (tieneDocumento || tieneOrden) {
        const nuevo = await this.#accion('nuevo', 'Nuevo');
        await nuevo.click();
        await this.page.waitForTimeout(1200);
        this.logger?.info('Biofile tenía datos anteriores; se abrió un formulario nuevo.');
      }
    } catch (error) {
      if (this.config.strictOrder) throw new Error('No fue posible verificar que el formulario de orden esté vacío: ' + error.message);
      this.logger?.warn('No fue posible comprobar o pulsar Nuevo; se continuará con el formulario abierto.', {
        detalle: error.message
      });
    }
  }

  async #descriptorAutocomplete(locator) {
    return locator.evaluate((elemento) => {
      const componentes = window.Sys?.Application?.getComponents?.() || [];
      const id = elemento.id || '';
      const coincide = (componente) => {
        try {
          const ids = [
            componente?.get_element?.()?.id,
            componente?.get_targetControlID?.(),
            componente?._targetControlID,
            componente?._element?.id,
            componente?._textBoxElement?.id
          ].filter(Boolean);
          return ids.includes(id) || componente?.get_element?.() === elemento ||
            componente?._element === elemento || componente?._textBoxElement === elemento;
        } catch { return false; }
      };
      const componente = componentes.find(coincide) || null;
      const leer = (getter, interno, fallback = '') => {
        try {
          if (componente && typeof componente[getter] === 'function') {
            const valor = componente[getter]();
            if (valor !== undefined && valor !== null) return valor;
          }
        } catch {}
        return componente?.[interno] ?? fallback;
      };
      return {
        inputId: id,
        componenteEncontrado: Boolean(componente),
        servicePath: String(leer('get_servicePath', '_servicePath', '') || ''),
        serviceMethod: String(leer('get_serviceMethod', '_serviceMethod', '') || ''),
        contextKey: String(leer('get_contextKey', '_contextKey', '') ?? ''),
        count: Math.max(10, Number(leer('get_completionSetCount', '_completionSetCount', 50)) || 50)
      };
    });
  }

  async #sugerenciasVisibles() {
    return this.page.evaluate(() => {
      const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const selectores = [
        '[role="option"]', '.ajax__autocomplete_item', '.ajax__autocomplete_highlighted_item',
        '.autocomplete_completionListElement > *',
        '[class*="autocomplete" i] li', '[id*="completion" i] > *', '[id*="autocomplete" i] li'
      ];
      const textos = [];
      for (const selector of selectores) {
        for (const el of document.querySelectorAll(selector)) {
          if (!visible(el)) continue;
          const texto = String(el.textContent || '').trim().replace(/\s+/g, ' ');
          if (texto && texto.length <= 220 && !textos.includes(texto)) textos.push(texto);
        }
      }
      return textos;
    }).catch(() => []);
  }

  async #consultarOpcionesAutocomplete(locator, {
    campo,
    prefixText = '',
    timeoutMs = 8000,
    soloInterfaz = false
  } = {}) {
    const descriptor = await this.#descriptorAutocomplete(locator).catch(() => ({
      componenteEncontrado: false, servicePath: '', serviceMethod: '', contextKey: '', count: 50
    }));
    let urlMetodo = '';
    try {
      urlMetodo = construirUrlMetodoAutocomplete({
        paginaActual: this.page.url(),
        servicePath: descriptor.servicePath,
        serviceMethod: descriptor.serviceMethod
      });
    } catch {}

    let respuestaDirecta = null;
    if (urlMetodo && !soloInterfaz) {
      respuestaDirecta = await this.page.evaluate(async ({ url, prefixText, count, contextKey, timeoutMs }) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(url, {
            method: 'POST', credentials: 'same-origin',
            headers: {
              Accept: 'application/json, text/javascript, */*; q=0.01',
              'Content-Type': 'application/json; charset=UTF-8'
            },
            body: JSON.stringify({ prefixText, count, contextKey }), signal: controller.signal
          });
          const texto = await response.text();
          let data = null;
          try { data = texto ? JSON.parse(texto) : null; } catch {}
          return { ok: response.ok, status: response.status, data };
        } finally { clearTimeout(timeout); }
      }, {
        url: urlMetodo, prefixText, count: descriptor.count,
        contextKey: descriptor.contextKey, timeoutMs
      }).catch(() => ({ ok: false, status: 0, data: null }));
      const opciones = limpiarOpcionesCatalogo(extraerOpcionesAutocomplete(respuestaDirecta.data));
      if (respuestaDirecta.ok && opciones.length) {
        this.logger?.info('Opciones consultadas directamente en el WebMethod de BIOFILE.', {
          campo, serviceMethod: descriptor.serviceMethod,
          contextKey: descriptor.contextKey, opciones: opciones.length
        });
        return { opciones, fuente: 'webmethod', descriptor, urlMetodo, status: respuestaDirecta.status };
      }
    }

    // Respaldo: activar el autocompletado visual y capturar su respuesta XHR.
    const respuestas = [];
    const listener = async (response) => {
      try {
        if (!/json|javascript/i.test(String(response.headers()['content-type'] || ''))) return;
        if (descriptor.serviceMethod && !response.url().includes(descriptor.serviceMethod)) return;
        const data = await response.json().catch(() => null);
        if (data) respuestas.push(...extraerOpcionesAutocomplete(data));
      } catch {}
    };
    if (!soloInterfaz) this.page.on('response', listener);
    try {
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      await locator.click({ clickCount: 3 });
      await locator.fill('');
      if (prefixText) await locator.pressSequentially(prefixText, { delay: 25 });
      await locator.evaluate((el) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowDown' }));
      }).catch(() => {});
      const limite = Date.now() + timeoutMs;
      while (Date.now() < limite) {
        const visibles = await this.#sugerenciasVisibles();
        const opciones = limpiarOpcionesCatalogo(
          soloInterfaz ? visibles : [...respuestas, ...visibles]
        );
        if (soloInterfaz && visibles.length) {
          return {
            opciones,
            fuente: opciones.length ? 'interfaz' : 'interfaz-vacia',
            descriptor,
            urlMetodo,
            status: 200
          };
        }
        if (opciones.length) return { opciones, fuente: 'interfaz', descriptor, urlMetodo, status: 200 };
        await this.page.waitForTimeout(150);
      }
    } finally {
      if (!soloInterfaz) this.page.off('response', listener);
    }
    if (respuestaDirecta?.ok) {
      return {
        opciones: [], fuente: 'webmethod-vacio', descriptor, urlMetodo,
        status: respuestaDirecta.status
      };
    }
    return { opciones: [], fuente: 'consulta-fallida', descriptor, urlMetodo, status: 0 };
  }

  /** Consulta los paquetes desde Órdenes de Servicio, cuyo flujo ya usa el robot. */
  async investigarCatalogoEmpresa({ acuerdo, tiposEvaluacion = [] }) {
    const acuerdoBuscado = String(acuerdo || '').trim();
    if (!acuerdoBuscado) throw new Error('El acuerdo comercial es obligatorio.');
    await this.abrirOrdenNueva();
    const tipos = tiposEvaluacion.map((tipo) => String(tipo || '').trim()).filter(Boolean);
    const paquetes = [];
    const diagnostico = [];
    let acuerdoExacto = acuerdoBuscado;
    let acuerdoParaSeleccionar = acuerdoBuscado;
    let empresasMision = [];
    let acuerdoSeleccionado = false;

    for (const tipoEvaluacion of tipos) {
      await this.#llenar('tipoEvaluacion', 'Tipo de Evaluación Médica o Procedimiento', tipoEvaluacion, { autocomplete: true });
      const acuerdoInput = await this.#controlCercaDeEtiqueta('acuerdoComercial', 'Nombre del Acuerdo Comercial, Contrato o Convenio');
      const acuerdoActual = String(await acuerdoInput.inputValue().catch(() => '')).trim();
      if (!acuerdoSeleccionado) {
        const consultaAcuerdo = await this.#consultarOpcionesAutocomplete(acuerdoInput, {
          campo: 'Nombre del Acuerdo Comercial, Contrato o Convenio',
          prefixText: acuerdoBuscado,
          timeoutMs: 9000
        });
        const opcionesAcuerdo = limpiarOpcionesCatalogo(consultaAcuerdo.opciones);
        acuerdoParaSeleccionar = resolverOpcionUnica(opcionesAcuerdo, acuerdoBuscado) || acuerdoBuscado;
        if (opcionesAcuerdo.length > 1 && acuerdoParaSeleccionar === acuerdoBuscado &&
          !opcionesAcuerdo.some((opcion) => normalizar(opcion) === normalizar(acuerdoBuscado))) {
          throw new Error(
            `BIOFILE encontró varias coincidencias para el acuerdo "${acuerdoBuscado}". ` +
            `Escribe un nombre más preciso: ${opcionesAcuerdo.slice(0, 8).join(' | ')}.`
          );
        }
      }
      if (!acuerdoSeleccionado || !acuerdoActual) {
        await this.#escribirEnControl(
          acuerdoInput,
          acuerdoParaSeleccionar,
          'Nombre del Acuerdo Comercial, Contrato o Convenio',
          { autocomplete: true }
        );
        acuerdoSeleccionado = true;
      }
      await this.page.waitForTimeout(500);
      acuerdoExacto = String(await acuerdoInput.inputValue().catch(() => acuerdoBuscado)).trim() || acuerdoBuscado;

      /* DIRECTORIO_ESTABLE_SIN_MISION_V78_SIN_MISION */
      // No consultar Empresa en Misión durante la investigación de paquetes.
      // Se conserva empresasMision=[] únicamente por compatibilidad de respuesta.
      const inputPaquete = await this.#controlCercaDeEtiqueta('paquete', 'Nombre del Paquete');
      const consulta = await this.#consultarOpcionesAutocomplete(inputPaquete, {
        campo: 'Nombre del Paquete',
        prefixText: '',
        timeoutMs: 8000,
        soloInterfaz: true
      });
      const nombres = limpiarOpcionesCatalogo(consulta.opciones);
      const consultaValida = consulta.status >= 200 && consulta.status < 300;
      diagnostico.push({
        tipoEvaluacion, estado: consultaValida ? 'OK' : 'ERROR', paquetes: nombres, fuente: consulta.fuente,
        serviceMethod: consulta.descriptor?.serviceMethod || '',
        contextKey: consulta.descriptor?.contextKey || '',
        error: consultaValida ? '' : 'No se pudo invocar el autocompletado de paquetes de BIOFILE.'
      });
      for (const nombre of nombres) {
        if (!paquetes.some((item) => normalizar(item.nombre) === normalizar(nombre) &&
          normalizar(item.tipoEvaluacion) === normalizar(tipoEvaluacion))) {
          paquetes.push({ nombre, tipoEvaluacion });
        }
      }
    }
    if (diagnostico.length && diagnostico.every((item) => item.estado === 'ERROR')) {
      const error = new Error(
        'BIOFILE no permitió consultar el autocompletado de paquetes para ningún tipo de evaluación.'
      );
      error.detalleCatalogo = {
        paso: 'AUTOCOMPLETADO_PAQUETES_ORDENES', acuerdoExacto, diagnostico
      };
      throw error;
    }
    return { acuerdoExacto, empresasMision, paquetes, diagnostico };
  }

  async captura(nombre) {
    asegurarDirectorio(this.config.paths.screenshots);
    const file = path.join(this.config.paths.screenshots, `${fechaArchivo()}-${nombre}.png`);
    await this.page.screenshot({ path: file, fullPage: true });
    return file;
  }

  async #controlCercaDeEtiqueta(fieldKey, etiqueta) {
    const override = this.config.selectors[fieldKey];
    if (override) {
      const loc = this.page.locator(override).first();
      if (await visible(loc)) return loc;
      throw new Error(`El selector configurado para ${fieldKey} no es visible: ${override}`);
    }

    const descriptor = await this.page.evaluate(({ etiqueta }) => {
      const norm = (v) => String(v || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, ' ').trim().toUpperCase();
      const objetivo = norm(etiqueta);
      const esVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

      const nodos = [...document.querySelectorAll('label,span,div,td,p,strong')]
        .filter(esVisible)
        .map((el) => {
          const textoPropio = [...el.childNodes]
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => n.textContent)
            .join(' ');
          const t = norm(textoPropio || el.textContent);
          const calidad = t === objetivo ? 0 : t.startsWith(objetivo) ? 1 : objetivo.startsWith(t) ? 2 : 99;
          return { el, t, calidad };
        })
        .filter(({ calidad }) => calidad < 99)
        .sort((a, b) => {
          const prioridad = (el) => ({ LABEL: 0, SPAN: 1, STRONG: 2, P: 3, TD: 4, DIV: 5 }[el.tagName] ?? 6);
          return a.calidad - b.calidad
            || prioridad(a.el) - prioridad(b.el)
            || a.el.childElementCount - b.el.childElementCount
            || a.t.length - b.t.length;
        });

      if (!nodos.length) return null;
      const etiquetaEl = nodos[0].el;

      const describir = (el) => el ? {
        id: el.id || '',
        name: el.getAttribute('name') || '',
        tag: el.tagName,
        type: el.getAttribute('type') || ''
      } : null;

      if (etiquetaEl.tagName === 'LABEL' && etiquetaEl.htmlFor) {
        const asociado = document.getElementById(etiquetaEl.htmlFor);
        if (asociado && esVisible(asociado)) return describir(asociado);
      }

      const dentro = etiquetaEl.querySelector?.('input:not([type="hidden"]),select,textarea');
      if (dentro && esVisible(dentro)) return describir(dentro);
      let hermano = etiquetaEl.nextElementSibling;
      while (hermano) {
        if (hermano.matches?.('input:not([type="hidden"]),select,textarea') && esVisible(hermano)) return describir(hermano);
        const interno = hermano.querySelector?.('input:not([type="hidden"]),select,textarea');
        if (interno && esVisible(interno)) return describir(interno);
        hermano = hermano.nextElementSibling;
      }

      const lb = etiquetaEl.getBoundingClientRect();
      const controles = [...document.querySelectorAll('input:not([type="hidden"]),select,textarea')]
        .filter(esVisible)
        .filter((el) => !el.disabled && !el.readOnly)
        .map((el) => {
          const r = el.getBoundingClientRect();
          const dy = r.top - lb.bottom;
          const dx = r.left - lb.left;
          let score = Math.abs(dy) * 8 + Math.abs(dx);
          if (dy < -28 || dy > 100) score += 10000;
          if (r.right < lb.left - 20) score += 5000;
          if (el.parentElement === etiquetaEl.parentElement) score -= 1000;
          if (etiquetaEl.parentElement?.contains(el)) score -= 700;
          return { el, score };
        })
        .sort((a, b) => a.score - b.score);

      const elegido = controles[0]?.el;
      if (!elegido || controles[0].score >= 10000) return null;
      return describir(elegido);
    }, { etiqueta });

    if (!descriptor) {
      throw new Error(`No se encontró el control cercano a la etiqueta: ${etiqueta}`);
    }
    if (descriptor.id) return this.page.locator(`[id="${descriptor.id.replace(/"/g, '\\"')}"]`).first();
    if (descriptor.name) return this.page.locator(`[name="${descriptor.name.replace(/"/g, '\\"')}"]`).first();
    throw new Error(`Se encontró el campo ${etiqueta}, pero no tiene id ni name. Ejecuta npm run diagnostico.`);
  }

  async #valorActual(locator) {
    return locator.evaluate((el) => {
      if (el.tagName.toUpperCase() === 'SELECT') {
        const option = el.options?.[el.selectedIndex];
        return {
          value: String(el.value || '').trim(),
          text: String(option?.textContent || '').trim(),
          tag: 'SELECT'
        };
      }
      return {
        value: String(el.value || '').trim(),
        text: String(el.value || '').trim(),
        tag: el.tagName.toUpperCase()
      };
    });
  }

  #esVacioActual(actual) {
    const texto = normalizar(actual?.text || actual?.value || '');
    return !texto || [
      'SELECCIONE',
      'SELECCIONAR',
      'SELECCION',
      'SEL',
      'NINGUNO',
      'SIN SELECCION'
    ].includes(texto);
  }

  async #seleccionarOption(locator, valor, etiqueta) {
  const etiquetaNormalizada = normalizar(etiqueta);
  const valorOriginal = String(valor ?? '').trim();
  const valorNormalizado = normalizar(valorOriginal);

  const mapaDocumento = {
    CC: 'CC',
    'CEDULA DE CIUDADANIA CC': 'CC',

    TI: 'TI',
    'TARJETA DE IDENTIDAD TI': 'TI',

    CE: 'CE',
    'CEDULA DE EXTRANJERIA CE': 'CE',

    PPT: 'PPT',
    'PERMISO DE PROTECCION TEMPORAL PPT': 'PPT',

    PASAPORTE: 'PASAPORTE'
  };

  const equivalencias = {
    TIPO: mapaDocumento,
    'TIPO DE DOCUMENTO': mapaDocumento,

    GENERO: {
      MASCULINO: 'MASCULINO',
      FEMENINO: 'FEMENINO',

      // En la página se llama Otro,
      // pero Biofile lo llama Indeterminado.
      OTRO: 'INDETERMINADO',
      INDETERMINADO: 'INDETERMINADO'
    },

    'ESTADO CIVIL': {
      'SOLTERO A': 'SOLTERO(A)',
      'CASADO A': 'CASADO(A)',
      'UNION LIBRE': 'UNIÓN LIBRE',
      'SEPARADO A': 'SEPARADO(A)',
      'DIVORCIADO A': 'DIVORCIADO(A)',
      'VIUDO A': 'VIUDO(A)'
    },

    'NIVEL EDUCATIVO': {
      NINGUNO: 'SIN ESTUDIO',
      'SIN ESTUDIO': 'SIN ESTUDIO',

      PREESCOLAR: 'PRE-ESCOLAR',
      'PRE ESCOLAR': 'PRE-ESCOLAR',

      PRIMARIA: 'PRIMARIA',

      // Esta es la equivalencia que corrige tu error actual.
      BACHILLERATO: 'SECUNDARIA',
      SECUNDARIA: 'SECUNDARIA',

      TECNICO: 'TÉCNICO',
      TECNOLOGO: 'TECNÓLOGO',
      UNIVERSITARIO: 'UNIVERSITARIO',

      POSGRADO: 'POSTGRADO',
      POSTGRADO: 'POSTGRADO',

      DOCTORADO: 'DOCTORADO'
    }
  };

  const mapaCampo = equivalencias[etiquetaNormalizada] || {};

  const valorBiofile =
    mapaCampo[valorNormalizado] ||
    valorOriginal;

  const opciones = await locator
    .locator('option')
    .evaluateAll((elementos) =>
      elementos.map((opcion) => ({
        value: opcion.value,
        text: String(opcion.textContent || '').trim()
      }))
    );

  const objetivo = normalizar(valorBiofile);

  // Primero busca una coincidencia exacta.
  let opcion = opciones.find(
    (item) => normalizar(item.text) === objetivo
  );

  // Después intenta una coincidencia parcial.
  if (!opcion) {
    opcion = opciones.find((item) => {
      const textoOpcion = normalizar(item.text);

      return (
        textoOpcion.includes(objetivo) ||
        objetivo.includes(textoOpcion)
      );
    });
  }

  if (!opcion) {
    throw new Error(
      `No existe la opción "${valorOriginal}" en el campo ${etiqueta}. ` +
      `Valor convertido para Biofile: "${valorBiofile}". ` +
      `Opciones disponibles: ${opciones
        .map((item) => item.text)
        .filter(Boolean)
        .join(' | ')}`
    );
  }

  await locator.selectOption(opcion.value);
  await this.page.waitForTimeout(200);

  if (normalizar(valorOriginal) !== normalizar(valorBiofile)) {
    this.logger?.info('Valor convertido para Biofile.', {
      campo: etiqueta,
      valorGoogleSheets: valorOriginal,
      valorBiofile,
      opcionSeleccionada: opcion.text
    });
  }
}

  async #seleccionarCiudadNacimiento(locator, valor, etiqueta) {
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

  async #esperarProcesamientoBiofile(timeoutMs = 7000) {
    const limite = Date.now() + timeoutMs;
    let vioProcesamiento = false;
    while (Date.now() < limite) {
      const ocupado = await this.page.evaluate(() => {
        const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        return [...document.querySelectorAll('div,span,p,td')].some((el) => {
          if (!visible(el)) return false;
          const t = String(el.textContent || '').trim().replace(/\s+/g, ' ');
          return t.length <= 90 && /^(procesando datos|procesando|cargando)(\.{0,3})$/i.test(t);
        });
      }).catch(() => false);
      if (!ocupado) {
        if (vioProcesamiento) await this.page.waitForTimeout(180);
        return;
      }
      vioProcesamiento = true;
      await this.page.waitForTimeout(120);
    }
    this.logger?.warn('BIOFILE continuó mostrando procesamiento; se validarán estrictamente los campos.');
  }

  async #seleccionarAutocompletado(locator, valor, etiqueta) {
    const valorOriginal = String(valor ?? '').trim();
    if (!valorOriginal) throw new Error(`El valor para ${etiqueta} está vacío.`);

    const campoNormalizado = normalizar(etiqueta);
    /* RELACION_EMPRESA_BIOFILE_V69B_BIOFILE */
    if (campoNormalizado === 'CIUDAD DE NACIMIENTO') {
      await this.#seleccionarCiudadNacimiento(locator, valorOriginal, etiqueta);
      return;
    }

    const valorNormalizado = normalizar(valorOriginal);
    const textoBusqueda = textoBusquedaAutocomplete(etiqueta, valorOriginal);

    // Son los elementos azules que se ven en el video de Órdenes. Se busca
    // por texto normalizado porque BIOFILE mezcla tildes y espacios internos.
    const selectorOpciones = [
      '.autocomplete_completionListElement:visible > *:visible',
      '.ajax__autocomplete_item:visible',
      '.ajax__autocomplete_highlighted_item:visible',
      '[id*="completionList" i]:visible > *:visible',
      '[role="listbox"]:visible [role="option"]:visible',
      'ul.ui-autocomplete:visible li:visible',
      '.autocomplete-suggestions:visible .autocomplete-suggestion:visible',
      '.tt-menu:visible .tt-suggestion:visible'
    ].join(', ');

    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.waitFor({ state: 'visible', timeout: 10000 });
    await locator.evaluate((elemento) => {
      elemento.setAttribute('autocomplete', 'off');
      elemento.setAttribute('autocorrect', 'off');
      elemento.setAttribute('spellcheck', 'false');
    }).catch(() => {});

    let seleccionConfirmada = false;
    let opcionSeleccionada = '';
    const opcionesVistas = [];

    const seleccionarVisibleExacta = async (timeoutMs) => {
      const limite = Date.now() + timeoutMs;
      while (Date.now() < limite) {
        const candidatos = this.page.locator(selectorOpciones);
        const cantidad = await candidatos.count();
        for (let indice = 0; indice < cantidad; indice += 1) {
          const candidato = candidatos.nth(indice);
          if (!await candidato.isVisible().catch(() => false)) continue;
          const texto = String(await candidato.innerText().catch(() => ''))
            .trim().replace(/\s+/g, ' ');
          if (texto && !opcionesVistas.includes(texto)) opcionesVistas.push(texto);
          if (normalizar(texto) !== valorNormalizado) continue;
          await candidato.click({ force: true });
          opcionSeleccionada = texto;
          await this.page.waitForTimeout(300);
          return true;
        }

        // Respaldo para variantes de AjaxControlToolkit que no conservan las
        // clases habituales: limita la búsqueda al menú de autocompletado y
        // marca el elemento hoja cuyo texto normalizado sea exactamente igual.
        const marca = `biofile-opcion-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const textoDom = await this.page.evaluate(({ esperado, marca }) => {
          const norm = (valor) => String(valor || '')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9]+/g, ' ').trim().toUpperCase();
          const visible = (el) => Boolean(el &&
            (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
          const candidatos = [...document.querySelectorAll('div,li,td,span,a')]
            .filter(visible)
            .filter((el) => norm(el.textContent) === esperado)
            .filter((el) => {
              const propio = `${el.id || ''} ${el.className || ''} ${el.getAttribute('role') || ''}`;
              const padre = el.closest('[class*="autocomplete" i],[id*="completion" i],\n' +
                '[role="listbox"],[class*="suggestion" i]');
              return /autocomplete|completion|option|suggestion/i.test(propio) || Boolean(padre);
            })
            .sort((a, b) => a.childElementCount - b.childElementCount ||
              (a.getBoundingClientRect().width * a.getBoundingClientRect().height) -
              (b.getBoundingClientRect().width * b.getBoundingClientRect().height));
          const elegido = candidatos[0];
          if (!elegido) return '';
          elegido.setAttribute('data-biofile-opcion-exacta', marca);
          return String(elegido.textContent || '').trim().replace(/\s+/g, ' ');
        }, { esperado: valorNormalizado, marca }).catch(() => '');
        if (textoDom) {
          const candidatoDom = this.page.locator(
            `[data-biofile-opcion-exacta="${marca}"]`
          ).first();
          await candidatoDom.click({ force: true });
          opcionSeleccionada = textoDom;
          if (!opcionesVistas.includes(textoDom)) opcionesVistas.push(textoDom);
          await this.page.waitForTimeout(300);
          return true;
        }
        await this.page.waitForTimeout(120);
      }
      return false;
    };

    const intentos = [
      { nombre: 'búsqueda corta', texto: textoBusqueda, espera: 3500 }
    ];
    if (normalizar(textoBusqueda) !== valorNormalizado) {
      intentos.push({ nombre: 'texto exacto', texto: valorOriginal, espera: 3500 });
    }

    for (const intento of intentos) {
      await locator.click({ clickCount: 3 }).catch(() => {});
      await locator.fill('');
      await locator.click().catch(() => {});
      if (intento.texto) {
        await locator.pressSequentially(intento.texto, { delay: 45 });
      } else {
        await locator.evaluate((elemento) => {
          elemento.focus();
          elemento.dispatchEvent(new Event('input', { bubbles: true }));
          elemento.dispatchEvent(new KeyboardEvent('keyup', {
            bubbles: true, key: 'ArrowDown', code: 'ArrowDown'
          }));
        }).catch(() => {});
      }
      seleccionConfirmada = await seleccionarVisibleExacta(intento.espera);
      if (seleccionConfirmada) break;
      this.logger?.warn('BIOFILE no mostró todavía la opción exacta; se intentará otra búsqueda.', {
        campo: etiqueta,
        intento: intento.nombre,
        textoEscrito: intento.texto,
        opcionesVistas: opcionesVistas.slice(-12)
      });
    }

    if (!seleccionConfirmada) {
      throw new Error(
        `BIOFILE no mostró la opción exacta "${valorOriginal}" para el campo ${etiqueta}. ` +
        `Opciones visibles: ${opcionesVistas.slice(-12).join(' | ') || 'ninguna'}.`
      );
    }

    const valorFinal = String(await locator.inputValue().catch(() => '')).trim();
    if (normalizar(valorFinal) !== valorNormalizado) {
      throw new Error(
        `BIOFILE seleccionó un valor incorrecto en ${etiqueta}. ` +
        `Esperado: "${valorOriginal}". Resultado: "${valorFinal}".`
      );
    }

    await locator.evaluate((elemento) => {
      elemento.dispatchEvent(new Event('input', { bubbles: true }));
      elemento.dispatchEvent(new Event('change', { bubbles: true }));
      elemento.dispatchEvent(new Event('blur', { bubbles: true }));
    }).catch(() => {});
    this.logger?.info('Opción exacta de autocompletado seleccionada.', {
      campo: etiqueta,
      textoEscrito: textoBusqueda,
      opcionSeleccionada: opcionSeleccionada || valorFinal,
      valorFinal
    });
  }

async #escribirEnControl(
  locator,
  valor,
  etiqueta,
  { autocomplete = false } = {}
) {
  const tag = await locator.evaluate(
    (elemento) => elemento.tagName.toUpperCase()
  );

  if (tag === 'SELECT') {
    await this.#seleccionarOption(locator, valor, etiqueta);
    return;
  }

  if (autocomplete) {
    await this.#seleccionarAutocompletado(
      locator,
      valor,
      etiqueta
    );
    return;
  }

  await locator.click({ clickCount: 3 }).catch(() => {});
  await locator.fill(String(valor));
}

  async #llenar(fieldKey, etiqueta, valor, { autocomplete = false, opcional = false } = {}) {
    await activity('Diligenciando ' + etiqueta, { campo: fieldKey, selector: this.config.selectors[fieldKey] || etiqueta });
    const v = String(valor ?? '').trim();
    if (!v && opcional) return { accion: 'omitido' };
    if (!v) throw new Error(`El valor para ${etiqueta} está vacío.`);

    const locator = await this.#controlCercaDeEtiqueta(fieldKey, etiqueta);
    await this.#escribirEnControl(locator, v, etiqueta, { autocomplete });
    await activity(etiqueta + ' confirmado', { ultimoPasoEjecutado: etiqueta, campo: fieldKey });
    return { accion: 'llenado', valor: v };
  }

  async #llenarSoloSiFalta(fieldKey, etiqueta, valor, { autocomplete = false, opcional = false } = {}) {
    await activity('Verificando ' + etiqueta, { campo: fieldKey });
    const locator = await this.#controlCercaDeEtiqueta(fieldKey, etiqueta);
    const actual = await this.#valorActual(locator);

    if (!this.#esVacioActual(actual)) {
      this.logger?.info('Se conserva el dato existente del paciente.', {
        campo: etiqueta,
        valorActual: actual.text || actual.value
      });
      return { accion: 'conservado', valor: actual.text || actual.value };
    }

    const v = String(valor ?? '').trim();
    if (!v && opcional) {
      this.logger?.info('Campo opcional vacío; se deja sin modificar.', { campo: etiqueta });
      return { accion: 'omitido' };
    }
    if (!v) {
      throw new Error(`El campo ${etiqueta} está vacío en Biofile y tampoco tiene valor en Google Sheets ni valor predeterminado.`);
    }

    await this.#escribirEnControl(locator, v, etiqueta, { autocomplete });
    await activity(etiqueta + ' confirmado', { ultimoPasoEjecutado: etiqueta, campo: fieldKey });
    return { accion: 'completado', valor: v };
  }

  async #estadoPaciente() {
    const definiciones = [
      ['primerApellido', 'Primer Apellido'],
      ['primerNombre', 'Primer Nombre'],
      ['fechaNacimiento', 'Fecha de Nacimiento'],
      ['ciudadNacimiento', 'Ciudad de Nacimiento'],
      ['direccion', 'Dirección']
    ];

    const estado = {};
    for (const [fieldKey, etiqueta] of definiciones) {
      try {
        const locator = await this.#controlCercaDeEtiqueta(fieldKey, etiqueta);
        const actual = await this.#valorActual(locator);
        estado[fieldKey] = this.#esVacioActual(actual) ? '' : (actual.text || actual.value);
      } catch {
        estado[fieldKey] = '';
      }
    }
    return estado;
  }

  async #ingresarDocumentoYDetectarPaciente(r) {
    await this.#llenar('tipoDocumento', 'Tipo', r.tipoDocumento);
    await this.#llenar('numeroDocumento', 'N°. de Identificación', r.numeroDocumento);

    const documento = await this.#controlCercaDeEtiqueta('numeroDocumento', 'N°. de Identificación');

    // Biofile normalmente consulta al paciente al salir del campo de identificación.
    await documento.press('Tab').catch(() => {});
    await documento.evaluate((el) => {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }).catch(() => {});

    const limite = Date.now() + this.config.biofile.esperaPacienteMs;
    let estado = await this.#estadoPaciente();
    let cargados = Object.entries(estado).filter(([, valor]) => Boolean(valor));

    while (Date.now() < limite && cargados.length < 2) {
      await this.page.waitForTimeout(300);
      estado = await this.#estadoPaciente();
      cargados = Object.entries(estado).filter(([, valor]) => Boolean(valor));
    }

    const pacienteExistente = cargados.length >= 2
      || (Boolean(estado.primerApellido) && Boolean(estado.primerNombre))
      || (Boolean(estado.primerNombre) && Boolean(estado.fechaNacimiento));

    this.pacienteExistenteActual = pacienteExistente;

    if (pacienteExistente) {
      this.logger?.info('Paciente existente detectado en Biofile. Se conservarán sus datos y solo se completarán los campos vacíos.', {
        documento: r.numeroDocumento,
        camposDetectados: cargados.map(([campo]) => campo)
      });
    } else {
      this.logger?.info('No se detectaron datos previos del paciente. Se llenará el formulario completo desde Google Sheets.', {
        documento: r.numeroDocumento
      });
    }

    return pacienteExistente;
  }

  async llenarOrden(r, defaults) {
    this.logger?.info('Llenando formulario.', { documento: r.numeroDocumento, fila: r.row });

    const pacienteExistente = await this.#ingresarDocumentoYDetectarPaciente(r);
    const llenarPaciente = pacienteExistente
      ? this.#llenarSoloSiFalta.bind(this)
      : this.#llenar.bind(this);

    await llenarPaciente('ciudadNacimiento', 'Ciudad de Nacimiento', r.ciudadNacimiento, { autocomplete: true });
    await llenarPaciente('fechaNacimiento', 'Fecha de Nacimiento', r.fechaNacimiento);
    await llenarPaciente('primerApellido', 'Primer Apellido', r.primerApellido);
    await llenarPaciente('segundoApellido', 'Segundo Apellido', r.segundoApellido, { opcional: true });
    await llenarPaciente('primerNombre', 'Primer Nombre', r.primerNombre);
    await llenarPaciente('otrosNombres', 'Otros Nombres', r.otrosNombres, { opcional: true });
    await llenarPaciente('genero', 'Género', r.genero);
    await llenarPaciente('estadoCivil', 'Estado Civil', r.estadoCivil);
    await llenarPaciente('nivelEducativo', 'Nivel Educativo', r.nivelEducativo);
    await llenarPaciente('correo', 'Correo Electrónico', r.correo, { opcional: true });

    /*
     * La columna Zona puede contener temporalmente una localidad de Bogotá,
     * por ejemplo FONTIBÓN, debido a la compatibilidad con el formulario
     * anterior. BIOFILE solo acepta URBANA o RURAL en este selector.
     *
     * Si el valor recibido no es una zona válida, se utiliza DEFAULT_ZONA
     * y la localidad se aplica posteriormente en aplicarDatosRegistroBiofile.
     */
    const zonaOrigen = String(r.zona || '').trim();
    const zonaNormalizada = normalizar(zonaOrigen);

    const zonaPredeterminadaNormalizada = normalizar(
      defaults.zona || 'URBANA'
    );

    const zonaPredeterminada =
      zonaPredeterminadaNormalizada.startsWith('RURAL')
        ? 'RURAL'
        : 'URBANA';

    const zona = zonaNormalizada.startsWith('URBANA')
      ? 'URBANA'
      : zonaNormalizada.startsWith('RURAL')
        ? 'RURAL'
        : zonaPredeterminada;

    if (
      zonaOrigen &&
      !zonaNormalizada.startsWith('URBANA') &&
      !zonaNormalizada.startsWith('RURAL')
    ) {
      this.logger?.info(
        'El valor recibido en Zona corresponde a una localidad; se usará la zona predeterminada.',
        {
          valorRecibido: zonaOrigen,
          zonaAplicada: zona
        }
      );
    }

    await llenarPaciente('zona', 'Zona', zona);

    await llenarPaciente('direccion', 'Dirección', r.direccion);
    await llenarPaciente('barrio', 'Barrio', r.barrio, { opcional: true });
    await llenarPaciente(
  'localidad',
  'Localidad',
  defaults.localidad || 'CHAPINERO'
);

// Verificación obligatoria de la localidad.
const controlLocalidad =
  await this.#controlCercaDeEtiqueta(
    'localidad',
    'Localidad'
  );

let localidadActual =
  await this.#valorActual(controlLocalidad);

if (this.#esVacioActual(localidadActual)) {
  this.logger?.warn(
    'La localidad continuaba vacía. Se seleccionará nuevamente.',
    {
      valor: defaults.localidad || 'CHAPINERO'
    }
  );

  await this.#seleccionarOption(
    controlLocalidad,
    defaults.localidad || 'CHAPINERO',
    'Localidad'
  );

  localidadActual =
    await this.#valorActual(controlLocalidad);
}

if (this.#esVacioActual(localidadActual)) {
  throw new Error(
    'No fue posible seleccionar la localidad CHAPINERO.'
  );
}

this.logger?.info(
  'Localidad verificada correctamente.',
  {
    localidad:
      localidadActual.text ||
      localidadActual.value
  }
);

    // La sede corresponde a la orden actual, por eso siempre se aplica el valor configurado.
    await this.#llenar('sede', 'Sede', defaults.sede);

    await llenarPaciente('estrato', 'Estrato', r.estrato);
    // Biofile ya carga por defecto:
// BOGOTÁ (BOGOTÁ D.C., COLOMBIA)
// No se modifica para conservar su código interno.

if (r.municipioResidencia) await llenarPaciente('municipio', 'Municipio', r.municipioResidencia, { autocomplete: true });
    await llenarPaciente('celular', 'Celulares', r.celular, { opcional: true });
    await llenarPaciente('telefono', 'Teléfonos', r.telefono, { opcional: true });

    const profesionCargo = String(
  r.profesionCargo || ''
).trim() || 'NO REFIERE';

const funcionesCargo = String(
  r.funcionesCargo || ''
).trim() || profesionCargo;

await llenarPaciente(
  'profesionCargo',
  'Profesión o Cargo',
  profesionCargo
);

await llenarPaciente(
  'funcionesCargo',
  'Funciones del Cargo',
  funcionesCargo
);

    // Estos datos pertenecen a la orden actual y deben quedar con los valores definidos.
    await this.#llenar('tipoEvaluacion', 'Tipo de Evaluación Médica o Procedimiento', defaults.tipoEvaluacion, { autocomplete: true });

    const acuerdoSolicitado = String(defaults.acuerdo || '').trim();
    const misionSolicitada = String(defaults.empresaMision || '').trim();
    const acuerdoFallback = String(defaults.acuerdoFallback || 'PARTICULARES').trim();
    const misionFallback = String(defaults.empresaMisionFallback || 'PARTICULARES').trim();
    let relacionEmpresaAplicada = {
      acuerdo: acuerdoSolicitado,
      empresaMision: misionSolicitada,
      fallback: false,
      fuente: 'catalogo-excel'
    };

    try {
      await this.#esperarProcesamientoBiofile();
      await this.#llenar('acuerdoComercial', 'Nombre del Acuerdo Comercial, Contrato o Convenio', acuerdoSolicitado, { autocomplete: true });
      await this.#esperarProcesamientoBiofile();
      await this.#llenar('empresaMision', 'Nombre de la Empresa en Misión', misionSolicitada, { autocomplete: true });
      await this.#esperarProcesamientoBiofile();
    } catch (errorRelacion) {
      if (defaults.strictCompany) throw errorRelacion;
      const yaEraFallback = normalizar(acuerdoSolicitado) === normalizar(acuerdoFallback) &&
        normalizar(misionSolicitada) === normalizar(misionFallback);
      if (yaEraFallback) throw errorRelacion;

      this.logger?.warn('La relación empresarial exacta no pudo seleccionarse; se usará PARTICULARES.', {
        acuerdoSolicitado,
        misionSolicitada,
        error: errorRelacion.message
      });

      await this.#esperarProcesamientoBiofile();
      await this.#llenar('acuerdoComercial', 'Nombre del Acuerdo Comercial, Contrato o Convenio', acuerdoFallback, { autocomplete: true });
      await this.#esperarProcesamientoBiofile();
      await this.#llenar('empresaMision', 'Nombre de la Empresa en Misión', misionFallback, { autocomplete: true });
      await this.#esperarProcesamientoBiofile();

      relacionEmpresaAplicada = {
        acuerdo: acuerdoFallback,
        empresaMision: misionFallback,
        fallback: true,
        fuente: 'fallback-error-biofile',
        errorOriginal: errorRelacion.message
      };
    }

    await this.#llenar('paquete', 'Nombre del Paquete', defaults.paquete, { autocomplete: true });
    await this.#llenar('eps', 'Eps', r.eps || defaults.eps);
    await this.#llenar('afp', 'Afp', r.afp || defaults.afp);
    await this.#llenar('arl', 'Arl', r.arl || defaults.arl);
    await this.#llenar('diagnostico', 'Diagnóstico CIE-10', defaults.diagnostico);
    await this.#llenar('tipoVinculacion', 'Tipo de vinculación', defaults.tipoVinculacion);
    await this.#llenar('tipoAfiliado', 'Tipo Afiliado', defaults.tipoAfiliado);
    await this.#llenar('nivel', 'Nivel', defaults.nivel);

    if (defaults.productoServicio) {
      await this.#llenarProductoInferior(defaults);
    }

    return { pacienteExistente, relacionEmpresa: relacionEmpresaAplicada };
  }

  async abrirOrdenExistente(numeroOrden, documentoEsperado) {
    await this.abrirOrdenNueva();
    const { orderSearchInput, orderSearchButton } = this.config.selectors;
    const input = orderSearchInput
      ? this.page.locator(orderSearchInput).first()
      : await this.#controlCercaDeEtiqueta('numeroOrden', 'N°. O.S.');
    await input.waitFor({ state:'visible', timeout:10000 });
    await input.click({ clickCount:3 }).catch(()=>{});
    await input.fill(String(numeroOrden));

    let button;
    if (orderSearchButton) button=this.page.locator(orderSearchButton).first();
    else button=await this.#accion('buscar','Buscar');
    await button.click();

    const until=Date.now()+15000;
    while(Date.now()<until){
      const actual=String(await this.obtenerNumeroOrden()).trim();
      if(actual===String(numeroOrden)) break;
      await this.page.waitForTimeout(250);
    }
    if (String(await this.obtenerNumeroOrden()) !== String(numeroOrden)) throw new Error('BIOFILE no permitió reabrir la O.S. '+numeroOrden+'. No se creará otra orden.');
    const field = await this.#controlCercaDeEtiqueta('numeroDocumento', 'N°. de Identificación');
    if (String(await field.inputValue()).replace(/[^a-z0-9]/gi,'') !== String(documentoEsperado).replace(/[^a-z0-9]/gi,'')) throw new Error('La orden recuperada pertenece a otro documento.');
  }

  async seleccionarProductoExacto(locator, value) { return this.#seleccionarAutocompletado(locator, value, 'Nombre del Producto o Servicio'); }

  async #llenarProductoInferior(defaults) {
    const fila = this.page.locator('table tr').filter({ has: this.page.getByText(/Nombre del Producto o Servicio/i) }).locator('xpath=following-sibling::tr[1]');
    if (!await visible(fila)) {
      this.logger?.warn('No se encontró la fila inferior de productos. Se continuará sin llenarla.');
      return;
    }
    const controles = fila.locator('input,select,textarea');
    const n = await controles.count();
    if (n < 2) return;
    if (defaults.cantidad) await controles.nth(0).fill(defaults.cantidad).catch(() => {});
    await controles.nth(1).fill(defaults.productoServicio).catch(() => {});
    await controles.nth(1).press('ArrowDown').catch(() => {});
    await controles.nth(1).press('Enter').catch(() => {});
  }

  async #accion(fieldKey, nombre) {
    const override = this.config.selectors[fieldKey];
    if (override) {
      const loc = this.page.locator(override).first();
      if (await visible(loc)) return loc;
    }

    let loc = this.page.getByText(new RegExp(`^${escapeRegex(nombre)}$`, 'i')).first();
    if (await visible(loc)) return loc;
    loc = this.page.getByRole('button', { name: new RegExp(nombre, 'i') }).first();
    if (await visible(loc)) return loc;
    loc = this.page.locator(`input[value*="${nombre}" i], [title*="${nombre}" i], [alt*="${nombre}" i]`).first();
    if (await visible(loc)) return loc;
    throw new Error(`No se encontró la acción: ${nombre}`);
  }

  async guardarYCerrarExito() {
    checkCancelled();
    /* GUARDADO_CONFIRMADO_V6 */
    const guardar = await this.#accion('guardar', 'Guardar');
    await guardar.click();

    const exito = this.page.getByText(/Registro guardado con éxito/i).first();
    try {
      await exito.waitFor({ state: 'visible', timeout: this.config.browser.timeout });
    } catch {
      const captura = await this.captura('error-guardar');
      const textos = await this.page.locator('body').innerText().catch(() => '');
      const posibles = textos.split('\n').filter((t) => /obligatorio|requerido|seleccione|error/i.test(t)).slice(0, 20);
      throw new Error(`Biofile no confirmó el guardado. Revisa ${captura}. Mensajes: ${posibles.join(' | ')}`);
    }

    // Desde este punto BIOFILE confirmó que el registro fue guardado.
    // Un fallo visual al cerrar NO puede convertir un guardado real en un ERROR reintentable.
    let cerrado = false;
    try {
      const cerrar = await this.#accion('cerrarExito', 'Cerrar');
      await cerrar.click();
      await this.page.waitForTimeout(700);
      cerrado = true;
    } catch (error) {
      this.logger?.warn('BIOFILE confirmó el guardado, pero no fue posible cerrar el mensaje de éxito. Se conserva el guardado como válido.', {
        error: error.message
      });
    }

    return { guardadoConfirmado: true, cerrado };
  }

  async obtenerNumeroOrden() {
    try {
      const control = await this.#controlCercaDeEtiqueta('numeroOrden', 'N°. O.S.');
      return String(await control.inputValue()).trim();
    } catch {
      return '';
    }
  }

  async #subirArchivo(fieldKey, textoBoton, archivo) {
  /*
   * Biofile usa controles input[type="file"] transparentes.
   * No es necesario pulsar el botón visual ni abrir manualmente
   * el selector de archivos.
   */
  const selectoresArchivo = {
    subirFoto: 'input[type="file"][id*="AsyncFuFoto"]',
    subirFirma: 'input[type="file"][id*="AsyncFuFirma"]'
  };

  const selector =
    this.config.selectors[fieldKey] ||
    selectoresArchivo[fieldKey];

  if (!selector) {
    throw new Error(
      `No existe selector de archivo para ${textoBoton}.`
    );
  }

  const inputArchivo = this.page.locator(selector).first();

  if (await inputArchivo.count() === 0) {
    throw new Error(
      `No se encontró el input de archivo para ${textoBoton}. ` +
      `Selector utilizado: ${selector}`
    );
  }

  const selectorVistaPrevia =
    fieldKey === 'subirFoto'
      ? '#ImgFoto'
      : fieldKey === 'subirFirma'
        ? '#ImgFirma'
        : '';

  let srcAnterior = '';

  if (selectorVistaPrevia) {
    srcAnterior = String(
      await this.page
        .locator(selectorVistaPrevia)
        .getAttribute('src')
        .catch(() => '')
    );
  }

  this.logger?.info(
    `Asignando archivo al control ${textoBoton}.`,
    {
      selector,
      nombre: archivo.name,
      tipo: archivo.mimeType,
      bytes: archivo.buffer?.length || 0
    }
  );

  /*
   * setInputFiles funciona aunque el input tenga opacity: 0.
   * Playwright entrega directamente el contenido descargado en RAM.
   */
  await inputArchivo.setInputFiles(archivo);

  /*
   * Esperar a que Biofile procese el archivo y cambie
   * la imagen mostrada.
   */
  if (selectorVistaPrevia) {
    await this.page.waitForFunction(
      ({ selectorImagen, srcInicial }) => {
        const imagen = document.querySelector(selectorImagen);

        if (!imagen) {
          return false;
        }

        const srcActual =
          imagen.getAttribute('src') || '';

        return (
          srcActual &&
          srcActual !== srcInicial
        );
      },
      {
        selectorImagen: selectorVistaPrevia,
        srcInicial: srcAnterior
      },
      {
        timeout: 10000
      }
    ).catch(() => {
      // Algunos controles cargan el archivo sin cambiar inmediatamente
      // la URL de la vista previa.
    });
  }

  await this.page.waitForTimeout(800);

  this.logger?.info(
    `${textoBoton} cargado correctamente en Biofile.`,
    {
      nombre: archivo.name
    }
  );
}

  async subirFotoFirma(registro) {
  if (!registro.fotoUrl) {
    throw new Error(
      `La fila ${registro.row} no contiene enlace de fotografía.`
    );
  }

  if (!registro.firmaUrl) {
    throw new Error(
      `La fila ${registro.row} no contiene enlace de firma.`
    );
  }

  this.logger?.info(
    'Descargando fotografía temporalmente desde Google Drive.',
    {
      documento: registro.numeroDocumento,
      almacenamiento: 'memoria RAM'
    }
  );

  const foto = await descargarArchivoEnMemoria(
    registro.fotoUrl,
    `foto-${registro.numeroDocumento}`
  );

  this.logger?.info('Fotografía descargada. Subiendo a Biofile.', {
    nombre: foto.name,
    tipo: foto.mimeType,
    bytes: foto.buffer.length
  });

  await this.#subirArchivo(
    'subirFoto',
    'Subir foto',
    foto
  );

  await this.page.waitForTimeout(1000);

  this.logger?.info(
    'Descargando firma temporalmente desde Google Drive.',
    {
      documento: registro.numeroDocumento,
      almacenamiento: 'memoria RAM'
    }
  );

  const firma = await descargarArchivoEnMemoria(
    registro.firmaUrl,
    `firma-${registro.numeroDocumento}`
  );

  this.logger?.info('Firma descargada. Subiendo a Biofile.', {
    nombre: firma.name,
    tipo: firma.mimeType,
    bytes: firma.buffer.length
  });

  await this.#subirArchivo(
    'subirFirma',
    'Subir firma',
    firma
  );

  await this.page.waitForTimeout(1000);

  this.logger?.info(
    'Fotografía y firma cargadas correctamente en Biofile.',
    {
      documento: registro.numeroDocumento
    }
  );
}
  async diagnostico() {
    const datos = await this.page.evaluate(() => {
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      return [...document.querySelectorAll('input,select,textarea,button,a')]
        .filter(visible)
        .map((el, index) => ({
          index,
          tag: el.tagName,
          id: el.id || '',
          name: el.getAttribute('name') || '',
          type: el.getAttribute('type') || '',
          value: el.value || '',
          text: (el.innerText || el.getAttribute('value') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 160),
          placeholder: el.getAttribute('placeholder') || '',
          title: el.getAttribute('title') || '',
          className: typeof el.className === 'string' ? el.className : ''
        }));
    });

    asegurarDirectorio(this.config.paths.logs);
    const jsonPath = path.join(this.config.paths.logs, `diagnostico-${fechaArchivo()}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(datos, null, 2), 'utf8');
    const captura = await this.captura('diagnostico-formulario');
    return { jsonPath, captura, cantidad: datos.length };
  }
}
