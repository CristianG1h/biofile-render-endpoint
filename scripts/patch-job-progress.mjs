import fs from 'node:fs';

const procesarPath = new URL('../src/procesar-registro.js', import.meta.url);
const serverPath = new URL('../src/server.js', import.meta.url);

function reemplazar(texto, buscar, reemplazo, etiqueta) {
  if (!texto.includes(buscar)) {
    throw new Error(`No se encontró ${etiqueta}. Revisa si cambió el archivo fuente.`);
  }
  return texto.replace(buscar, reemplazo);
}

let procesar = fs.readFileSync(procesarPath, 'utf8');
if (!procesar.includes('/* JOB_PROGRESS_V1 */')) {
  procesar = reemplazar(
    procesar,
    "  jobId = '',\n  usuario\n} = {}) {",
    "  jobId = '',\n  usuario,\n  onProgress = () => {}\n} = {}) {",
    'la firma de procesarRegistroBiofile'
  );

  procesar = reemplazar(
    procesar,
    "  const inicio = Date.now();\n  const documentoNormalizado = normalizarDocumento(documento);",
    "  const inicio = Date.now();\n  /* JOB_PROGRESS_V1 */\n  const reportar = async (porcentaje, etapa, detalle = '', extra = {}) => {\n    try {\n      await onProgress({ porcentaje, etapa, detalle, ...extra });\n    } catch {\n      // El progreso visual nunca debe interrumpir el ingreso real a BIOFILE.\n    }\n  };\n  const documentoNormalizado = normalizarDocumento(documento);",
    'el inicio del procesador'
  );

  procesar = reemplazar(
    procesar,
    "  const base = await new BaseGoogleSheets({",
    "  await reportar(8, 'Leyendo datos del paciente', 'Consultando el registro y validando la información de Google Sheets.');\n\n  const base = await new BaseGoogleSheets({",
    'la lectura de Google Sheets'
  );

  procesar = reemplazar(
    procesar,
    "  // BIOFILE exige estrato.",
    "  await reportar(15, 'Registro localizado', 'El paciente fue encontrado. Validando datos obligatorios antes de abrir BIOFILE.');\n\n  // BIOFILE exige estrato.",
    'la validación del registro'
  );

  procesar = reemplazar(
    procesar,
    "  const datosAdicionales = await obtenerDatosRegistroAdicionales({",
    "  await reportar(20, 'Preparando información', 'Completando datos adicionales, afiliaciones y valores requeridos para la orden.');\n\n  const datosAdicionales = await obtenerDatosRegistroAdicionales({",
    'los datos adicionales'
  );

  procesar = reemplazar(
    procesar,
    "    sesion = await crearSesion(configUsuario, logger);",
    "    await reportar(27, 'Abriendo navegador BIOFILE', 'Creando la sesión privada de este usuario.');\n    sesion = await crearSesion(configUsuario, logger);",
    'la creación del navegador'
  );

  procesar = reemplazar(
    procesar,
    "    await sesion.asegurarLogin();\n    await biofile.abrirOrdenNueva();",
    "    await reportar(34, 'Iniciando sesión en BIOFILE', 'Verificando que BIOFILE esté abierto con el usuario correcto.');\n    await sesion.asegurarLogin();\n    await reportar(42, 'Abriendo nueva orden', 'Ingresando al formulario de órdenes de servicios de salud ocupacional.');\n    await biofile.abrirOrdenNueva();",
    'el inicio de sesión y apertura de orden'
  );

  procesar = reemplazar(
    procesar,
    "    const resultadoLlenado = await biofile.llenarOrden(registro, defaults);",
    "    await reportar(52, 'Diligenciando datos principales', 'Ingresando identificación, nombres, nacimiento, ubicación, empresa, cargo y afiliaciones.');\n    const resultadoLlenado = await biofile.llenarOrden(registro, defaults);",
    'el llenado principal'
  );

  procesar = reemplazar(
    procesar,
    "    await aplicarDatosRegistroBiofile({",
    "    await reportar(64, 'Completando datos adicionales', 'Aplicando los campos complementarios y valores requeridos por BIOFILE.');\n    await aplicarDatosRegistroBiofile({",
    'los datos complementarios'
  );

  procesar = reemplazar(
    procesar,
    "    await base.marcarProcesando(registro.row, usuario.usuario);",
    "    await reportar(72, 'Validando formulario', 'Los datos están diligenciados. Verificando el formulario antes de guardar la orden.');\n    await base.marcarProcesando(registro.row, usuario.usuario);",
    'la validación previa al guardado'
  );

  procesar = reemplazar(
    procesar,
    "    await biofile.guardarYCerrarExito();\n    numeroOrden = await biofile.obtenerNumeroOrden();",
    "    await reportar(78, 'Guardando orden en BIOFILE', 'Enviando el formulario y esperando la confirmación de BIOFILE.');\n    await biofile.guardarYCerrarExito();\n    numeroOrden = await biofile.obtenerNumeroOrden();",
    'el guardado de la orden'
  );

  procesar = reemplazar(
    procesar,
    "    ordenCreada = true;\n\n    await base.marcarOrdenCreada",
    "    ordenCreada = true;\n    await reportar(84, 'Orden creada correctamente', numeroOrden ? `BIOFILE asignó la N°. O.S. ${numeroOrden}.` : 'La orden fue creada; consultando el número de orden.', { numeroOrden });\n\n    await base.marcarOrdenCreada",
    'la confirmación del número de orden'
  );

  procesar = reemplazar(
    procesar,
    "    if (subirImagenes) {\n      await biofile.subirFotoFirma(registro);",
    "    if (subirImagenes) {\n      await reportar(89, 'Subiendo foto y firma', 'Adjuntando las imágenes del paciente a la orden creada.', { numeroOrden });\n      await biofile.subirFotoFirma(registro);",
    'la subida de imágenes'
  );

  procesar = reemplazar(
    procesar,
    "      await biofile.guardarYCerrarExito();\n      numeroOrden = numeroOrden || await biofile.obtenerNumeroOrden();\n    }\n\n    await base.marcarCompletado",
    "      await biofile.guardarYCerrarExito();\n      numeroOrden = numeroOrden || await biofile.obtenerNumeroOrden();\n      await reportar(95, 'Confirmando foto y firma', 'BIOFILE recibió los archivos. Verificando el cierre final de la orden.', { numeroOrden });\n    } else {\n      await reportar(95, 'Finalizando orden', 'La orden no requiere envío de foto y firma. Preparando el cierre final.', { numeroOrden });\n    }\n\n    await reportar(98, 'Actualizando registro', 'Guardando en Google Sheets el estado final y el número de orden.', { numeroOrden });\n    await base.marcarCompletado",
    'la finalización del proceso'
  );

  procesar = reemplazar(
    procesar,
    "    const resultado = {",
    "    await reportar(100, 'Completado en BIOFILE', numeroOrden ? `Proceso terminado correctamente. N°. O.S.: ${numeroOrden}.` : 'Proceso terminado correctamente.', { numeroOrden });\n\n    const resultado = {",
    'el resultado exitoso'
  );

  procesar = reemplazar(
    procesar,
    "  } catch (error) {\n    const captura = biofile",
    "  } catch (error) {\n    await reportar(100, 'Proceso terminado con error', error.message, { numeroOrden, error: error.message });\n    const captura = biofile",
    'el manejo de errores'
  );

  fs.writeFileSync(procesarPath, procesar, 'utf8');
}

