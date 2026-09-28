import { config, configParaUsuario } from '../config.js';
import { crearSesion } from '../browser.js';
import { BiofileClient } from '../biofile.js';
import { BiofileProducts } from '../biofile-products.js';
import { normalizarTipoEvaluacion } from '../catalogo-paquetes-biofile.js';
export async function processNational({ usuario, job, onProgress, signal }) {
  const cfg = { ...configParaUsuario(usuario), strictOrder: true };
  let session;
  try {
    await onProgress({ porcentaje: 35, etapa: 'Abriendo sesión BIOFILE', detalle:'Solicitando una sesión disponible para este usuario.' });
    session = await crearSesion(cfg, null);
    await onProgress({ porcentaje: 38, etapa: 'Iniciando sesión en BIOFILE', detalle:'BIOFILE está disponible. Verificando credenciales y formulario.' });
    const client = new BiofileClient({ page: session.page, context: session.context, config: cfg, logger: null });
    await session.asegurarLogin(); signal.throwIfAborted();
    await onProgress({ porcentaje: 42, etapa: 'Sesión BIOFILE verificada', detalle:'Sesión lista. Preparando la orden de servicio.' });
    const products = new BiofileProducts(client);
    let numeroOrden = job.numeroOrden || '';
    if (numeroOrden) {
      await onProgress({ porcentaje:82, etapa:'Reabriendo orden existente' });
      await client.abrirOrdenExistente(numeroOrden, job.documento);
      await products.available();
    } else {
    if (job.guardadoIntentado) throw new Error('La orden requiere conciliación. No se abrirá una orden nueva.');
    await onProgress({ porcentaje: 45, etapa: 'Abriendo orden' });
    await client.abrirOrdenNueva();
    const p = job.concept.patient, employment = job.concept.employment;
    const registro = { ...p, otrosNombres: p.segundoNombre, fechaNacimiento: p.fechaNacimiento.split('-').reverse().join('/'), profesionCargo: employment.cargo, funcionesCargo: employment.cargo, eps: employment.eps, afp: employment.afp, arl: employment.arl, row: 0 };
    const tipo = normalizarTipoEvaluacion(employment.tipoEvaluacion);
    if (!tipo) throw new Error('Tipo de evaluación no disponible en BIOFILE.');
    await onProgress({ porcentaje: 52, etapa: 'Diligenciando paciente', detalle:'Completando los datos de la orden. Los productos se agregan únicamente después de crear la O.S.' });
    await client.llenarOrden(registro, { ...config.defaults, strictCompany: true, tipoEvaluacion: tipo, acuerdo: job.company.acuerdoBiofile, empresaMision: job.company.empresaMisionBiofile, paquete: 'NO APLICA', productoServicio: '', eps: employment.eps, afp: employment.afp, arl: employment.arl });
    await onProgress({ porcentaje: 72, etapa: 'Validando orden', detalle:'Formulario principal diligenciado. Preparando creación de la orden.', ultimoPasoEjecutado: 'Formulario diligenciado' });
    await onProgress({ porcentaje: 78, etapa: 'Creando orden en BIOFILE', detalle:'Guardando primero la orden, sin agregar productos todavía.', guardadoIntentado: true, event: 'ORDER_SUBMIT_INTENT' });
    await client.guardarYCerrarExito();
    await onProgress({ guardadoConfirmado: true, persist: true, event: 'ORDER_CONFIRMED' });
    numeroOrden = await client.obtenerNumeroOrden();
    if (!numeroOrden) throw new Error('BIOFILE confirmó el guardado pero no se pudo leer la orden. Verifique antes de continuar.');
    await onProgress({ porcentaje: 82, etapa: 'Orden creada', detalle:'O.S. '+numeroOrden+' creada correctamente. Ahora se habilitarán y agregarán los productos.', numeroOrden, ultimoPasoEjecutado: 'Orden confirmada' });
    await products.available({ timeoutMs: 20000 });
    }
    const added = [];
    const previouslyConfirmed = job.productosAgregados || [];
    for (let i = 0; i < job.products.length; i++) {
      signal.throwIfAborted();
      await onProgress({ porcentaje: 85 + Math.floor(12 * i / job.products.length), etapa: `Agregando producto ${i + 1} de ${job.products.length}` });
      const product = job.products[i];
      const existing = await products.find(product);
      if (existing.length) {
        if (!products.matches(existing, product)) throw new Error('El producto existente no coincide con el nombre o la cantidad esperados. Requiere conciliación.');
        added.push({ productId:product.productId,nombre:product.biofileProduct,cantidad:product.cantidad,confirmadoEn:new Date().toISOString(),reconciliado:true });
      } else {
        if (previouslyConfirmed.some(p=>p.productId===product.productId)) throw new Error('Un producto confirmado no aparece en la tabla. Verifique la orden antes de agregarlo otra vez.');
        added.push(await products.add(product));
      }
      await onProgress({ productosAgregados: [...added], persist: true, event: 'PRODUCT_ADD_COMPLETED', ultimoPasoEjecutado: `Producto ${i + 1} confirmado` });
    }
    await onProgress({ porcentaje: 98, etapa: 'Verificando productos guardados', detalle:'Cada producto se guarda con el botón de la fila de productos; no se modifican Prestador, valores ni Forma de Pago.' });
    for (const p of job.products) if (!products.matches(await products.find(p),p)) throw new Error('BIOFILE no confirmó uno de los productos en la O.S. '+numeroOrden+'. No se creará otra orden.');
    return { numeroOrden, productosAgregados: added, imagenesEnviadas: false };
  } catch (error) {
    if (session && !signal.aborted) {
      const captura = await session.diagnose(job.id).catch(() => '');
      if (captura) await onProgress({ captura }).catch(() => {});
    }
    throw error;
  } finally { if (session) await session.browser.close(); }
}
