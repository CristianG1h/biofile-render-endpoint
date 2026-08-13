import { config, configParaUsuario, validarConfiguracion } from './config.js';
import { BaseGoogleSheets } from './google-sheets.js';
import { crearSesion } from './browser.js';
import { BiofileClient } from './biofile.js';
import { crearLogger } from './logger.js';
import { asegurarDirectorio } from './util.js';
import { obtenerDatosRegistroAdicionales } from './datos-registro-adicionales.js';
import { aplicarDatosRegistroBiofile } from './aplicar-datos-registro.js';
import { notificarExperiencia } from './experiencia.js';

function normalizarDocumento(valor) {
  return String(valor ?? '').trim().replace(/\s+/g, '');
}

function duracionSegundos(inicio) {
  return Number(((Date.now() - inicio) / 1000).toFixed(2));
}

/**
 * Procesa exactamente un paciente con el usuario BIOFILE que originó el trabajo.
 * Cada usuario recibe un storageState independiente, por lo que las sesiones no se mezclan.
 */
export async function procesarRegistroBiofile({
  documento,
  fila = 0,
  subirImagenes = true,
  jobId = '',
  usuario
} = {}) {
  const inicio = Date.now();
  const documentoNormalizado = normalizarDocumento(documento);

  if (!documentoNormalizado && !Number(fila)) {
    throw new Error('Debes indicar el documento o la fila exacta de Google Sheets.');
  }
  if (!usuario?.usuario || !usuario?.contrasena) {
    throw new Error('El trabajo no tiene un usuario BIOFILE asociado.');
  }

  validarConfiguracion({
    requiereBiofile: false,
    requiereDefaults: true,
    requiereGoogle: true,
    requiereEscrituraGoogle: true
  });

  const configUsuario = configParaUsuario(usuario);
  asegurarDirectorio(configUsuario.paths.logs);
  asegurarDirectorio(configUsuario.paths.screenshots);
  const logger = crearLogger(configUsuario.paths.logs);

  logger.info('Solicitud de envío a BIOFILE recibida.', {
    jobId: jobId || 'sin-job-id',
    usuario: usuario.usuario,
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

  // BIOFILE exige estrato. Cuando el formulario lo dejó vacío se usa 1 y se
  // guarda también en Google Sheets para que el dato quede corregido de forma permanente.
  if (!registro.estrato) {
    registro.estrato = '1';
    await base.actualizarCampos(registro.row, { Estrato: '1' });
    logger.info('Estrato vacío corregido automáticamente.', {
      documento: registro.numeroDocumento,
      estrato: '1'
    });
  }

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
    sesion = await crearSesion(configUsuario, logger);
    biofile = new BiofileClient({
      page: sesion.page,
      context: sesion.context,
      config: configUsuario,
      logger
    });

    await sesion.asegurarLogin();
    await biofile.abrirOrdenNueva();

    const defaults = {
      ...configUsuario.defaults,
      empresaMision: configUsuario.usarEmpresaExcel && registro.empresaExcel
        ? registro.empresaExcel
        : configUsuario.defaults.empresaMision
    };

    const resultadoLlenado = await biofile.llenarOrden(registro, defaults);

    await aplicarDatosRegistroBiofile({
      page: sesion.page,
      config: configUsuario,
      registro,
      defaults,
      logger
    });

    await base.marcarProcesando(registro.row, usuario.usuario);
    marcadoProcesando = true;

    await biofile.guardarYCerrarExito();
    numeroOrden = await biofile.obtenerNumeroOrden();
    ordenCreada = true;

    await base.marcarOrdenCreada(registro.row, numeroOrden, usuario.usuario);

    if (subirImagenes) {
      await biofile.subirFotoFirma(registro);
      await biofile.guardarYCerrarExito();
      numeroOrden = numeroOrden || await biofile.obtenerNumeroOrden();
    }

    await base.marcarCompletado(registro.row, numeroOrden, usuario.usuario, 'AUTOMATICO');

    const experiencia = await notificarExperiencia({
      registro,
      numeroOrden,
      usuario: usuario.usuario,
      modoIngreso: 'AUTOMATICO',
      fechaIngresoBiofileIso: new Date().toISOString(),
      logger
    });

    const resultado = {
      ok: true,
      usuario: usuario.usuario,
      documento: registro.numeroDocumento,
      fila: registro.row,
      numeroOrden,
      pacienteExistente: Boolean(resultadoLlenado?.pacienteExistente),
      imagenesEnviadas: Boolean(subirImagenes),
      duracionSegundos: duracionSegundos(inicio),
      experiencia
    };

    logger.info('Registro enviado a BIOFILE correctamente.', resultado);
    return resultado;
  } catch (error) {
    const captura = biofile
      ? await biofile.captura(`error-endpoint-${usuario.id || 'usuario'}-${registro.row}`).catch(() => '')
      : '';

    logger.error('Falló el envío a BIOFILE.', {
      jobId: jobId || 'sin-job-id',
      usuario: usuario.usuario,
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
      numeroOrden,
      usuario: usuario.usuario
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
      await sesion.context.storageState({ path: configUsuario.browser.authPath }).catch(() => {});
      await sesion.context.close().catch(() => {});
      await sesion.browser.close().catch(() => {});
    }
  }
}
