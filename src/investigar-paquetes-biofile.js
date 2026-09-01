import path from 'node:path';
import { configParaUsuario } from './config.js';
import { crearSesion } from './browser.js';
import { BiofileClient } from './biofile.js';
import { crearLogger } from './logger.js';
import { asegurarDirectorio, normalizar } from './util.js';
import { TIPOS_EVALUACION_BIOFILE } from './catalogo-paquetes-biofile.js';

/**
 * Obtiene paquetes usando los autocompletados reales del formulario de
 * órdenes. Así no depende del modal WebForms de Acuerdos Comerciales.
 */
export async function investigarPaquetesEmpresaBiofile({ empresa, usuario, loggerExterno }) {
  const empresaBuscada = String(empresa || '').trim();
  if (!empresaBuscada) throw new Error('La empresa es obligatoria para investigar paquetes.');
  if (!usuario?.usuario || !usuario?.contrasena) {
    throw new Error('No hay un usuario BIOFILE disponible para investigar paquetes.');
  }
  const usuarioCatalogo = { ...usuario, id: 'catalogo_' + (usuario.id || usuario.usuario) };
  const configUsuario = configParaUsuario(usuarioCatalogo);
  configUsuario.paths.screenshots = path.join(configUsuario.paths.screenshots, 'catalogo');
  asegurarDirectorio(configUsuario.paths.logs);
  asegurarDirectorio(configUsuario.paths.screenshots);
  const logger = loggerExterno || crearLogger(configUsuario.paths.logs);

  let sesion;
  try {
    logger.info('Iniciando investigación desde el formulario de órdenes BIOFILE.', {
      empresa: empresaBuscada, usuario: usuario.usuario
    });
    sesion = await crearSesion(configUsuario, logger);
    await sesion.asegurarLogin();
    const biofile = new BiofileClient({
      page: sesion.page, context: sesion.context, config: configUsuario, logger
    });
    const resultado = await biofile.investigarCatalogoEmpresa({
      acuerdo: empresaBuscada, tiposEvaluacion: TIPOS_EVALUACION_BIOFILE
    });
    const relaciones = (resultado.paquetes || [])
      .filter((item) => item?.nombre && TIPOS_EVALUACION_BIOFILE.includes(item?.tipoEvaluacion))
      .filter((item, indice, lista) => lista.findIndex((otro) =>
        normalizar(otro.nombre) === normalizar(item.nombre) &&
        normalizar(otro.tipoEvaluacion) === normalizar(item.tipoEvaluacion)
      ) === indice);
    const nombresPaquetes = relaciones.map((item) => item.nombre)
      .filter((nombre, indice, lista) =>
        lista.findIndex((otro) => normalizar(otro) === normalizar(nombre)) === indice
      );
    logger.info('Investigación finalizada desde Órdenes de Servicio.', {
      empresa: empresaBuscada,
      acuerdoExacto: resultado.acuerdoExacto || empresaBuscada,
      empresasMisionDetectadas: (resultado.empresasMision || []).length,
      paquetesDetectados: nombresPaquetes.length,
      relacionesValidas: relaciones.length
    });
    return {
      empresaBuscada,
      acuerdoExacto: resultado.acuerdoExacto || empresaBuscada,
      empresasMision: resultado.empresasMision || [],
      paquetes: relaciones,
      paquetesDetectados: nombresPaquetes.length,
      nombresPaquetes,
      diagnostico: resultado.diagnostico || [],
      metodo: 'AUTOCOMPLETADOS_ORDENES_BIOFILE',
      investigadoEnIso: new Date().toISOString()
    };
  } catch (error) {
    if (!error.detalleCatalogo) {
      error.detalleCatalogo = {
        paso: 'AUTOCOMPLETADOS_ORDENES_BIOFILE', empresaBuscada, mensaje: error.message
      };
    }
    throw error;
  } finally {
    await sesion?.browser?.close().catch(() => {});
  }
}
