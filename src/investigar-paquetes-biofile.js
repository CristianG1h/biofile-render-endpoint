import path from 'node:path';
import { configParaUsuario } from './config.js';
import { crearSesion } from './browser.js';
import { crearLogger } from './logger.js';
import { asegurarDirectorio, normalizar } from './util.js';
import {
  TIPOS_EVALUACION_BIOFILE,
  normalizarTipoEvaluacion
} from './catalogo-paquetes-biofile.js';

const ACUERDOS_URL = process.env.BIOFILE_ACUERDOS_URL ||
  'https://vipso.biofile.com.co/Factura/AcuerdosComerciales.aspx';

function escapeRegex(valor) {
  return String(valor).replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
}

async function visible(locator) {
  try {
    return (await locator.count()) > 0 && await locator.first().isVisible();
  } catch {
    return false;
  }
}

async function esperarProcesamiento(page, timeoutMs = 12000) {
  const limite = Date.now() + timeoutMs;
  let vio = false;
  while (Date.now() < limite) {
    const ocupado = await page.evaluate(() => {
      const esVisible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      return [...document.querySelectorAll('div,span,p,td,strong')].some((el) => {
        if (!esVisible(el)) return false;
        const texto = String(el.textContent || '').trim().replace(/\s+/g, ' ');
        return texto.length < 100 && /^(procesando datos|procesando|cargando)(\.{0,3})$/i.test(texto);
      });
    }).catch(() => false);

    if (!ocupado) {
      if (vio) await page.waitForTimeout(250);
      return;
    }
    vio = true;
    await page.waitForTimeout(150);
  }
}

