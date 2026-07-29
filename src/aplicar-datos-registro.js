import { normalizar } from './util.js';

function escapeRegex(valor) {
  return String(valor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function visible(locator) {
  try {
    return (await locator.count()) > 0 && await locator.first().isVisible();
  } catch {
    return false;
  }
}

async function controlCercaDeEtiqueta(page, config, fieldKey, etiqueta) {
  const override = config.selectors?.[fieldKey];
  if (override) {
    const loc = page.locator(override).first();
    if (await visible(loc)) return loc;
  }

  const descriptor = await page.evaluate(({ etiqueta }) => {
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
      .sort((a, b) => a.calidad - b.calidad || a.el.childElementCount - b.el.childElementCount || a.t.length - b.t.length);

    if (!nodos.length) return null;
    const etiquetaEl = nodos[0].el;
    const describir = (el) => el ? {
      id: el.id || '',
      name: el.getAttribute('name') || '',
      tag: el.tagName
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

    const contenedor = etiquetaEl.closest('tr,td,div');
    const enContenedor = contenedor?.querySelector?.('input:not([type="hidden"]),select,textarea');
    if (enContenedor && esVisible(enContenedor)) return describir(enContenedor);

    return null;
  }, { etiqueta });

  if (!descriptor) {
    throw new Error(`No se encontró el control cercano a la etiqueta: ${etiqueta}`);
  }
  if (descriptor.id) return page.locator(`[id="${descriptor.id.replace(/"/g, '\\"')}"]`).first();
  if (descriptor.name) return page.locator(`[name="${descriptor.name.replace(/"/g, '\\"')}"]`).first();
  throw new Error(`El campo ${etiqueta} no tiene id ni name.`);
}

async function seleccionarOptionExacta(locator, valor, etiqueta) {
  const deseado = normalizar(valor);
  const opciones = await locator.locator('option').evaluateAll((items) => items.map((item) => ({
    value: item.value,
    text: item.textContent || ''
  })));

  const coincidencia = opciones.find((opcion) => normalizar(opcion.text) === deseado || normalizar(opcion.value) === deseado);
  if (!coincidencia) {
    throw new Error(`Biofile no contiene la opción de localidad "${valor}".`);
  }

  await locator.selectOption(coincidencia.value);
  await locator.evaluate((elemento) => {
    elemento.dispatchEvent(new Event('input', { bubbles: true }));
    elemento.dispatchEvent(new Event('change', { bubbles: true }));
    elemento.dispatchEvent(new Event('blur', { bubbles: true }));
  });

  return coincidencia.text.trim();
}

async function escribirAutocompletado(page, locator, valor, { verificarOpcion = false } = {}) {
  const tag = await locator.evaluate((elemento) => elemento.tagName.toUpperCase());
  if (tag === 'SELECT') {
    return seleccionarOptionExacta(locator, valor, 'campo');
  }

  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ clickCount: 3 }).catch(() => {});
  await locator.fill('');
  await locator.pressSequentially(String(valor), { delay: 25 });
  await page.waitForTimeout(500);

  const exacta = page.getByText(new RegExp(`^\\s*${escapeRegex(valor)}\\s*$`, 'i'));
  let opcionSeleccionada = '';
  const cantidad = await exacta.count();
  for (let i = 0; i < cantidad; i += 1) {
    const candidata = exacta.nth(i);
    if (await candidata.isVisible().catch(() => false)) {
      opcionSeleccionada = String(await candidata.innerText().catch(() => valor)).trim();
      await candidata.click({ force: true });
      break;
    }
  }

  // Para EPS/AFP/ARL se conserva exactamente lo escrito si Biofile no muestra
  // una coincidencia. No se elige una sugerencia diferente ni se bloquea el proceso.
  if (!opcionSeleccionada && verificarOpcion) {
    await locator.press('ArrowDown').catch(() => {});
    await locator.press('Enter').catch(() => {});
  }

  await locator.evaluate((elemento) => {
    elemento.dispatchEvent(new Event('input', { bubbles: true }));
    elemento.dispatchEvent(new Event('change', { bubbles: true }));
    elemento.dispatchEvent(new Event('blur', { bubbles: true }));
  }).catch(() => {});

  return opcionSeleccionada || String(await locator.inputValue().catch(() => valor)).trim();
}

/**
 * Ajusta únicamente los campos nuevos después del llenado normal de Biofile.
 * - Municipio y sede nunca se modifican.
 * - Localidad solo cambia cuando el formulario envió una localidad de Bogotá.
 * - EPS, AFP y ARL usan el dato de la hoja; vacío conserva NO REFIERE.
 */
export async function aplicarDatosRegistroBiofile({ page, config, registro, defaults, logger }) {
  const localidad = String(registro.localidad || '').trim();
  if (localidad) {
    const control = await controlCercaDeEtiqueta(page, config, 'localidad', 'Localidad');
    const tag = await control.evaluate((elemento) => elemento.tagName.toUpperCase());
    const resultado = tag === 'SELECT'
      ? await seleccionarOptionExacta(control, localidad, 'Localidad')
      : await escribirAutocompletado(page, control, localidad, { verificarOpcion: true });
    logger?.info('Localidad del formulario aplicada en Biofile.', { localidad: resultado || localidad });
  } else {
    logger?.info('Sin localidad de Bogotá; se conserva la localidad predeterminada de Biofile.', {
      localidad: defaults.localidad
    });
  }

  const campos = [
    ['eps', 'Eps', registro.eps || defaults.eps || 'NO REFIERE'],
    ['afp', 'Afp', registro.afp || defaults.afp || 'NO REFIERE'],
    ['arl', 'Arl', registro.arl || defaults.arl || 'NO REFIERE']
  ];

  for (const [fieldKey, etiqueta, valor] of campos) {
    const control = await controlCercaDeEtiqueta(page, config, fieldKey, etiqueta);
    const resultado = await escribirAutocompletado(page, control, String(valor).trim(), {
      verificarOpcion: false
    });
    logger?.info('Afiliación aplicada en Biofile sin validación estricta.', {
      campo: etiqueta.toUpperCase(),
      solicitado: String(valor).trim(),
      resultado
    });
  }
}
