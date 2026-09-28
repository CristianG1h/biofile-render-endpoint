import { config, configParaUsuario, validarConfiguracion } from './config.js';
import { BaseGoogleSheets } from './google-sheets.js';
import { crearSesion } from './browser.js';
import { BiofileClient } from './biofile.js';
import { crearLogger } from './logger.js';
import { asegurarDirectorio } from './util.js';
import { obtenerDatosRegistroAdicionales } from './datos-registro-adicionales.js';
import { aplicarDatosRegistroBiofile } from './aplicar-datos-registro.js';
import { notificarExperiencia } from './experiencia.js';
import { resolverRelacionEmpresaRegistro } from './relacion-empresa.js';
import { normalizarTipoEvaluacion } from './catalogo-paquetes-biofile.js';

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
  empresaCatalogo = '',
  tipoEvaluacion = '',
  paquete = 'NO APLICA',
  jobId = '',
  usuario,
  onProgress = () => {}
} = {}) {
  const inicio = Date.now();
  /* JOB_PROGRESS_V1 */
  const reportar = async (porcentaje, etapa, detalle = '', extra = {}) => {
    await onProgress({ porcentaje, etapa, detalle, ...extra });
  };
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

  await reportar(8, 'Leyendo datos del paciente', 'Consultando el registro y validando la información de Google Sheets.');

  const base = await new BaseGoogleSheets({
    urlOId: config.google.urlOId,
    hoja: config.google.hoja,
    authMode: config.google.authMode,
    credentialsPath: config.google.credentialsPath,
    credentialsJson: config.google.credentialsJson,
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

  await reportar(15, 'Registro localizado', 'El paciente fue encontrado. Validando datos obligatorios antes de abrir BIOFILE.');

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

  await reportar(20, 'Preparando información', 'Completando datos adicionales, afiliaciones y valores requeridos para la orden.');

  const datosAdicionales = await obtenerDatosRegistroAdicionales({
    google: config.google,
    base,
    row: registro.row,
    logger
  });
  Object.assign(registro, datosAdicionales);

  let sesion;
  let biofile;
  let numeroOrden = '';
  let ordenCreada = false;
  let marcadoProcesando = false;
  /* SEGURIDAD_PROCESO_V6 */
  let guardarIntentado = false;

  try {
    // Reclama la fila antes de abrir BIOFILE para que el estado persistente deje de ser PENDIENTE.
    await base.marcarProcesando(registro.row, usuario.usuario, jobId);
    marcadoProcesando = true;
    await reportar(27, 'Abriendo navegador BIOFILE', 'Creando la sesión privada de este usuario.');
    sesion = await crearSesion(configUsuario, logger);
    biofile = new BiofileClient({
      page: sesion.page,
      context: sesion.context,
      config: configUsuario,
      logger
    });

    await reportar(34, 'Iniciando sesión en BIOFILE', 'Verificando que BIOFILE esté abierto con el usuario correcto.');
    await sesion.asegurarLogin();
    await base.marcarSesionVerificada(registro.row, usuario.usuario, jobId);
    await reportar(42, 'Abriendo nueva orden', 'Ingresando al formulario de órdenes de servicios de salud ocupacional.');
    await biofile.abrirOrdenNueva();

    const defaults = {
      ...configUsuario.defaults,
      empresaMision: configUsuario.usarEmpresaExcel && registro.empresaExcel
        ? registro.empresaExcel
        : configUsuario.defaults.empresaMision
    };

    await reportar(52, 'Diligenciando datos principales', 'Ingresando identificación, nombres, nacimiento, ubicación, empresa, cargo y afiliaciones.');
    /* RELACION_EMPRESA_BIOFILE_V69B_PROCESAR */
    const relacionEmpresa = await resolverRelacionEmpresaRegistro(registro, {
      fallbackAcuerdo: configUsuario.defaults.acuerdo || 'PARTICULARES',
      fallbackEmpresaMision: configUsuario.defaults.empresaMision || 'PARTICULARES',
      logger
    });

    defaults.acuerdoFallback = configUsuario.defaults.acuerdo || 'PARTICULARES';
    defaults.empresaMisionFallback = configUsuario.defaults.empresaMision || 'PARTICULARES';
    defaults.acuerdo = relacionEmpresa.acuerdo;
    defaults.empresaMision = relacionEmpresa.empresaMision;

    logger.info('Relación empresarial preparada para BIOFILE.', {
      acuerdo: defaults.acuerdo,
      empresaMision: defaults.empresaMision,
      fallback: Boolean(relacionEmpresa.fallback),
      fuente: relacionEmpresa.fuente || relacionEmpresa.motivo || 'sin-fuente',
      catalogo: relacionEmpresa.catalogo || ''
    });

    /* CATALOGO_PAQUETES_BIOFILE_V7_PROCESAR */
    const tipoEvaluacionSeleccionado = normalizarTipoEvaluacion(tipoEvaluacion || defaults.tipoEvaluacion);
    if (!tipoEvaluacionSeleccionado) {
      throw new Error('El tipo de evaluación recibido no es válido para BIOFILE.');
    }
    defaults.tipoEvaluacion = tipoEvaluacionSeleccionado;
    defaults.paquete = String(paquete || 'NO APLICA').trim() || 'NO APLICA';
    if (String(empresaCatalogo || '').trim()) {
      // El acuerdo exacto que validó el catálogo debe ser el mismo sobre el cual
      // BIOFILE seleccionará el paquete.
      defaults.acuerdo = String(empresaCatalogo).trim();
    }

    logger.info('Tipo de evaluación y paquete preparados para la orden.', {
      empresaPanel: empresaCatalogo || '',
      tipoEvaluacion: defaults.tipoEvaluacion,
      paquete: defaults.paquete
    });

    const resultadoLlenado = await biofile.llenarOrden(registro, defaults);

    await reportar(64, 'Completando datos adicionales', 'Aplicando los campos complementarios y valores requeridos por BIOFILE.');
    await aplicarDatosRegistroBiofile({
      page: sesion.page,
      config: configUsuario,
      registro,
      defaults,
      logger
    });

    await reportar(72, 'Validando formulario', 'Los datos están diligenciados. Verificando el formulario antes de guardar la orden.');
    // Barrera persistente de idempotencia: desde aquí un fallo NUNCA vuelve a ERROR reintentable.
    await base.marcarGuardando(registro.row, usuario.usuario, jobId);
    await onProgress({ guardadoIntentado: true, persist: true, event: 'ORDER_SUBMIT_INTENT' });
    guardarIntentado = true;

    await reportar(78, 'Guardando orden en BIOFILE', 'Enviando el formulario y esperando la confirmación de BIOFILE.');
    await biofile.guardarYCerrarExito();
    // El mensaje de éxito de BIOFILE ya es suficiente para considerar creada la orden.
    // La lectura de O.S. o el cierre visual no pueden volverla a un estado reintentable.
    ordenCreada = true;
    await onProgress({ guardadoConfirmado: true, persist: true, event: 'ORDER_CONFIRMED' });
    numeroOrden = await biofile.obtenerNumeroOrden();
    await reportar(84, 'Orden creada correctamente', numeroOrden ? `BIOFILE asignó la N°. O.S. ${numeroOrden}.` : 'La orden fue creada; consultando el número de orden.', { numeroOrden });

    await base.marcarOrdenCreada(registro.row, numeroOrden, usuario.usuario, jobId);

    const relacionAplicada = resultadoLlenado?.relacionEmpresa || {
      acuerdo: defaults.acuerdo,
      empresaMision: defaults.empresaMision,
      fallback: Boolean(relacionEmpresa.fallback),
      fuente: relacionEmpresa.fuente || relacionEmpresa.motivo || ''
    };

    await base.actualizarCampos(registro.row, {
      ACUERDO_COMERCIAL_BIOFILE: relacionAplicada.acuerdo || defaults.acuerdoFallback,
      EMPRESA_MISION_BIOFILE: relacionAplicada.empresaMision || defaults.empresaMisionFallback,
      ORIGEN_RELACION_EMPRESA: relacionAplicada.fallback
        ? 'FALLBACK_PARTICULARES'
        : String(relacionAplicada.fuente || 'CATALOGO_EXCEL')
    });

    if (subirImagenes) {
      await reportar(89, 'Subiendo foto y firma', 'Adjuntando las imágenes del paciente a la orden creada.', { numeroOrden });
      await biofile.subirFotoFirma(registro);
      await biofile.guardarYCerrarExito();
      numeroOrden = numeroOrden || await biofile.obtenerNumeroOrden();
      await reportar(95, 'Confirmando foto y firma', 'BIOFILE recibió los archivos. Verificando el cierre final de la orden.', { numeroOrden });
    } else {
      await reportar(95, 'Finalizando orden', 'La orden no requiere envío de foto y firma. Preparando el cierre final.', { numeroOrden });
    }

    await reportar(98, 'Actualizando registro', 'Guardando en Google Sheets el estado final y el número de orden.', { numeroOrden });
    await base.marcarCompletado(registro.row, numeroOrden, usuario.usuario, 'AUTOMATICO');

    const experiencia = { estado: 'programada' };
    void notificarExperiencia({
      registro,
      numeroOrden,
      usuario: usuario.usuario,
      modoIngreso: 'AUTOMATICO',
      fechaIngresoBiofileIso: new Date().toISOString(),
      logger
    }).catch(() => {});

    await reportar(100, 'Completado en BIOFILE', numeroOrden ? `Proceso terminado correctamente. N°. O.S.: ${numeroOrden}.` : 'Proceso terminado correctamente.', { numeroOrden });

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
    // Preserve the last real stage and percentage on error.
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
      usuario: usuario.usuario,
      guardarIntentado,
      jobId
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
      captura,
      estado: ordenCreada ? 'PARCIAL' : guardarIntentado ? 'REVISAR_BIOFILE' : 'ERROR'
    };
    throw errorPublico;
  } finally {
    if (sesion) {
      await sesion.browser.close().catch(() => {});
    }
  }
}
