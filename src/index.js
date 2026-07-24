import readline from 'node:readline/promises';
import process from 'node:process';
import { config, validarConfiguracion } from './config.js';
import { BaseGoogleSheets } from './google-sheets.js';
import { crearSesion } from './browser.js';
import { BiofileClient } from './biofile.js';
import { crearLogger } from './logger.js';
import { asegurarDirectorio } from './util.js';

function formatearDuracion(milisegundos) {
  const total = Math.max(
    0,
    Math.round(milisegundos)
  );

  const minutos = Math.floor(total / 60000);

  const segundos = Math.floor(
    (total % 60000) / 1000
  );

  const milisegundosRestantes = total % 1000;

  return (
    `${String(minutos).padStart(2, '0')}:` +
    `${String(segundos).padStart(2, '0')}.` +
    `${String(milisegundosRestantes).padStart(3, '0')}`
  );
}

function argumentos() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [k, v = 'true'] = arg.replace(/^--/, '').split('=');
      return [k, v];
    })
  );

  const modo = String(args.modo || 'revision').toLowerCase();
  const max = args.max
    ? Number(args.max)
    : modo === 'prueba'
      ? 1
      : Infinity;

  const documento = String(args.documento || '').trim();
  const fila = args.fila ? Number(args.fila) : 0;

  return {
    modo,
    max,
    documento,
    fila
  };
}



async function main() {
  const inicioProceso = Date.now();
  const { modo, max, documento, fila } = argumentos();
  if (!['revision', 'prueba', 'produccion'].includes(modo)) {
    throw new Error('Modo inválido. Usa revision, prueba o produccion.');
  }

  validarConfiguracion();

const puedeEscribirHoja =
  config.google.authMode.toLowerCase() === 'service_account';

// En producción sí será obligatorio escribir los estados.
if (modo === 'produccion' && !puedeEscribirHoja) {
  throw new Error(
    'Para producción debes configurar GOOGLE_AUTH_MODE=service_account.'
  );
}

// En prueba pública se crea la orden,
// pero no se modifica Google Sheets.
if (modo === 'prueba' && !puedeEscribirHoja) {
  console.warn(
    '\nAVISO: La prueba continuará con Google Sheets en modo público. ' +
    'La orden se creará en Biofile, pero la hoja no se marcará como COMPLETADO.\n'
  );
}

  asegurarDirectorio(config.paths.logs);
  asegurarDirectorio(config.paths.screenshots);
  const logger = crearLogger(config.paths.logs);
  logger.info('Inicio del proceso.', {
  modo,
  googleSheets: config.google.urlOId,
  hoja: config.google.hoja,
  authMode: config.google.authMode,
  max,
  documento: documento || 'No especificado',
  fila: fila || 'No especificada'
});

  const base = await new BaseGoogleSheets({
    urlOId: config.google.urlOId,
    hoja: config.google.hoja,
    authMode: config.google.authMode,
    credentialsPath: config.google.credentialsPath,
    logger
  }).cargar();

  const registros = base.obtenerPendientes({
  max,
  documento,
  fila
});
  if (!registros.length) {
    logger.info('No hay registros pendientes o con error para procesar.');
    return;
  }
  logger.info('Registros encontrados.', { cantidad: registros.length });

  const sesion = await crearSesion(config, logger);
  const biofile = new BiofileClient({ page: sesion.page, context: sesion.context, config, logger });

  try {
    await sesion.asegurarLogin();

    for (const registro of registros) {
      let numeroOrden = '';
      let ordenCreada = false;
      try {
        await biofile.abrirOrdenNueva();
        const defaults = {
          ...config.defaults,
          empresaMision: config.usarEmpresaExcel && registro.empresaExcel
            ? registro.empresaExcel
            : config.defaults.empresaMision
        };
        const inicioLlenado = Date.now();

let resultadoLlenado;

try {
  resultadoLlenado = await biofile.llenarOrden(
    registro,
    defaults
  );
} finally {
  const duracionLlenadoMs =
    Date.now() - inicioLlenado;

  logger.info('Tiempo de llenado del formulario.', {
    fila: registro.row,
    documento: registro.numeroDocumento,
    completado: Boolean(resultadoLlenado),
    duracion: formatearDuracion(duracionLlenadoMs),
    segundos: Number(
      (duracionLlenadoMs / 1000).toFixed(2)
    )
  });
}

        if (modo === 'revision') {
          const captura = await biofile.captura(`revision-fila-${registro.row}`);
          logger.info('Formulario lleno sin guardar.', { fila: registro.row, captura });
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          await rl.question('Revisa el navegador. Presiona ENTER para terminar sin guardar... ');
          rl.close();
          break;
        }

        if (puedeEscribirHoja) {
        await base.marcarProcesando(registro.row);
        }
        await biofile.guardarYCerrarExito();
        numeroOrden = await biofile.obtenerNumeroOrden();
        ordenCreada = true;
        if (puedeEscribirHoja) {
        await base.marcarOrdenCreada(
          registro.row,
          numeroOrden
          );
        }
        logger.info('Orden inicial creada.', { documento: registro.numeroDocumento, numeroOrden });

        logger.info(
  'Subiendo obligatoriamente la foto y la firma desde Google Sheets.',
  {
    documento: registro.numeroDocumento,
    pacienteExistente: resultadoLlenado.pacienteExistente
  }
);

await biofile.subirFotoFirma(registro);

// Segundo guardado para confirmar la foto y la firma.
await biofile.guardarYCerrarExito();

numeroOrden =
  numeroOrden ||
  await biofile.obtenerNumeroOrden();

logger.info(
  'Foto y firma actualizadas correctamente en Biofile.',
  {
    documento: registro.numeroDocumento,
    numeroOrden
  }
);

        if (puedeEscribirHoja) {
  await base.marcarCompletado(
    registro.row,
    numeroOrden
  );
} else {
  logger.warn(
    'La orden fue completada en Biofile, pero Google Sheets permanece sin cambios porque está en modo público.',
    {
      fila: registro.row,
      documento: registro.numeroDocumento,
      numeroOrden
    }
  );
}
        logger.info('Registro completado.', { fila: registro.row, documento: registro.numeroDocumento, numeroOrden });
      } catch (error) {
        const captura = await biofile.captura(`error-fila-${registro.row}`).catch(() => '');
        logger.error('Falló el registro.', {
          fila: registro.row,
          documento: registro.numeroDocumento,
          error: error.message,
          captura
        });
        if (modo !== 'revision' && puedeEscribirHoja) {
          await base.marcarError(registro.row, error, { parcial: ordenCreada, numeroOrden });
        }
        if (modo === 'prueba') throw error;
      }
    }
  } 
  
  finally {
    await sesion.context.storageState({ path: config.browser.authPath }).catch(() => {});
    await sesion.context.close().catch(() => {});
    await sesion.browser.close().catch(() => {});
  }

  const duracionTotalMs =
  Date.now() - inicioProceso;

logger.info('Proceso finalizado.', {
  duracionTotal: formatearDuracion(duracionTotalMs),
  segundosTotal: Number(
    (duracionTotalMs / 1000).toFixed(2)
  )
});
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}\n`);
  process.exitCode = 1;
});
