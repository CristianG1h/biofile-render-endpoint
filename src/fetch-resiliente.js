/*
 * Capa de resiliencia para las llamadas HTTP hechas por Node desde Render.
 *
 * El robot depende de Google Sheets/Drive y de otros enlaces HTTPS. En Render
 * puede ocurrir de forma esporádica que undici (fetch de Node) pierda DNS,
 * TLS o una conexión saliente y solo entregue el mensaje genérico
 * "fetch failed". Ese error no significa que el paciente esté mal: es una
 * falla transitoria de red.
 *
 * Esta capa reintenta automáticamente las operaciones seguras y, si todos los
 * intentos fallan, devuelve un mensaje útil para el panel en lugar de
 * propagar el "fetch failed" crudo.
 */

const fetchNativo = globalThis.fetch.bind(globalThis);
const ESTADOS_REINTENTABLES = new Set([408, 425, 429, 500, 502, 503, 504]);
const INTENTOS_MAXIMOS = 4;
const TIMEOUT_MS = 20000;

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function metodoDe(input, init = {}) {
  return String(init.method || input?.method || 'GET').toUpperCase();
}

function urlDe(input) {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    if (input?.url) return new URL(input.url);
  } catch {}
  return null;
}

function hostGoogle(hostname = '') {
  const host = String(hostname).toLowerCase();
  return host === 'google.com'
    || host.endsWith('.google.com')
    || host === 'googleapis.com'
    || host.endsWith('.googleapis.com')
    || host === 'googleusercontent.com'
    || host.endsWith('.googleusercontent.com');
}

function cuerpoReutilizable(body) {
  return body === undefined
    || body === null
    || typeof body === 'string'
    || body instanceof URLSearchParams
    || Buffer.isBuffer(body)
    || ArrayBuffer.isView(body)
    || body instanceof ArrayBuffer;
}

function puedeReintentar(input, init, url, metodo) {
  if (!url || !['http:', 'https:'].includes(url.protocol)) return false;
  if (['GET', 'HEAD', 'OPTIONS'].includes(metodo)) return true;

  // Las escrituras que hace este servicio a Google son idempotentes en la
  // práctica: token OAuth o actualización del mismo rango/valor de Sheets.
  if (hostGoogle(url.hostname) && ['POST', 'PUT', 'PATCH'].includes(metodo)) {
    const body = init.body ?? input?.body ?? null;
    return cuerpoReutilizable(body);
  }

  return false;
}

function combinarSenal(senalOriginal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  if (!senalOriginal) return timeout;
  if (senalOriginal.aborted) return senalOriginal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([senalOriginal, timeout]);
  }
  return senalOriginal;
}

function mensajeServicio(url) {
  if (!url) return 'el servicio externo';
  if (hostGoogle(url.hostname)) return 'Google (Sheets/Drive)';
  return url.hostname || 'el servicio externo';
}

function errorFinal(error, url, intentos) {
  // Respeta abortos explícitos solicitados por el código llamador.
  if (error?.name === 'AbortError') return error;

  const causa = error?.cause?.code || error?.code || '';
  const detalle = causa ? ` Código: ${causa}.` : '';
  const nuevo = new Error(
    `No fue posible conectar con ${mensajeServicio(url)} después de ${intentos} intentos. ` +
    `La conexión saliente de Render o el servicio externo se interrumpió temporalmente.${detalle}`
  );
  nuevo.cause = error;
  nuevo.codigo = causa || 'FETCH_NETWORK_ERROR';
  return nuevo;
}

async function fetchResiliente(input, init = {}) {
  const url = urlDe(input);
  const metodo = metodoDe(input, init);
  const reintentable = puedeReintentar(input, init, url, metodo);
  const maxIntentos = reintentable ? INTENTOS_MAXIMOS : 1;
  let ultimoError = null;

  for (let intento = 1; intento <= maxIntentos; intento += 1) {
    try {
      const response = await fetchNativo(input, {
        ...init,
        signal: combinarSenal(init.signal || input?.signal)
      });

      if (
        reintentable
        && intento < maxIntentos
        && ESTADOS_REINTENTABLES.has(response.status)
      ) {
        try { await response.body?.cancel(); } catch {}
        console.warn('[fetch-resiliente] Respuesta temporal; reintentando.', {
          host: url?.hostname || '',
          metodo,
          status: response.status,
          intento
        });
        await esperar(350 * intento);
        continue;
      }

      return response;
    } catch (error) {
      ultimoError = error;

      // Si el llamador abortó su propia señal, no se debe reintentar.
      if (init.signal?.aborted || input?.signal?.aborted) throw error;

      if (!reintentable || intento >= maxIntentos) {
        throw errorFinal(error, url, intento);
      }

      console.warn('[fetch-resiliente] Fallo de red; reintentando.', {
        host: url?.hostname || '',
        metodo,
        intento,
        error: error?.message || String(error),
        codigo: error?.cause?.code || error?.code || ''
      });
      await esperar(350 * intento);
    }
  }

  throw errorFinal(ultimoError || new Error('fetch failed'), url, maxIntentos);
}

globalThis.fetch = fetchResiliente;
