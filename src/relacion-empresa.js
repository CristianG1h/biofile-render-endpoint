import { normalizar } from './util.js';

const CATALOGO_BASE = String(
  process.env.RELACION_EMPRESA_CATALOGO_BASE ||
  'https://raw.githubusercontent.com/CristianG1h/panel-gestion-biofile-vip/main/data/empresas-mision-v27/'
).replace(/\/+$/, '') + '/';

const CATALOGO_TTL_MS = 6 * 60 * 60 * 1000;
const CATALOGO_TIMEOUT_MS = 10000;

let cacheCatalogo = {
  cargadoEn: 0,
  indice: null,
  promesa: null
};

function claveEmpresa(valor) {
  return normalizar(valor)
    .replace(/\bS A S\b/g, 'SAS')
    .replace(/\bS A\b/g, 'SA')
    .replace(/\bL T D A\b/g, 'LTDA')
    .replace(/\bE U\b/g, 'EU')
    .replace(/\s+/g, ' ')
    .trim();
}

function valorValido(valor) {
  const clave = claveEmpresa(valor);
  return Boolean(clave) && ![
    'NO REFIERE',
    'PENDIENTE',
    'ERROR REVISAR'
  ].includes(clave);
}

function agregarUnico(lista, valor, clave = (x) => x) {
  const k = clave(valor);
  if (!lista.some((item) => clave(item) === k)) lista.push(valor);
}

export function construirIndiceRelaciones(relaciones = [], manifest = {}) {
  const acuerdos = new Map();
  const misiones = new Map();
  const aliases = new Map();

  const asegurarAcuerdo = (acuerdo) => {
    const nombre = String(acuerdo || '').trim().replace(/\s+/g, ' ');
    if (!valorValido(nombre)) return null;
    const key = claveEmpresa(nombre);
    let item = acuerdos.get(key);
    if (!item) {
      item = { acuerdo: nombre, misiones: [] };
      acuerdos.set(key, item);
    }
    return item;
  };

  const agregarRelacion = (acuerdo, mision) => {
    const item = asegurarAcuerdo(acuerdo);
    const nombreMision = String(mision || '').trim().replace(/\s+/g, ' ');
    if (!item || !valorValido(nombreMision)) return;

    agregarUnico(item.misiones, nombreMision, claveEmpresa);

    const keyMision = claveEmpresa(nombreMision);
    const pares = misiones.get(keyMision) || [];
    const existe = pares.some((par) =>
      claveEmpresa(par.acuerdo) === claveEmpresa(item.acuerdo) &&
      claveEmpresa(par.empresaMision) === keyMision
    );
    if (!existe) pares.push({ acuerdo: item.acuerdo, empresaMision: nombreMision });
    misiones.set(keyMision, pares);
  };

  for (const relacion of relaciones || []) {
    if (!Array.isArray(relacion) || relacion.length < 2) continue;
    agregarRelacion(relacion[0], relacion[1]);
  }

  for (const [acuerdo, nombreCorto] of Object.entries(manifest?.shortNames || {})) {
    const item = asegurarAcuerdo(acuerdo);
    if (item && valorValido(nombreCorto)) aliases.set(claveEmpresa(nombreCorto), {
      acuerdo: item.acuerdo,
      empresaMision: ''
    });
  }

  for (const [alias, relacion] of Object.entries(manifest?.specialAliases || {})) {
    const acuerdo = String(relacion?.principal || '').trim();
    const mision = String(relacion?.mision || '').trim();
    const item = asegurarAcuerdo(acuerdo);
    if (!item || !claveEmpresa(alias)) continue;
    aliases.set(claveEmpresa(alias), {
      acuerdo: item.acuerdo,
      empresaMision: valorValido(mision) ? mision : ''
    });
  }

  return {
    version: String(manifest?.version || 'sin-version'),
    relaciones: Number(manifest?.relations || relaciones.length || 0),
    acuerdos,
    misiones,
    aliases
  };
}

