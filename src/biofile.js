import fs from 'node:fs';
import path from 'node:path';
import { descargarArchivoEnMemoria } from './drive.js';
import { asegurarDirectorio, fechaArchivo, normalizar } from './util.js';
import {
  construirUrlMetodoAutocomplete,
  extraerOpcionesAutocomplete,
  limpiarOpcionesCatalogo
} from './autocomplete-biofile.js';

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


function separarCiudadNacimiento(valor) {
  const original = String(valor ?? '')
    .trim()
    .replace(/\s+/g, ' ');

  if (!original) {
    return {
      original: '',
      municipio: '',
      departamento: '',
      pais: '',
      opcionEsperada: ''
    };
  }

  // Formato principal guardado por el formulario:
  // LA DORADA (CALDAS, COLOMBIA)
  const conParentesis = original.match(
    /^(.+?)\s*\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)$/
  );

  if (conParentesis) {
    const municipio = conParentesis[1].trim();
    const departamento = conParentesis[2].trim();
    const pais = conParentesis[3].trim();

    /*
     * BIOFILE nombra la opción de Bogotá así:
     *
     * BOGOTÁ (BOGOTÁ D.C., COLOMBIA)
     *
     * El formulario puede guardar:
     *
     * BOGOTÁ D.C. (BOGOTÁ D.C., COLOMBIA)
     *
     * Ambos representan el mismo lugar, pero el texto exacto es distinto.
     * Se convierte al nombre real mostrado por BIOFILE antes de buscarlo.
     */
    const municipioNormalizado = normalizar(municipio);
    const departamentoNormalizado = normalizar(departamento);
    const paisNormalizado = normalizar(pais);

    const esBogota = [
      'BOGOTA',
      'BOGOTA D C'
    ].includes(municipioNormalizado);

    const esDistritoCapital =
      departamentoNormalizado === 'BOGOTA D C';

    const esColombia =
      paisNormalizado === 'COLOMBIA';

    if (esBogota && esDistritoCapital && esColombia) {
      return {
        original,
        municipio: 'BOGOTÁ',
        departamento: 'BOGOTÁ D.C.',
        pais: 'COLOMBIA',
        opcionEsperada:
          'BOGOTÁ (BOGOTÁ D.C., COLOMBIA)'
      };
    }

    return {
      original,
      municipio,
      departamento,
      pais,
      opcionEsperada: `${municipio} (${departamento}, ${pais})`
    };
  }

  // También acepta registros antiguos como: GARZÓN HUILA
  // o LA DORADA CALDAS.
  const departamentosColombia = [
    'AMAZONAS', 'ANTIOQUIA', 'ARAUCA', 'ATLÁNTICO', 'BOLÍVAR',
    'BOYACÁ', 'CALDAS', 'CAQUETÁ', 'CASANARE', 'CAUCA', 'CESAR',
    'CHOCÓ', 'CÓRDOBA', 'CUNDINAMARCA', 'GUAINÍA', 'GUAVIARE',
    'HUILA', 'LA GUAJIRA', 'MAGDALENA', 'META', 'NARIÑO',
    'NORTE DE SANTANDER', 'PUTUMAYO', 'QUINDÍO', 'RISARALDA',
    'SAN ANDRÉS Y PROVIDENCIA', 'SANTANDER', 'SUCRE', 'TOLIMA',
    'VALLE DEL CAUCA', 'VAUPÉS', 'VICHADA', 'BOGOTÁ D.C.'
  ].sort((a, b) => normalizar(b).length - normalizar(a).length);

  const originalNormalizado = normalizar(original);
  for (const departamento of departamentosColombia) {
    const departamentoNormalizado = normalizar(departamento);
    const sufijo = ` ${departamentoNormalizado}`;

    if (!originalNormalizado.endsWith(sufijo)) continue;

    const palabrasOriginal = original.split(/\s+/);
    const cantidadPalabrasDepartamento = departamentoNormalizado.split(' ').length;
    const municipio = palabrasOriginal
      .slice(0, -cantidadPalabrasDepartamento)
      .join(' ')
      .trim();

    if (municipio) {
      return {
        original,
        municipio,
        departamento,
        pais: 'COLOMBIA',
        opcionEsperada: `${municipio} (${departamento}, COLOMBIA)`
      };
    }
  }

  // También acepta: LA DORADA, CALDAS, COLOMBIA
  const partes = original
    .split(',')
    .map((parte) => parte.trim())
    .filter(Boolean);

  if (partes.length >= 3) {
    const municipio = partes[0];
    const departamento = partes[1];
    const pais = partes.slice(2).join(', ');

    return {
      original,
      municipio,
      departamento,
      pais,
      opcionEsperada: `${municipio} (${departamento}, ${pais})`
    };
  }

  // Registros antiguos que solo tienen el municipio.
  // En este caso se buscará una única sugerencia colombiana que empiece
  // exactamente por el municipio escrito.
  return {
    original,
    municipio: original,
    departamento: '',
    pais: 'COLOMBIA',
    opcionEsperada: ''
  };
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
        '[class*="autocomplete" i] li', '[id*="completion" i] li', '[id*="autocomplete" i] li'
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

  async #consultarOpcionesAutocomplete(locator, { campo, prefixText = '', timeoutMs = 8000 } = {}) {
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
    if (urlMetodo) {
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
    this.page.on('response', listener);
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
        const opciones = limpiarOpcionesCatalogo([...respuestas, ...await this.#sugerenciasVisibles()]);
        if (opciones.length) return { opciones, fuente: 'interfaz', descriptor, urlMetodo, status: 200 };
        await this.page.waitForTimeout(150);
      }
    } finally { this.page.off('response', listener); }
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
    let empresasMision = [];

    for (const tipoEvaluacion of tipos) {
      await this.#llenar('tipoEvaluacion', 'Tipo de Evaluación Médica o Procedimiento', tipoEvaluacion, { autocomplete: true });
      await this.#llenar('acuerdoComercial', 'Nombre del Acuerdo Comercial, Contrato o Convenio', acuerdoBuscado, { autocomplete: true });
      await this.page.waitForTimeout(350);
      const acuerdoInput = await this.#controlCercaDeEtiqueta('acuerdoComercial', 'Nombre del Acuerdo Comercial, Contrato o Convenio');
      acuerdoExacto = String(await acuerdoInput.inputValue().catch(() => acuerdoBuscado)).trim() || acuerdoBuscado;

      if (!empresasMision.length) {
        const inputMision = await this.#controlCercaDeEtiqueta('empresaMision', 'Nombre de la Empresa en Misión').catch(() => null);
        if (inputMision) {
          const consultaMision = await this.#consultarOpcionesAutocomplete(inputMision, {
            campo: 'Empresa en Misión', prefixText: '', timeoutMs: 6500
          });
          empresasMision = limpiarOpcionesCatalogo(consultaMision.opciones);
        }
      }

      const inputPaquete = await this.#controlCercaDeEtiqueta('paquete', 'Nombre del Paquete');
      const consulta = await this.#consultarOpcionesAutocomplete(inputPaquete, {
        campo: 'Nombre del Paquete', prefixText: '', timeoutMs: 8000
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

    if (!lugar.municipio) {
      throw new Error(`El valor para ${etiqueta} está vacío.`);
    }

    const municipioNormalizado = normalizar(lugar.municipio);
    const esperadoNormalizado = normalizar(lugar.opcionEsperada);

    /*
     * BIOFILE no encuentra correctamente "BOGOTÁ D.C." cuando se escribe
     * con la abreviatura completa. Para activar su autocompletado se debe
     * buscar únicamente "BOGOTA"; después se selecciona y verifica la opción
     * completa "BOGOTÁ (BOGOTÁ D.C., COLOMBIA)".
     */
    const esBogotaDC = [
      'BOGOTA',
      'BOGOTA D C'
    ].includes(municipioNormalizado);

    const textoBusquedaMunicipio = esBogotaDC
      ? 'BOGOTA'
      : lugar.municipio;

    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.evaluate((elemento) => {
      elemento.setAttribute('autocomplete', 'off');
      elemento.setAttribute('autocorrect', 'off');
      elemento.setAttribute('spellcheck', 'false');
    }).catch(() => {});

    // Biofile necesita que se escriba solo el municipio para activar
    // la búsqueda. El valor completo no se debe pegar directamente.
    await locator.click({ clickCount: 3 }).catch(() => {});
    await locator.fill('');
    await locator.pressSequentially(textoBusquedaMunicipio, {
      delay: 150
    });

    const selectorOpciones = [
      'ul.ui-autocomplete:visible li:visible',
      'ul.typeahead:visible li:visible',
      '.typeahead.dropdown-menu:visible li:visible',
      '.dropdown-menu:visible li:visible',
      '.dropdown-menu:visible .dropdown-item:visible',
      '.ac_results:visible li:visible',
      '.autocomplete_completionListElement:visible > *:visible',
      '.ajax__autocomplete_item:visible',
      '.ajax__autocomplete_highlighted_item:visible',
      '[role="listbox"]:visible [role="option"]:visible',
      '.autocomplete-suggestions:visible .autocomplete-suggestion:visible',
      '.tt-menu:visible .tt-suggestion:visible',
      '.select2-results:visible .select2-results__option:visible'
    ].join(', ');

    const limite = Date.now() + 7000;
    let candidatoExacto = null;
    let textoSeleccionado = '';
    let encontradas = [];

    while (Date.now() < limite && !candidatoExacto) {
      const opciones = this.page.locator(selectorOpciones);
      const cantidad = await opciones.count();
      const coincidenciasMunicipio = new Map();
      const textosVistos = [];

      for (let indice = 0; indice < cantidad; indice += 1) {
        const opcion = opciones.nth(indice);
        if (!await opcion.isVisible().catch(() => false)) continue;

        const textoOriginal = String(
          await opcion.innerText().catch(() => '')
        ).trim().replace(/\s+/g, ' ');

        if (!textoOriginal) continue;
        if (!textosVistos.includes(textoOriginal)) {
          textosVistos.push(textoOriginal);
        }

        const textoNormalizado = normalizar(textoOriginal);

        if (
          esperadoNormalizado &&
          textoNormalizado === esperadoNormalizado
        ) {
          candidatoExacto = opcion;
          textoSeleccionado = textoOriginal;
          break;
        }

        if (!esperadoNormalizado) {
          const mismoMunicipio =
            textoNormalizado === municipioNormalizado ||
            textoNormalizado.startsWith(`${municipioNormalizado} `);

          const esColombia = textoNormalizado.includes('COLOMBIA');

          if (
            mismoMunicipio &&
            esColombia &&
            !coincidenciasMunicipio.has(textoNormalizado)
          ) {
            coincidenciasMunicipio.set(textoNormalizado, {
              opcion,
              textoOriginal
            });
          }
        }
      }

      encontradas = textosVistos;

      /*
       * Respaldo para BIOFILE:
       * algunos menús de autocompletado no usan ninguna de las clases
       * anteriores. En ese caso se busca en todo el DOM un elemento visible
       * cuyo texto, sin tildes, coincida exactamente con la opción esperada.
       */
      if (!candidatoExacto && esperadoNormalizado) {
        const marca = `biofile-ciudad-${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}`;

        const encontradaEnDom = await this.page.evaluate(
          ({ esperado, marca }) => {
            const norm = (valor) => String(valor || '')
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .replace(/[^a-zA-Z0-9]+/g, ' ')
              .trim()
              .toUpperCase();

            const esVisible = (elemento) => Boolean(
              elemento &&
              (elemento.offsetWidth ||
                elemento.offsetHeight ||
                elemento.getClientRects().length)
            );

            const prioridad = (elemento) => {
              const tag = elemento.tagName;
              if (tag === 'LI') return 0;
              if (tag === 'A' || tag === 'BUTTON') return 1;
              if (elemento.getAttribute('role') === 'option') return 2;
              if (tag === 'DIV') return 3;
              if (tag === 'SPAN') return 4;
              return 5;
            };

            const candidatos = [
              ...document.querySelectorAll(
                'li, a, button, [role="option"], div, span, td'
              )
            ]
              .filter(esVisible)
              .filter((elemento) =>
                norm(elemento.textContent) === esperado
              )
              .map((elemento) => {
                const rect = elemento.getBoundingClientRect();
                return {
                  elemento,
                  prioridad: prioridad(elemento),
                  hijos: elemento.childElementCount,
                  area: Math.max(1, rect.width * rect.height)
                };
              })
              .sort((a, b) =>
                a.prioridad - b.prioridad ||
                a.hijos - b.hijos ||
                a.area - b.area
              );

            const elegido = candidatos[0]?.elemento;
            if (!elegido) return '';

            elegido.setAttribute('data-biofile-ciudad-opcion', marca);
            return String(elegido.textContent || '')
              .trim()
              .replace(/\s+/g, ' ');
          },
          {
            esperado: esperadoNormalizado,
            marca
          }
        ).catch(() => '');

        if (encontradaEnDom) {
          candidatoExacto = this.page
            .locator(
              `[data-biofile-ciudad-opcion="${marca}"]`
            )
            .first();

          textoSeleccionado = encontradaEnDom;

          if (!encontradas.includes(encontradaEnDom)) {
            encontradas.push(encontradaEnDom);
          }
        }
      }

      // Para registros antiguos que solo traen el municipio, únicamente
      // se selecciona si Biofile muestra una sola coincidencia colombiana.
      if (
        !esperadoNormalizado &&
        coincidenciasMunicipio.size === 1
      ) {
        const [unicaCoincidencia] = coincidenciasMunicipio.values();
        candidatoExacto = unicaCoincidencia.opcion;
        textoSeleccionado = unicaCoincidencia.textoOriginal;
        break;
      }

      await this.page.waitForTimeout(150);
    }

    let seleccionadaConMouse = false;
    let valorSeleccionadoConMouse = '';
    let seleccionadaConTeclado = false;
    let valorSeleccionadoConTeclado = '';
    let ultimoValorProbado = '';

    const coincideCiudadEsperada = (valor) => {
      const valorNormalizado = normalizar(valor);

      if (esperadoNormalizado) {
        return valorNormalizado === esperadoNormalizado;
      }

      return (
        valorNormalizado.startsWith(municipioNormalizado) &&
        valorNormalizado.includes('COLOMBIA')
      );
    };

    const leerValorCiudad = async () => String(
      await locator.inputValue().catch(() => '')
    ).trim().replace(/\s+/g, ' ');

    const escribirMunicipio = async () => {
      await locator.click({ clickCount: 3 }).catch(() => {});
      await locator.fill('');
      await locator.pressSequentially(textoBusquedaMunicipio, {
        delay: 120
      });
      await this.page.waitForTimeout(900);
    };

    /*
     * Respaldo por coordenadas.
     *
     * La captura demuestra que BIOFILE sí dibuja la sugerencia debajo del
     * campo, aunque el elemento no sea visible para los selectores CSS.
     * Playwright puede hacer clic por coordenadas relativas al input.
     *
     * Se prueban las primeras posiciones del menú y después de cada clic
     * se valida el valor final. Nunca se continúa con una ciudad incorrecta.
     */
    if (!candidatoExacto) {
      const desplazamientos = [
        16, 40, 64, 88, 112,
        136, 160, 184, 208, 232
      ];

      for (
        const desplazamiento of desplazamientos
      ) {
        await escribirMunicipio();

        const caja = await locator.boundingBox().catch(() => null);
        if (!caja) break;

        const x = caja.x + Math.min(
          Math.max(caja.width * 0.35, 45),
          Math.max(45, caja.width - 20)
        );

        const y = caja.y + caja.height + desplazamiento;

        await this.page.mouse.click(x, y).catch(() => {});
        await this.page.waitForTimeout(550);

        const valorMouse = await leerValorCiudad();
        ultimoValorProbado = valorMouse;

        if (coincideCiudadEsperada(valorMouse)) {
          seleccionadaConMouse = true;
          valorSeleccionadoConMouse = valorMouse;
          textoSeleccionado = valorMouse;
          break;
        }
      }
    }

    /*
     * Respaldo por teclado.
     *
     * Si el menú no respondió al clic por coordenadas, se recorren sus
     * opciones con ArrowDown + Enter y se valida cada resultado.
     */
    if (
      !candidatoExacto &&
      !seleccionadaConMouse
    ) {
      await escribirMunicipio();
      await locator.focus().catch(() => {});
      await this.page.keyboard.press('Enter').catch(() => {});
      await this.page.waitForTimeout(500);

      let valorTeclado = await leerValorCiudad();
      ultimoValorProbado = valorTeclado;

      if (coincideCiudadEsperada(valorTeclado)) {
        seleccionadaConTeclado = true;
        valorSeleccionadoConTeclado = valorTeclado;
        textoSeleccionado = valorTeclado;
      }

      for (
        let posicion = 1;
        posicion <= 15 && !seleccionadaConTeclado;
        posicion += 1
      ) {
        await escribirMunicipio();
        await locator.focus().catch(() => {});

        for (let paso = 0; paso < posicion; paso += 1) {
          await this.page.keyboard.press('ArrowDown').catch(() => {});
          await this.page.waitForTimeout(70);
        }

        await this.page.keyboard.press('Enter').catch(() => {});
        await this.page.waitForTimeout(500);

        valorTeclado = await leerValorCiudad();
        ultimoValorProbado = valorTeclado;

        if (coincideCiudadEsperada(valorTeclado)) {
          seleccionadaConTeclado = true;
          valorSeleccionadoConTeclado = valorTeclado;
          textoSeleccionado = valorTeclado;
          break;
        }
      }
    }

    if (
      !candidatoExacto &&
      !seleccionadaConMouse &&
      !seleccionadaConTeclado
    ) {
      const objetivo = lugar.opcionEsperada || lugar.municipio;
      const detalle = encontradas.length
        ? encontradas.join(' | ')
        : 'Biofile mostró el menú, pero su estructura no pudo identificarse';

      throw new Error(
        `No se pudo seleccionar la ciudad de nacimiento exacta "${objetivo}". ` +
        `Se probó el menú con clic por coordenadas y con teclado. ` +
        `Último valor del campo: "${ultimoValorProbado || lugar.municipio}". ` +
        `Opciones detectadas: ${detalle}`
      );
    }

    if (candidatoExacto) {
      await candidatoExacto.click({ force: true });
      await this.page.waitForTimeout(500);
    }

    const valorFinal = seleccionadaConMouse
      ? valorSeleccionadoConMouse
      : seleccionadaConTeclado
        ? valorSeleccionadoConTeclado
        : await leerValorCiudad();

    if (!valorFinal) {
      throw new Error(
        `El campo ${etiqueta} quedó vacío después de seleccionar la sugerencia.`
      );
    }

    if (
      esperadoNormalizado &&
      normalizar(valorFinal) !== esperadoNormalizado
    ) {
      throw new Error(
        `Biofile seleccionó una ciudad incorrecta. ` +
        `Esperado: "${lugar.opcionEsperada}". ` +
        `Resultado: "${valorFinal}".`
      );
    }

    if (
      !esperadoNormalizado &&
      !normalizar(valorFinal).startsWith(municipioNormalizado)
    ) {
      throw new Error(
        `Biofile seleccionó una ciudad que no coincide con "${lugar.municipio}". ` +
        `Resultado: "${valorFinal}".`
      );
    }

    await locator.evaluate((elemento) => {
      elemento.dispatchEvent(new Event('input', { bubbles: true }));
      elemento.dispatchEvent(new Event('change', { bubbles: true }));
      elemento.dispatchEvent(new Event('blur', { bubbles: true }));
    }).catch(() => {});

    this.logger?.info(
      'Ciudad de nacimiento seleccionada desde el autocompletado de Biofile.',
      {
        valorGoogleSheets: lugar.original,
        municipioOriginal: lugar.municipio,
        textoBuscado: textoBusquedaMunicipio,
        opcionSeleccionada: textoSeleccionado || valorFinal,
        valorFinal
      }
    );
  }

  async #seleccionarAutocompletado(locator, valor, etiqueta) {
    const valorOriginal = String(valor ?? '').trim();

    if (!valorOriginal) {
      throw new Error(`El valor para ${etiqueta} está vacío.`);
    }

    const campoNormalizado = normalizar(etiqueta);

    if (campoNormalizado === 'CIUDAD DE NACIMIENTO') {
      await this.#seleccionarCiudadNacimiento(
        locator,
        valorOriginal,
        etiqueta
      );
      return;
    }

    /*
     * buscar: texto corto que se escribe en Biofile.
     * seleccionar: opción exacta que obligatoriamente debe elegirse.
     */
    const reglas = {
      'TIPO DE EVALUACION MEDICA O PROCEDIMIENTO': {
        buscar: 'INGRES',
        seleccionar: 'EVALUACIÓN MÉDICA OCUPACIONAL DE INGRESO'
      },

      'NOMBRE DEL ACUERDO COMERCIAL CONTRATO O CONVENIO': {
        buscar: 'PART',
        seleccionar: 'PARTICULARES'
      },

      'NOMBRE DE LA EMPRESA EN MISION': {
        buscar: 'PART',
        seleccionar: 'PARTICULARES'
      },

      'NOMBRE DEL PAQUETE': {
        buscar: 'NO APL',
        seleccionar: 'NO APLICA'
      },

      EPS: {
        buscar: 'NO REFIERE',
        seleccionar: 'NO REFIERE'
      },

      AFP: {
        buscar: 'NO REFIERE',
        seleccionar: 'NO REFIERE'
      },

      ARL: {
        buscar: 'NO REFIERE',
        seleccionar: 'NO REFIERE'
      }
    };

    const regla = reglas[campoNormalizado] || {
      buscar: valorOriginal,
      seleccionar: null
    };

    const textoBusqueda = regla.buscar;
    const textoExacto = regla.seleccionar;

    await locator.scrollIntoViewIfNeeded().catch(() => {});

    await locator.evaluate((elemento) => {
      elemento.setAttribute('autocomplete', 'off');
      elemento.setAttribute('autocorrect', 'off');
      elemento.setAttribute('spellcheck', 'false');
    }).catch(() => {});

    await locator.click({ clickCount: 3 });
    await locator.fill('');

    await locator.pressSequentially(textoBusqueda, {
      delay: 35
    });

    let seleccionConfirmada = false;
    let opcionSeleccionada = '';

    if (textoExacto) {
      const expresionExacta = new RegExp(
        `^\\s*${escapeRegex(textoExacto)}\\s*$`,
        'i'
      );

      const candidatos = this.page.getByText(expresionExacta);
      const limite = Date.now() + 4000;

      while (
        Date.now() < limite &&
        !seleccionConfirmada
      ) {
        const cantidad = await candidatos.count();

        for (let indice = 0; indice < cantidad; indice += 1) {
          const candidato = candidatos.nth(indice);

          if (await candidato.isVisible().catch(() => false)) {
            opcionSeleccionada = String(
              await candidato.innerText().catch(() => textoExacto)
            ).trim();

            await candidato.click({ force: true });
            seleccionConfirmada = true;
            break;
          }
        }

        if (!seleccionConfirmada) {
          await this.page.waitForTimeout(100);
        }
      }

      if (!seleccionConfirmada) {
        throw new Error(
          `Biofile no mostró la opción exacta "${textoExacto}" ` +
          `para el campo ${etiqueta}.`
        );
      }
    } else {
      await this.page.waitForTimeout(800);
      await locator.press('Enter');
      seleccionConfirmada = true;
    }

    await this.page.waitForTimeout(250);

    const valorFinal = String(
      await locator.inputValue().catch(() => '')
    ).trim();

    if (!valorFinal) {
      throw new Error(
        `El campo ${etiqueta} quedó vacío después de seleccionar la opción.`
      );
    }

    if (
      textoExacto &&
      normalizar(valorFinal) !== normalizar(textoExacto)
    ) {
      throw new Error(
        `Biofile seleccionó un valor incorrecto en ${etiqueta}. ` +
        `Esperado: "${textoExacto}". ` +
        `Resultado: "${valorFinal}".`
      );
    }

    await locator.evaluate((elemento) => {
      elemento.dispatchEvent(new Event('input', { bubbles: true }));
      elemento.dispatchEvent(new Event('change', { bubbles: true }));
      elemento.dispatchEvent(new Event('blur', { bubbles: true }));
    }).catch(() => {});

    this.logger?.info(
      'Opción exacta de autocompletado seleccionada.',
      {
        campo: etiqueta,
        textoEscrito: textoBusqueda,
        opcionSeleccionada: opcionSeleccionada || valorFinal,
        valorFinal
      }
    );
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
    const v = String(valor ?? '').trim();
    if (!v && opcional) return { accion: 'omitido' };
    if (!v) throw new Error(`El valor para ${etiqueta} está vacío.`);

    const locator = await this.#controlCercaDeEtiqueta(fieldKey, etiqueta);
    await this.#escribirEnControl(locator, v, etiqueta, { autocomplete });
    return { accion: 'llenado', valor: v };
  }

  async #llenarSoloSiFalta(fieldKey, etiqueta, valor, { autocomplete = false, opcional = false } = {}) {
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

