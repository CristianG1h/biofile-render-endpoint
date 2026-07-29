import { config, validarConfiguracion } from './config.js';
import { BaseGoogleSheets } from './google-sheets.js';
import { crearSesion } from './browser.js';
import { BiofileClient } from './biofile.js';
import { crearLogger } from './logger.js';
import { asegurarDirectorio } from './util.js';
import { obtenerDatosRegistroAdicionales } from './datos-registro-adicionales.js';
import { aplicarDatosRegistroBiofile } from './aplicar-datos-registro.js';

function normalizarDocumento(valor) {
  return String(valor ?? '').trim().replace(/\s+/g, '');
}

function duracionSegundos(inicio) {
  return Number(((Date.now() - inicio) / 1000).toFixed(2));
}

/**
 * Procesa exactamente un paciente de Google Sheets, identificado por documento.
 * No toma "el último" ni recorre todos los pendientes.
 */
export async function procesarRegistroBiofile({
  documento,
  fila = 0,
  subirImagenes = true,
  jobId = ''
} = {}) {
  const inicio = Date.now();
  const documentoNormalizado = normalizarDocumento(documento);

  if (!documentoNormalizado && !Number(fila)) {
    throw new Error('Debes indicar el documento o la fila exacta de Google Sheets.');
  }

  validarConfiguracion({
    requiereBiofile: true,
    requiereDefaults: true,
    requiereGoogle: true,
    requiereEscrituraGoogle: true
  });

  asegurarDirectorio(config.paths.logs);
  asegurarDirectorio(config.paths.screenshots);
  const logger = crearLogger(config.paths.logs);

  logger.info('Solicitud de envío a BIOFILE recibida.', {
    jobId: jobId || 'sin-job-id',
    documento: documentoNormalizado || 'no indicado',
    fila: Number(fila) || 'no indicada',
    subirImagenes: Boolean(subirImagenes)
  });

  const base = await new BaseGoogleSheets({
    urlOId: config.google.urlOId,
    hoja: config.google.hoja,
    authMode: config.google.authMode,
    credentialsPath: config.google.credentialsPath,
    credentialsJson: config.google.credentialsJson,
    logger
  }).cargar();

  const [registro] = base.obtenerPendientes({
    max: 1,
    documento: documentoNormalizado,
    fila: Number(fila) || 0
  });

  if (!registro) {
    throw new Error(
      'No se encontró un registro PENDIENTE o con ERROR para ese documento. ' +
      'Verifica la cédula y el estado ESTADO_BIOFILE en Google Sheets.'
    );
  }

  // Localidad, municipio de residencia, EPS, AFP y ARL son columnas nuevas y
  // opcionales. Las hojas antiguas siguen usando los valores predeterminados.
  const datosAdicionales = await obtenerDatosRegistroAdicionales({
    google: config.google,
    row: registro.row,
    logger
  });
  Object.assign(registro, datosAdicionales);

  let sesion;
  let biofile;
  let numeroOrden = '';
  let ordenCreada = false;
  let marcadoProcesando = false;

  try {
    sesion = await crearSesion(config, logger);
    biofile = new BiofileClient({
      page: sesion.page,
      context: sesion.context,
      config,
      logger
    });

    await sesion.asegurarLogin();
    await biofile.abrirOrdenNueva();

    const defaults = {
      ...config.defaults,
      empresaMision: config.usarEmpresaExcel && registro.empresaExcel
        ? registro.empresaExcel
        : config.defaults.empresaMision
    };

    const resultadoLlenado = await biofile.llenarOrden(registro, defaults);

    // El llenado normal conserva municipio Bogotá y sede. Después se reemplazan
    // únicamente localidad (cuando existe) y las afiliaciones del formulario.
    await aplicarDatosRegistroBiofile({
      page: sesion.page,
      config,
      registro,
      defaults,
      logger
    });

    // Se marca aquí, cuando el formulario ya quedó lleno y está listo para guardar.
    await base.marcarProcesando(registro.row);
    marcadoProcesando = true;

    await biofile.guardarYCerrarExito();
    numeroOrden = await biofile.obtenerNumeroOrden();
    ordenCreada = true;

    await base.marcarOrdenCreada(registro.row, numeroOrden);

    if (subirImagenes) {
      await biofile.subirFotoFirma(registro);
      await biofile.guardarYCerrarExito();
      numeroOrden = numeroOrden || await biofile.obtenerNumeroOrden();
    }

    await base.marcarCompletado(registro.row, numeroOrden);

    const resultado = {
      ok: true,
      documento: registro.numeroDocumento,
      fila: registro.row,
      numeroOrden,
      pacienteExistente: Boolean(resultadoLlenado?.pacienteExistente),
      imagenesEnviadas: Boolean(subirImagenes),
      duracionSegundos: duracionSegundos(inicio)
    };

    logger.info('Registro enviado a BIOFILE correctamente.', resultado);
    return resultado;
  } catch (error) {
    const captura = biofile
      ? await biofile.captura(`error-endpoint-${registro.row}`).catch(() => '')
      : '';

    logger.error('Falló el envío a BIOFILE.', {
      jobId: jobId || 'sin-job-id',
      documento: registro.numeroDocumento,
      fila: registro.row,
      ordenCreada,
      numeroOrden,
      marcadoProcesando,
      error: error.message,
      captura
    });

    await base.marcarError(registro.row, error, {
      parcial: ordenCreada,
      numeroOrden
    }).catch((errorHoja) => {
      logger.error('También falló la actualización del estado en Google Sheets.', {
        error: errorHoja.message
      });
    });

    const errorPublico = new Error(error.message);
    errorPublico.cause = error;
    errorPublico.detalle = {
      documento: registro.numeroDocumento,
      fila: registro.row,
      numeroOrden,
      estado: ordenCreada ? 'PARCIAL' : 'ERROR'
    };
    throw errorPublico;
  } finally {
    if (sesion) {
      await sesion.context.storageState({ path: config.browser.authPath }).catch(() => {});
      await sesion.context.close().catch(() => {});
      await sesion.browser.close().catch(() => {});
    }
  }
}
