import { config, validarConfiguracion } from './config.js';
import { crearConfigUsuario } from './config-usuario.js';
import { BaseGoogleSheets } from './google-sheets.js';
import { crearSesion } from './browser.js';
import { BiofileClient } from './biofile.js';
import { crearLogger } from './logger.js';
import { asegurarDirectorio } from './util.js';
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
  jobId = '',
  credencialesBiofile,
  sesionBiofileId = ''
} = {}) {
  const inicio = Date.now();
  const documentoNormalizado = normalizarDocumento(documento);
  const configEjecucion = crearConfigUsuario(config, { credencialesBiofile, sesionBiofileId });

  if (!documentoNormalizado && !Number(fila)) {
    throw new Error('Debes indicar el documento o la fila exacta de Google Sheets.');
  }

  validarConfiguracion({
    requiereBiofile: true,
    requiereDefaults: true,
    requiereGoogle: true,
    requiereEscrituraGoogle: true
  }, configEjecucion);

  asegurarDirectorio(configEjecucion.paths.logs);
  asegurarDirectorio(configEjecucion.paths.screenshots);
  const logger = crearLogger(configEjecucion.paths.logs);

  logger.info('Solicitud de envío a BIOFILE recibida.', {
    jobId: jobId || 'sin-job-id',
    documento: documentoNormalizado || 'no indicado',
    fila: Number(fila) || 'no indicada',
    subirImagenes: Boolean(subirImagenes),
    usuarioBiofile: configEjecucion.biofile.usuario
  });

  const base = await new BaseGoogleSheets({
    urlOId: configEjecucion.google.urlOId,
    hoja: configEjecucion.google.hoja,
    authMode: configEjecucion.google.authMode,
    credentialsPath: configEjecucion.google.credentialsPath,
    credentialsJson: configEjecucion.google.credentialsJson,
    logger
  }).cargar({ fila: Number(fila) || 0 });

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

  let sesion;
  let biofile;
  let numeroOrden = '';
  let ordenCreada = false;
  let marcadoProcesando = false;

  try {
    sesion = await crearSesion(configEjecucion, logger);
    biofile = new BiofileClient({
      page: sesion.page,
      context: sesion.context,
      config: configEjecucion,
      logger
    });

    await sesion.asegurarLogin();
    await biofile.abrirOrdenNueva();

    const defaults = {
      ...configEjecucion.defaults,
      empresaMision: configEjecucion.usarEmpresaExcel && registro.empresaExcel
        ? registro.empresaExcel
        : configEjecucion.defaults.empresaMision
    };

    const resultadoLlenado = await biofile.llenarOrden(registro, defaults);

    // El llenado normal conserva municipio Bogotá y sede. Después se reemplazan
    // únicamente localidad (cuando existe) y las afiliaciones del formulario.
    await aplicarDatosRegistroBiofile({
      page: sesion.page,
      config: configEjecucion,
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
      usuarioBiofile: configEjecucion.biofile.usuario,
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
      await sesion.context.storageState({ path: configEjecucion.browser.authPath }).catch(() => {});
      await sesion.context.close().catch(() => {});
      await sesion.browser.close().catch(() => {});
    }
  }
}
