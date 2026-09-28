import { config, configParaUsuario } from '../config.js';
import { crearSesion } from '../browser.js';
import { BiofileClient } from '../biofile.js';
import { BiofileProducts } from '../biofile-products.js';
import { normalizarTipoEvaluacion } from '../catalogo-paquetes-biofile.js';
export async function processNational({ usuario, job, onProgress, signal }) {
  const cfg = { ...configParaUsuario(usuario), strictOrder: true };
  let session;
  try {
    await onProgress({ porcentaje: 35, etapa: 'Verificando sesión BIOFILE' });
    session = await crearSesion(cfg, null);
    const client = new BiofileClient({ page: session.page, context: session.context, config: cfg, logger: null });
    await session.asegurarLogin(); signal.throwIfAborted();
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
    await onProgress({ porcentaje: 52, etapa: 'Diligenciando paciente' });
    await client.llenarOrden(registro, { ...config.defaults, strictCompany: true, tipoEvaluacion: tipo, acuerdo: job.company.acuerdoBiofile, empresaMision: job.company.empresaMisionBiofile, paquete: 'NO APLICA', productoServicio: '', eps: employment.eps, afp: employment.afp, arl: employment.arl });
    // Fail before saving if the observed product controls are absent.
    await products.available();
    await onProgress({ porcentaje: 72, etapa: 'Validando orden', ultimoPasoEjecutado: 'Formulario diligenciado' });
    await onProgress({ porcentaje: 78, etapa: 'Guardando orden', guardadoIntentado: true, event: 'ORDER_SUBMIT_INTENT' });
    await client.guardarYCerrarExito();
    await onProgress({ guardadoConfirmado: true, persist: true, event: 'ORDER_CONFIRMED' });
    numeroOrden = await client.obtenerNumeroOrden();
    if (!numeroOrden) throw new Error('BIOFILE confirmó el guardado pero no se pudo leer la orden. Verifique antes de continuar.');
    await onProgress({ porcentaje: 82, etapa: 'Orden creada', numeroOrden, ultimoPasoEjecutado: 'Orden confirmada' });
    }
    const added = [];
    const previouslyConfirmed = job.productosAgregados || [];
    for (let i = 0; i < job.products.length; i++) {
      signal.throwIfAborted();
      await onProgress({ porcentaje: 85 + Math.floor(12 * i / job.products.length), etapa: `Agregando producto ${i + 1} de ${job.products.length}` });
      const product = job.products[i];
      const existing = await products.find(product);
      if (existing.length) {
        if (!products.matches(existing, product)) throw new Error('El producto existente no coincide en cantidad, prestador o forma de pago. Requiere conciliación.');
        added.push({ productId:product.productId,nombre:product.biofileProduct,cantidad:product.cantidad,confirmadoEn:new Date().toISOString(),reconciliado:true });
      } else {
        if (previouslyConfirmed.some(p=>p.productId===product.productId)) throw new Error('Un producto confirmado no aparece en la tabla. Verifique la orden antes de agregarlo otra vez.');
        added.push(await products.add(product));
      }
      await onProgress({ productosAgregados: [...added], persist: true, event: 'PRODUCT_ADD_COMPLETED', ultimoPasoEjecutado: `Producto ${i + 1} confirmado` });
    }
    await onProgress({ porcentaje: 98, etapa: 'Confirmando guardado final' });
    await client.guardarYCerrarExito();
    for (const p of job.products) if (!products.matches(await products.find(p),p)) throw new Error('No se confirmó la persistencia del producto después del guardado final.');
    return { numeroOrden, productosAgregados: added, imagenesEnviadas: false };
  } catch (error) {
    if (session && !signal.aborted) {
      const captura = await session.diagnose(job.id).catch(() => '');
      if (captura) await onProgress({ captura }).catch(() => {});
    }
    throw error;
  } finally { if (session) await session.browser.close(); }
}
