export async function reconcileLegacy(base, liveJobs = new Map()) {
  const records = base.listarRegistros(); let count = 0;
  for (const r of records) {
    const state = String(r.ESTADO_BIOFILE || '').toUpperCase();
    if (!['PROCESANDO','GUARDANDO','ORDEN_CREADA'].includes(state)) continue;
    const job = liveJobs.get(r.JOB_ID_BIOFILE);
    if (job && ['en_cola','procesando'].includes(job.estado)) continue;
    const order = String(r.NUMERO_OS_BIOFILE || '');
    const attempted = String(r.GUARDADO_INTENTADO_BIOFILE || '').toUpperCase() !== 'NO';
    await base.actualizarCampos(r._FILA_SHEETS, {
      ESTADO_BIOFILE: order ? 'PARCIAL' : attempted ? 'REVISAR_BIOFILE' : 'INTERRUMPIDO',
      ERROR_BIOFILE: 'Trabajo sin ejecutor activo después de reiniciar. Revise la orden antes de reenviar.',
      ULTIMA_ETAPA_BIOFILE: 'RECUPERACION_REINICIO'
    }); count++;
  }
  return count;
}