let server = fs.readFileSync(serverPath, 'utf8');
if (!server.includes('/* JOB_PUBLIC_PROGRESS_V1 */')) {
  server = reemplazar(
    server,
    "    resultado: job.resultado || null,\n    error: job.error || null\n  };",
    "    resultado: job.resultado || null,\n    error: job.error || null,\n    /* JOB_PUBLIC_PROGRESS_V1 */\n    progreso: Number(job.progreso || 0),\n    etapa: job.etapa || '',\n    detalle: job.detalle || '',\n    numeroOrden: job.numeroOrden || job.resultado?.numeroOrden || job.error?.numeroOrden || ''\n  };",
    'la respuesta pública del trabajo'
  );

  server = reemplazar(
    server,
    "    resultado: null,\n    error: null\n  };",
    "    resultado: null,\n    error: null,\n    progreso: 5,\n    etapa: 'En cola',\n    detalle: `Esperando turno en la cola personal de ${usuario.usuario}.`,\n    numeroOrden: ''\n  };",
    'el objeto inicial del trabajo'
  );

  server = reemplazar(
    server,
    "      job.estado = 'procesando';\n      job.iniciadoEn = ahoraIso();\n      try {",
    "      job.estado = 'procesando';\n      job.iniciadoEn = ahoraIso();\n      job.progreso = 7;\n      job.etapa = 'Iniciando proceso';\n      job.detalle = 'El turno comenzó. Preparando los datos del paciente.';\n      try {",
    'el inicio del trabajo'
  );

  server = reemplazar(
    server,
    "          subirImagenes: job.subirImagenes,\n          jobId: job.id,\n          usuario\n        });",
    "          subirImagenes: job.subirImagenes,\n          jobId: job.id,\n          usuario,\n          onProgress: (info = {}) => {\n            const porcentaje = Number(info.porcentaje);\n            if (Number.isFinite(porcentaje)) job.progreso = Math.max(0, Math.min(100, porcentaje));\n            if (info.etapa) job.etapa = String(info.etapa);\n            if (info.detalle) job.detalle = String(info.detalle);\n            if (info.numeroOrden) job.numeroOrden = String(info.numeroOrden);\n          }\n        });",
    'el callback de progreso'
  );

  server = reemplazar(
    server,
    "        job.estado = 'completado';\n      } catch (error) {",
    "        job.estado = 'completado';\n        job.progreso = 100;\n        job.etapa = 'Completado en BIOFILE';\n        job.numeroOrden = job.resultado?.numeroOrden || job.numeroOrden || '';\n        job.detalle = job.numeroOrden ? `Proceso terminado correctamente. N°. O.S.: ${job.numeroOrden}.` : 'Proceso terminado correctamente.';\n      } catch (error) {",
    'el cierre exitoso del trabajo'
  );

  server = reemplazar(
    server,
    "        job.estado = 'error';\n        job.error = {",
    "        job.estado = 'error';\n        job.progreso = 100;\n        job.etapa = 'Proceso terminado con error';\n        job.detalle = error.message;\n        if (error.detalle?.numeroOrden) job.numeroOrden = String(error.detalle.numeroOrden);\n        job.error = {",
    'el cierre con error del trabajo'
  );

  fs.writeFileSync(serverPath, server, 'utf8');
}

console.log('[BIOFILE] Progreso detallado de trabajos habilitado.');
