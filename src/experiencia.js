function limpiar(valor) {
  return String(valor ?? '').trim().replace(/\s+/g, ' ');
}

function nombreCompleto(registro = {}) {
  return [registro.primerNombre, registro.otrosNombres, registro.primerApellido, registro.segundoApellido]
    .map(limpiar).filter(Boolean).join(' ');
}

export async function notificarExperiencia({ registro, numeroOrden = '', usuario = '', modoIngreso = 'AUTOMATICO', fechaIngresoBiofileIso = '', logger } = {}) {
  const url = limpiar(process.env.EXPERIENCIA_WEBHOOK_URL);
  const token = limpiar(process.env.EXPERIENCIA_WEBHOOK_TOKEN);
  if (!url || !token) {
    const motivo = 'Integracion de experiencia no configurada.';
    logger?.warn(motivo);
    return { ok: false, omitido: true, motivo };
  }

  const payload = {
    evento: 'BIOFILE_COMPLETADO',
    token,
    documento: limpiar(registro?.numeroDocumento),
    nombreCompleto: nombreCompleto(registro),
    correo: limpiar(registro?.correo).toLowerCase(),
    empresa: limpiar(registro?.empresaExcel),
    numeroOsBiofile: limpiar(numeroOrden),
    usuarioBiofile: limpiar(usuario),
    modoIngreso: limpiar(modoIngreso).toUpperCase() || 'AUTOMATICO',
    fechaIngresoBiofileIso: limpiar(fechaIngresoBiofileIso) || new Date().toISOString()
  };

  if (!payload.documento || !payload.nombreCompleto) {
    return { ok: false, omitido: true, motivo: 'Faltan documento o nombre.' };
  }

  let ultimoError = null;
  for (let intento = 1; intento <= 3; intento += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'follow',
        signal: AbortSignal.timeout(10000)
      });
      const texto = await response.text();
      let data = {};
      try { data = texto ? JSON.parse(texto) : {}; } catch {}
      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      return {
        ok: true,
        idEncuesta: data.idEncuesta || '',
        fila: data.fila || 0,
        duplicado: Boolean(data.duplicado),
        fechaProgramada: data.fechaProgramada || ''
      };
    } catch (error) {
      ultimoError = error;
      logger?.warn('Fallo webhook experiencia.', { intento, error: error.message });
      if (intento < 3) await new Promise((resolve) => setTimeout(resolve, 500 * intento));
    }
  }

  return { ok: false, omitido: false, error: ultimoError?.message || 'Error webhook experiencia.' };
}