// await llenarPaciente(
//   'municipio',
//   'Municipio',
//   r.municipio,
//   { autocomplete: true }
// );
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
    await this.#llenar('acuerdoComercial', 'Nombre del Acuerdo Comercial, Contrato o Convenio', defaults.acuerdo, { autocomplete: true });
    await this.#llenar('empresaMision', 'Nombre de la Empresa en Misión', defaults.empresaMision, { autocomplete: true });
    await this.#llenar('paquete', 'Nombre del Paquete', defaults.paquete, { autocomplete: true });
    await this.#llenar('eps', 'Eps', defaults.eps, { autocomplete: true });
    await this.#llenar('afp', 'Afp', defaults.afp, { autocomplete: true });
    await this.#llenar('arl', 'Arl', defaults.arl, { autocomplete: true });
    await this.#llenar('diagnostico', 'Diagnóstico CIE-10', defaults.diagnostico);
    await this.#llenar('tipoVinculacion', 'Tipo de vinculación', defaults.tipoVinculacion);
    await this.#llenar('tipoAfiliado', 'Tipo Afiliado', defaults.tipoAfiliado);
    await this.#llenar('nivel', 'Nivel', defaults.nivel);

    if (defaults.productoServicio) {
      await this.#llenarProductoInferior(defaults);
    }

    return { pacienteExistente };
  }

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

    const cerrar = await this.#accion('cerrarExito', 'Cerrar');
    await cerrar.click();
    await this.page.waitForTimeout(700);
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
