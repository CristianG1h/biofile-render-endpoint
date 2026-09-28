import fs from 'node:fs';
import { norm } from './normalize.js';
export const catalog = JSON.parse(fs.readFileSync(new URL('../../config/nacionales/product-catalog.json', import.meta.url), 'utf8'));
export const mappingKey = (city, exam) => `${norm(city)}::${norm(exam)}`;
export function validateProductMapping(value) {
  const product = catalog.find(p => p.id === String(value.productId) && p.active);
  if (!product) throw new Error('Producto no encontrado en el catálogo importado.');
  if (!value.city || !value.exam || !value.prestador || !value.formaPago) throw new Error('Complete ciudad, examen, prestador y forma de pago.');
  if (!Number.isInteger(Number(value.cantidad)) || Number(value.cantidad) < 1 || Number(value.cantidad) > 20) throw new Error('Cantidad no válida.');
  if (value.valor !== '' && value.valor != null && (!Number.isFinite(Number(value.valor)) || Number(value.valor) < 0)) throw new Error('Valor no válido.');
  return { city: String(value.city).slice(0,100), exam: String(value.exam).slice(0,120), productId: product.id, biofileProduct: product.name, prestador: String(value.prestador).slice(0,150), formaPago: String(value.formaPago).slice(0,60), cantidad: Number(value.cantidad), valor: value.valor === '' || value.valor == null ? null : Number(value.valor), activo: value.activo === true };
}
export function mapProducts(concept, mappings) {
  const products = [], errors = [];
  for (const exam of [...new Set(concept.exams || [])]) {
    const mapping = mappings.find(m => m.activo && mappingKey(m.city, m.exam) === mappingKey(concept.cityExam, exam));
    if (!mapping) errors.push(`PRODUCTO SIN MAPEAR: ${exam} / ${concept.cityExam}`);
    else products.push(validateProductMapping(mapping));
  }
  if (new Set(products.map(p => p.productId)).size !== products.length) errors.push('Dos exámenes apuntan al mismo producto. Revise el mapeo.');
  return { products, errors };
}
