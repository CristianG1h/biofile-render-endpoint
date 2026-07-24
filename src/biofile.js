import fs from 'node:fs';
import path from 'node:path';
import { descargarArchivoEnMemoria } from './drive.js';
import { asegurarDirectorio, fechaArchivo, normalizar } from './util.js';

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  async #seleccionarAutocompletado(locator, valor, etiqueta) {
  const valorOriginal = String(valor ?? '').trim();

  if (!valorOriginal) {
    throw new Error(`El valor para ${etiqueta} está vacío.`);
  }

  const campoNormalizado = normalizar(etiqueta);

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

  // Limpiar el campo.
  await locator.click({ clickCount: 3 });
  await locator.fill('');

  // Escribir para activar el autocompletado de Biofile.
  await locator.pressSequentially(textoBusqueda, {
    delay: 35
  });

  let seleccionConfirmada = false;
  let opcionSeleccionada = '';

  /*
   * Para los campos configurados buscamos la opción exacta
   * y hacemos clic directamente sobre ella.
   */
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

          await candidato.click({
            force: true
          });

          seleccionConfirmada = true;
          break;
        }
      }

      if (!seleccionConfirmada) {
        await this.page.waitForTimeout(100);
      }
    }

    /*
     * En estos campos no se permite escoger otra opción,
     * porque podría crear una orden incorrecta.
     */
    if (!seleccionConfirmada) {
      throw new Error(
        `Biofile no mostró la opción exacta "${textoExacto}" ` +
        `para el campo ${etiqueta}.`
      );
    }
  } else {
    /*
     * Para Ciudad de Nacimiento y otros campos variables,
     * Biofile resalta la primera opción correcta.
     */
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

  /*
   * Verificar que Biofile haya dejado exactamente el valor solicitado.
   */
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
    elemento.dispatchEvent(
      new Event('input', { bubbles: true })
    );

    elemento.dispatchEvent(
      new Event('change', { bubbles: true })
    );

    elemento.dispatchEvent(
      new Event('blur', { bubbles: true })
    );
  }).catch(() => {});

  this.logger?.info(
    'Opción exacta de autocompletado seleccionada.',
    {
      campo: etiqueta,
      textoEscrito: textoBusqueda,
      opcionSeleccionada:
        opcionSeleccionada || valorFinal,
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

    const zonaOrigen = r.zona || defaults.zona;
    const zonaNormalizada = normalizar(zonaOrigen);
    const zona = zonaNormalizada.startsWith('URBANA')
      ? 'URBANA'
      : zonaNormalizada.startsWith('RURAL')
        ? 'RURAL'
        : zonaOrigen;

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