async function fetchJson(url, signal) {
  const response = await fetch(url, {
    cache: 'no-store',
    redirect: 'follow',
    signal,
    headers: { 'user-agent': 'VIP-BIOFILE/relacion-empresa' }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} consultando ${url}`);
  return response.json();
}

export async function cargarCatalogoRelaciones({ force = false } = {}) {
  const ahora = Date.now();
  if (!force && cacheCatalogo.indice && ahora - cacheCatalogo.cargadoEn < CATALOGO_TTL_MS) {
    return cacheCatalogo.indice;
  }
  if (cacheCatalogo.promesa) return cacheCatalogo.promesa;

  cacheCatalogo.promesa = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CATALOGO_TIMEOUT_MS);
    try {
      const manifest = await fetchJson(
        CATALOGO_BASE + 'relaciones-acuerdo-mision-v67.json',
        controller.signal
      );
      const partes = Math.max(1, Number(manifest?.parts || 6));
      const urls = Array.from({ length: partes }, (_, i) =>
        CATALOGO_BASE + 'relaciones-v67/parte-' + String(i + 1).padStart(2, '0') + '.json'
      );
      const respuestas = await Promise.all(urls.map((url) => fetchJson(url, controller.signal)));
      const relaciones = respuestas.flatMap((parte) => Array.isArray(parte?.relaciones) ? parte.relaciones : []);
      if (relaciones.length < 100) {
        throw new Error(`El catálogo de empresas llegó incompleto (${relaciones.length} relaciones).`);
      }
      const indice = construirIndiceRelaciones(relaciones, manifest);
      cacheCatalogo = { cargadoEn: Date.now(), indice, promesa: null };
      return indice;
    } finally {
      clearTimeout(timeout);
      cacheCatalogo.promesa = null;
    }
  })();

  return cacheCatalogo.promesa;
}

function resolverAcuerdoExacto(indice, valor) {
  const item = indice.acuerdos.get(claveEmpresa(valor));
  if (!item) return null;

  const self = item.misiones.find((mision) => claveEmpresa(mision) === claveEmpresa(item.acuerdo));
  if (self) {
    return {
      acuerdo: item.acuerdo,
      empresaMision: self,
      fuente: 'acuerdo-self'
    };
  }

  if (item.misiones.length === 1) {
    return {
      acuerdo: item.acuerdo,
      empresaMision: item.misiones[0],
      fuente: 'acuerdo-unica-mision'
    };
  }

  return {
    acuerdo: item.acuerdo,
    empresaMision: '',
    fuente: 'acuerdo-ambiguo',
    ambiguo: true
  };
}

function resolverMisionExacta(indice, valor) {
  const key = claveEmpresa(valor);
  const pares = indice.misiones.get(key) || [];
  if (!pares.length) return null;

  if (pares.length === 1) {
    return { ...pares[0], fuente: 'mision-exacta' };
  }

  const self = pares.find((par) => claveEmpresa(par.acuerdo) === key);
  if (self) return { ...self, fuente: 'mision-self' };

  const acuerdosUnicos = new Set(pares.map((par) => claveEmpresa(par.acuerdo)));
  if (acuerdosUnicos.size === 1) return { ...pares[0], fuente: 'mision-mismo-acuerdo' };

  return { ambiguo: true, fuente: 'mision-ambigua' };
}

export function resolverRelacionEnIndice(indice, {
  acuerdo = '',
  empresaMision = '',
  empresa = ''
} = {}) {
  if (!indice) return null;

  const acuerdoTexto = String(acuerdo || '').trim();
  const misionTexto = String(empresaMision || '').trim();
  const empresaTexto = String(empresa || '').trim();

  if (acuerdoTexto && misionTexto) {
    const item = indice.acuerdos.get(claveEmpresa(acuerdoTexto));
    if (item) {
      const misionCanonica = item.misiones.find((m) => claveEmpresa(m) === claveEmpresa(misionTexto));
      if (misionCanonica) {
        return {
          acuerdo: item.acuerdo,
          empresaMision: misionCanonica,
          fuente: 'par-explicito-validado'
        };
      }
    }
    return { ambiguo: true, fuente: 'par-explicito-invalido' };
  }

  if (misionTexto) {
    const res = resolverMisionExacta(indice, misionTexto);
    if (res) return res;
  }

  if (acuerdoTexto) {
    const res = resolverAcuerdoExacto(indice, acuerdoTexto);
    if (res) return res;
  }

  if (empresaTexto) {
    const alias = indice.aliases.get(claveEmpresa(empresaTexto));
    if (alias) {
      if (alias.empresaMision) return { ...alias, fuente: 'alias-especial' };
      const desdeAcuerdo = resolverAcuerdoExacto(indice, alias.acuerdo);
      if (desdeAcuerdo) return { ...desdeAcuerdo, fuente: 'alias-acuerdo' };
    }

    const desdeMision = resolverMisionExacta(indice, empresaTexto);
    if (desdeMision && !desdeMision.ambiguo) return desdeMision;

    const desdeAcuerdo = resolverAcuerdoExacto(indice, empresaTexto);
    if (desdeAcuerdo) return desdeAcuerdo;

    if (desdeMision) return desdeMision;
  }

  return null;
}

export async function resolverRelacionEmpresaRegistro(registro, {
  fallbackAcuerdo = 'PARTICULARES',
  fallbackEmpresaMision = 'PARTICULARES',
  logger
} = {}) {
  const empresaLegada = String(registro?.empresaExcel || '').trim();
  const acuerdoExplicito = String(registro?.acuerdoComercialExcel || '').trim();
  const misionExplicita = String(registro?.empresaMisionExcel || '').trim();

  if (!empresaLegada && !acuerdoExplicito && !misionExplicita) {
    return {
      acuerdo: fallbackAcuerdo,
      empresaMision: fallbackEmpresaMision,
      fallback: true,
      motivo: 'sin-empresa'
    };
  }

  try {
    const indice = await cargarCatalogoRelaciones();
    const res = resolverRelacionEnIndice(indice, {
      acuerdo: acuerdoExplicito,
      empresaMision: misionExplicita,
      empresa: empresaLegada
    });

    if (res && !res.ambiguo && res.acuerdo && res.empresaMision) {
      return {
        ...res,
        fallback: false,
        catalogo: indice.version
      };
    }

    const motivo = res?.fuente || 'sin-coincidencia-exacta';
    logger?.warn('No se pudo validar una relación empresarial segura; se usará PARTICULARES.', {
      empresaLegada,
      acuerdoExplicito,
      misionExplicita,
      motivo
    });

    return {
      acuerdo: fallbackAcuerdo,
      empresaMision: fallbackEmpresaMision,
      fallback: true,
      motivo
    };
  } catch (error) {
    logger?.warn('No fue posible cargar el catálogo de empresas; se usará PARTICULARES.', {
      error: error.message
    });
    return {
      acuerdo: fallbackAcuerdo,
      empresaMision: fallbackEmpresaMision,
      fallback: true,
      motivo: 'catalogo-no-disponible'
    };
  }
}

export { claveEmpresa };
