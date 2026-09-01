import { normalizar } from './util.js';

export function textoBusquedaAutocomplete(etiqueta, valor) {
  const original = String(valor || '').trim();
  const campo = normalizar(etiqueta);
  const buscado = normalizar(original);
  if (campo !== 'TIPO DE EVALUACION MEDICA O PROCEDIMIENTO') return original;
  if (buscado.includes('POST INCAPACIDAD')) return 'POST';
  if (buscado.includes('PERIODIC')) return 'PERIOD';
  if (buscado.includes('EGRES')) return 'EGRES';
  if (buscado.includes('INGRES')) return 'INGRES';
  return original;
}

function agregarUnico(lista, valor) {
  const texto = String(valor || '').trim().replace(/\s+/g, ' ');
  if (!texto) return;
  if (!lista.some((item) => normalizar(item) === normalizar(texto))) lista.push(texto);
}

/**
 * BIOFILE devuelve varias capas de JSON en sus WebMethods de autocompletado.
 * La respuesta habitual es { d: ["{\"First\":...}"] }.
 */
export function extraerOpcionesAutocomplete(data) {
  const opciones = [];
  const recorrer = (valor) => {
    if (valor === null || valor === undefined) return;
    if (Array.isArray(valor)) return valor.forEach(recorrer);
    if (typeof valor === 'string') {
      const texto = valor.trim();
      if (!texto) return;
      if ((texto.startsWith('{') && texto.endsWith('}')) ||
          (texto.startsWith('[') && texto.endsWith(']'))) {
        try { recorrer(JSON.parse(texto)); return; } catch {}
      }
      agregarUnico(opciones, texto);
      return;
    }
    if (typeof valor !== 'object') return;
    const first = valor.First ?? valor.first;
    const second = valor.Second ?? valor.second;
    if (first !== undefined) agregarUnico(opciones, first);
    else if (second !== undefined) agregarUnico(opciones, second);
    for (const [clave, contenido] of Object.entries(valor)) {
      if (!['First', 'Second', 'first', 'second'].includes(clave)) recorrer(contenido);
    }
  };
  recorrer(data);
  return opciones;
}

export function construirUrlMetodoAutocomplete({ paginaActual, servicePath, serviceMethod }) {
  const metodo = String(serviceMethod || '').trim();
  if (!metodo) return '';
  const pagina = new URL(String(paginaActual));
  const base = String(servicePath || '').trim();
  const urlPagina = base ? new URL(base, pagina) : pagina;
  urlPagina.hash = '';
  urlPagina.search = '';
  urlPagina.pathname = urlPagina.pathname.replace(/\/$/, '') + '/' + metodo.replace(/^\/+/, '');
  return urlPagina.toString();
}

export function limpiarOpcionesCatalogo(opciones = []) {
  return opciones
    .map((valor) => String(valor || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .filter((valor) => !/^(SELECCIONE|CREAR NUEVO|NO APLICA)$/i.test(valor))
    .filter((valor, indice, lista) =>
      lista.findIndex((item) => normalizar(item) === normalizar(valor)) === indice
    );
}
