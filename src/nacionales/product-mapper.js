import fs from 'node:fs';
import { norm } from './normalize.js';

export const catalog = JSON.parse(fs.readFileSync(new URL('../../config/nacionales/product-catalog.json', import.meta.url), 'utf8'));
export const automaticCityMap = JSON.parse(fs.readFileSync(new URL('../../config/nacionales/city-product-map.json', import.meta.url), 'utf8'));

export const mappingKey = (city, exam) => `${norm(city)}::${norm(exam)}`;

const CANONICAL_EXAMS = new Map([
  ['AUDIOMETRIA','AUDIOMETRÍA'],
  ['VISIOMETRIA','VISIOMETRÍA'],
  ['OPTOMETRIA','OPTOMETRÍA'],
  ['EXAMEN MEDICO OCUPACIONAL','EXAMEN MÉDICO OCUPACIONAL']
]);

const CITY_ALIASES = new Map([
  ['BOGOTA','BOGOTÁ'],
  ['BOGOTA D C','BOGOTÁ'],
  ['MEDELLIN','MEDELLÍN'],
  ['CUCUTA','CÚCUTA'],
  ['MONTERIA','MONTERÍA'],
  ['MANIZALEZ','MANIZALES'],
  ['MANIZALES','MANIZALES'],
  ['SANTA MARTHA','SANTA MARTA']
]);

export function canonicalExam(exam) {
  const n=norm(exam);
  for (const [key,value] of CANONICAL_EXAMS) if (n.includes(key)) return value;
  return String(exam || '').trim();
}

export function canonicalProductCity(city) {
  const n=norm(city);
  if (!n) return '';
  return CITY_ALIASES.get(n) || [...Object.keys(automaticCityMap.cities || {})].find(x => norm(x) === n) || String(city || '').trim().toUpperCase();
}

export function automaticProductMapping(city, exam) {
  const canonicalCity=canonicalProductCity(city);
  const canonical=canonicalExam(exam);
  const id=automaticCityMap.cities?.[canonicalCity]?.[canonical];
  if (!id) return null;
  const product=catalog.find(p => p.id === String(id) && p.active);
  if (!product) return null;
  const defaults=automaticCityMap.defaults || {};
  return {
    city: canonicalCity,
    exam: canonical,
    productId: product.id,
    biofileProduct: product.name,
    prestador: defaults.prestador || 'No Aplica',
    formaPago: defaults.formaPago || 'CONTADO',
    cantidad: Number(defaults.cantidad) || 1,
    valor: defaults.valor == null ? null : Number(defaults.valor),
    activo: true,
    automatico: true
  };
}

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
  for (const rawExam of [...new Set(concept.exams || [])]) {
    const exam=canonicalExam(rawExam);
    const explicit = mappings.find(m => m.activo && mappingKey(m.city, m.exam) === mappingKey(concept.cityExam, exam));
    const mapping = explicit ? validateProductMapping(explicit) : automaticProductMapping(concept.cityExam, exam);
    if (!mapping) {
      errors.push(`No se encontró un producto BIOFILE para “${exam}” en ${concept.cityExam || 'la ciudad seleccionada'}. Revise Ajustes avanzados.`);
    } else {
      products.push(mapping);
    }
  }
  if (new Set(products.map(p => p.productId)).size !== products.length) errors.push('Dos exámenes apuntan al mismo producto. Revise el mapeo.');
  return { products, errors };
}