async function controlCercaDeEtiqueta(page, etiqueta) {
  const descriptor = await page.evaluate(({ etiqueta }) => {
    const norm = (v) => String(v || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, ' ').trim().toUpperCase();
    const objetivo = norm(etiqueta);
    const esVisible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const nodos = [...document.querySelectorAll('label,span,div,td,p,strong')]
      .filter(esVisible)
      .map((el) => {
        const propio = [...el.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join(' ');
        const texto = norm(propio || el.textContent);
        const calidad = texto === objetivo ? 0 : texto.startsWith(objetivo) ? 1 : objetivo.startsWith(texto) ? 2 : 99;
        const modal = el.closest('[role="dialog"],.modal,.ui-dialog,[class*="modal" i],[class*="dialog" i]') ? 0 : 1;
        return { el, texto, calidad, modal };
      })
      .filter((x) => x.calidad < 99)
      .sort((a, b) => a.modal - b.modal || a.calidad - b.calidad || a.el.childElementCount - b.el.childElementCount || a.texto.length - b.texto.length);

    const describir = (el) => el ? {
      id: el.id || '',
      name: el.getAttribute('name') || '',
      tag: el.tagName
    } : null;

    for (const candidato of nodos) {
      const etiquetaEl = candidato.el;
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

      const contenedor = etiquetaEl.closest('td,div,tr');
      const controles = [...(contenedor?.querySelectorAll?.('input:not([type="hidden"]),select,textarea') || [])].filter(esVisible);
      if (controles.length) return describir(controles[0]);
    }
    return null;
  }, { etiqueta });

  if (!descriptor) throw new Error('No se encontró el campo "' + etiqueta + '" en Acuerdos Comerciales.');
  if (descriptor.id) return page.locator('[id="' + descriptor.id.replace(/"/g, '\\"') + '"]').first();
  if (descriptor.name) return page.locator('[name="' + descriptor.name.replace(/"/g, '\\"') + '"]').first();
  throw new Error('El campo "' + etiqueta + '" no tiene id ni name.');
}

async function clickBuscarVisible(page, preferirUltimo = false) {
  const candidatos = [
    page.getByRole('button', { name: /^Buscar$/i }),
    page.locator('input[type="button"][value*="Buscar" i], input[type="submit"][value*="Buscar" i]'),
    page.locator('[title*="Buscar" i], [alt*="Buscar" i]')
  ];

  for (const grupo of candidatos) {
    const cantidad = await grupo.count().catch(() => 0);
    const indices = preferirUltimo
      ? Array.from({ length: cantidad }, (_, i) => cantidad - 1 - i)
      : Array.from({ length: cantidad }, (_, i) => i);
    for (const i of indices) {
      const loc = grupo.nth(i);
      if (await loc.isVisible().catch(() => false)) {
        await loc.click({ force: true });
        return true;
      }
    }
  }
  return false;
}

function extraerNombresRespuesta(data) {
  const nombres = [];
  const agregar = (valor) => {
    const texto = String(valor || '').trim();
    if (!texto) return;
    if (!nombres.some((x) => normalizar(x) === normalizar(texto))) nombres.push(texto);
  };

  const recorrer = (valor) => {
    if (valor === null || valor === undefined) return;
    if (Array.isArray(valor)) {
      valor.forEach(recorrer);
      return;
    }
    if (typeof valor === 'string') {
      const s = valor.trim();
      if (!s) return;
      if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
        try {
          recorrer(JSON.parse(s));
          return;
        } catch {}
      }
      return;
    }
    if (typeof valor === 'object') {
      if ('First' in valor) agregar(valor.First);
      if ('Second' in valor && !valor.First) agregar(valor.Second);
      if ('first' in valor) agregar(valor.first);
      if ('second' in valor && !valor.first) agregar(valor.second);
      Object.entries(valor).forEach(([k, v]) => {
        if (!['First', 'Second', 'first', 'second'].includes(k)) recorrer(v);
      });
    }
  };

  recorrer(data);
  return nombres;
}

async function sugerenciasVisibles(page) {
  return page.evaluate(() => {
    const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const selectores = [
      '[role="option"]',
      '.ajax__autocomplete_item',
      '.ajax__autocomplete_highlighted_item',
      '[class*="autocomplete" i] li',
      '[id*="completion" i] li',
      '[id*="autocomplete" i] li'
    ];
    const textos = [];
    for (const selector of selectores) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const t = String(el.textContent || '').trim().replace(/\s+/g, ' ');
        if (t && t.length < 180 && !textos.includes(t)) textos.push(t);
      }
    }
    return textos;
  }).catch(() => []);
}

async function obtenerSugerenciasAutocomplete(page, input, timeoutMs = 5000) {
  const respuestas = [];
  const listener = async (response) => {
    try {
      const tipo = String(response.headers()['content-type'] || '');
      if (!/json|javascript/i.test(tipo)) return;
      const data = await response.json().catch(() => null);
      if (data) respuestas.push(...extraerNombresRespuesta(data));
    } catch {}
  };
  page.on('response', listener);

  try {
    await input.scrollIntoViewIfNeeded().catch(() => {});
    await input.click({ clickCount: 3 });
    await input.fill('').catch(() => {});
    await page.waitForTimeout(250);

    const limite = Date.now() + timeoutMs;
    while (Date.now() < limite) {
      const visuales = await sugerenciasVisibles(page);
      const combinadas = [...respuestas, ...visuales]
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .filter((x, i, arr) => arr.findIndex((y) => normalizar(y) === normalizar(x)) === i);
      if (combinadas.length) return combinadas;
      await page.waitForTimeout(180);
    }
    return [];
  } finally {
    page.off('response', listener);
  }
}

async function seleccionarSugerencia(page, input, texto) {
  await input.click({ clickCount: 3 }).catch(() => {});
  await input.fill('');
  await input.pressSequentially(String(texto), { delay: 18 });
  await page.waitForTimeout(350);

  const exacta = page.getByText(new RegExp('^\\s*' + escapeRegex(texto) + '\\s*$', 'i'));
  const cantidad = await exacta.count().catch(() => 0);
  for (let i = 0; i < cantidad; i += 1) {
    const item = exacta.nth(i);
    if (await item.isVisible().catch(() => false)) {
      await item.click({ force: true });
      await esperarProcesamiento(page);
      return;
    }
  }

  await input.press('ArrowDown').catch(() => {});
  await input.press('Enter').catch(() => {});
  await esperarProcesamiento(page);
  const final = String(await input.inputValue().catch(() => '')).trim();
  if (normalizar(final) !== normalizar(texto)) {
    throw new Error('No se pudo seleccionar exactamente el paquete "' + texto + '". Resultado: "' + final + '".');
  }
}

async function tiposProductoServicio(page) {
  const control = await controlCercaDeEtiqueta(page, 'Producto o Servicio');
  const tag = await control.evaluate((el) => el.tagName.toUpperCase());

  let textos = [];
  if (tag === 'SELECT') {
    textos = await control.locator('option').allTextContents();
  } else {
    textos = await obtenerSugerenciasAutocomplete(page, control, 3000);
  }

  const tipos = [];
  for (const texto of textos) {
    const tipo = normalizarTipoEvaluacion(texto);
    if (tipo && !tipos.some((x) => normalizar(x) === normalizar(tipo))) tipos.push(tipo);
  }
  return tipos;
}

async function encontrarFilaEmpresa(page, empresa) {
  const filas = page.locator('tr');
  const cantidad = await filas.count();
  const buscada = normalizar(empresa);

  let mejor = null;
  for (let i = 0; i < cantidad; i += 1) {
    const fila = filas.nth(i);
    if (!await fila.isVisible().catch(() => false)) continue;
    const texto = normalizar(await fila.innerText().catch(() => ''));
    if (!texto) continue;
    if (texto.includes(buscada)) return fila;
    if (!mejor && buscada.length >= 16 && texto.includes(buscada.slice(0, Math.min(40, buscada.length)))) mejor = fila;
  }
  return mejor;
}

async function acuerdoDesdePantalla(page, fallback) {
  try {
    const control = await controlCercaDeEtiqueta(page, 'Nombre del Acuerdo Comercial, Contrato o Convenio');
    const valor = String(await control.inputValue().catch(() => '')).trim();
    return valor || fallback;
  } catch {
    return fallback;
  }
}

export async function investigarPaquetesEmpresaBiofile({
  empresa,
  usuario,
  loggerExterno
}) {
  const empresaBuscada = String(empresa || '').trim();
  if (!empresaBuscada) throw new Error('La empresa es obligatoria para investigar paquetes.');
  if (!usuario?.usuario || !usuario?.contrasena) {
    throw new Error('No hay un usuario BIOFILE disponible para investigar paquetes.');
  }

  const usuarioCatalogo = {
    ...usuario,
    id: 'catalogo_' + (usuario.id || usuario.usuario)
  };
  const configUsuario = configParaUsuario(usuarioCatalogo);
  configUsuario.paths.screenshots = path.join(configUsuario.paths.screenshots, 'catalogo');
  asegurarDirectorio(configUsuario.paths.logs);
  asegurarDirectorio(configUsuario.paths.screenshots);
  const logger = loggerExterno || crearLogger(configUsuario.paths.logs);

  let sesion;
  try {
    logger.info('Iniciando investigación de paquetes en Acuerdos Comerciales.', {
      empresa: empresaBuscada,
      usuario: usuario.usuario
    });

    sesion = await crearSesion(configUsuario, logger);
    await sesion.asegurarLogin();
    const page = sesion.page;

    await page.goto(ACUERDOS_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    await esperarProcesamiento(page);

    // BIOFILE exige abrir primero el modal Buscar; el campo de la pantalla principal
    // no sirve para filtrar acuerdos existentes.
    if (!await clickBuscarVisible(page, false)) {
      throw new Error('No se encontró el botón Buscar de Acuerdos Comerciales.');
    }
    await page.waitForTimeout(500);
    await esperarProcesamiento(page);

    const campoBusqueda = await controlCercaDeEtiqueta(
      page,
      'Nombre del Acuerdo Comercial, Contrato o Convenio'
    );

    await campoBusqueda.click({ clickCount: 3 });
    await campoBusqueda.fill('');
    await campoBusqueda.fill(empresaBuscada);

    if (!await clickBuscarVisible(page, true)) {
      await campoBusqueda.press('Enter').catch(() => {});
    }
    await esperarProcesamiento(page);
    await page.waitForTimeout(500);

    const fila = await encontrarFilaEmpresa(page, empresaBuscada);
    if (!fila) {
      throw new Error('BIOFILE no devolvió un Acuerdo Comercial para "' + empresaBuscada + '".');
    }

    const interactivo = fila.locator('a,button,input[type="button"],input[type="image"],img').first();
    if (await visible(interactivo)) {
      await interactivo.click({ force: true });
    } else {
      await fila.locator('td').first().click({ force: true });
    }
    await esperarProcesamiento(page);
    await page.waitForTimeout(500);

    const acuerdoExacto = await acuerdoDesdePantalla(page, empresaBuscada);

    const tabPaquetes = page.getByText(/Paquetes\s+por\s+Cargo/i).first();
    if (!await visible(tabPaquetes)) {
      throw new Error('No se encontró la pestaña "Paquetes por Cargo" en el acuerdo.');
    }
    await tabPaquetes.click({ force: true });
    await page.waitForTimeout(300);
    await esperarProcesamiento(page);

    const inputPaquete = await controlCercaDeEtiqueta(page, 'Nombre del Paquete');
    let nombresPaquetes = await obtenerSugerenciasAutocomplete(page, inputPaquete, 6000);
    nombresPaquetes = nombresPaquetes
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .filter((x) => !/^seleccione$/i.test(x) && !/^crear nuevo$/i.test(x))
      .filter((x, i, arr) => arr.findIndex((y) => normalizar(y) === normalizar(x)) === i);

    const relaciones = [];
    for (const nombrePaquete of nombresPaquetes) {
      try {
        await seleccionarSugerencia(page, inputPaquete, nombrePaquete);
        const tipos = await tiposProductoServicio(page);
        for (const tipo of tipos) {
          if (!TIPOS_EVALUACION_BIOFILE.includes(tipo)) continue;
          if (!relaciones.some((x) =>
            normalizar(x.nombre) === normalizar(nombrePaquete) &&
            normalizar(x.tipoEvaluacion) === normalizar(tipo)
          )) {
            relaciones.push({ nombre: nombrePaquete, tipoEvaluacion: tipo });
          }
        }
      } catch (errorPaquete) {
        logger.warn('No se pudo clasificar un paquete; se continuará con los demás.', {
          empresa: empresaBuscada,
          paquete: nombrePaquete,
          error: errorPaquete.message
        });
      }
    }

    logger.info('Investigación de paquetes finalizada.', {
      empresa: empresaBuscada,
      acuerdoExacto,
      paquetesDetectados: nombresPaquetes.length,
      relacionesValidas: relaciones.length
    });

    return {
      empresaBuscada,
      acuerdoExacto,
      paquetes: relaciones,
      paquetesDetectados: nombresPaquetes.length,
      investigadoEnIso: new Date().toISOString()
    };
  } finally {
    await sesion?.browser?.close().catch(() => {});
  }
}
