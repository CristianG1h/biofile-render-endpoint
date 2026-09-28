import { activity, checkCancelled } from './jobs/execution.js';
const normalized = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g,' ').trim().toUpperCase();
export function money(value) {
  let text=String(value ?? '').replace(/[^\d,.-]/g,'');
  if (!text) return NaN;
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(text)) text=text.replace(/[.,]/g,'');
  else if (/[.,]\d{1,2}$/.test(text)) { const index=Math.max(text.lastIndexOf(','),text.lastIndexOf('.')); text=text.slice(0,index).replace(/[.,]/g,'')+'.'+text.slice(index+1); }
  return Number(text);
}
export class BiofileProducts {
  constructor(client) { this.client = client; this.page = client.page; this.selectors = client.config.selectors.products || {}; }
  table() { return this.page.locator(this.selectors.table || '#TbProducto'); }
  async available({ timeoutMs = 15000 } = {}) {
    const tableSelector = this.selectors.table || '#TbProducto';
    const entrySelector = this.selectors.entry || '#trProducto';
    try {
      await this.page.locator(tableSelector).waitFor({ state:'attached', timeout:timeoutMs });
      await this.page.locator(entrySelector).waitFor({ state:'attached', timeout:timeoutMs });
    } catch {
      throw new Error('La orden fue creada, pero BIOFILE no mostró todavía la sección de productos. No se creará otra orden; reintente únicamente la carga de productos sobre la O.S. existente.');
    }
    if (await this.table().count() !== 1 || await this.page.locator(entrySelector).count() !== 1) {
      throw new Error('La orden fue creada, pero la sección de productos no tiene una estructura válida. No se creará otra orden; revise la O.S. existente.');
    }
  }
  async find(product) {
    return this.table().locator('tr').evaluateAll((rows, expected) => {
      const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toUpperCase();
      return rows.filter(r => r.id !== 'trProducto').map(r => [...r.querySelectorAll('td')].map(c => c.querySelector('select') ? c.querySelector('select option:checked')?.textContent.trim() : c.querySelector('input:not([type=hidden])') ? c.querySelector('input:not([type=hidden])').value.trim() : c.textContent.trim())).filter(cells => cells.some(c => norm(c) === expected));
    }, normalized(product.biofileProduct));
  }
  matches(rows, product) {
    if (rows.length !== 1) return false;
    const cells=rows[0];
    return Number(cells[0])===product.cantidad && normalized(cells[1])===normalized(product.biofileProduct) && normalized(cells[2])===normalized(product.prestador) && normalized(cells[4])===normalized(product.formaPago) && (product.valor == null || Math.abs(money(cells[3])-product.valor)<0.01);
  }
  async add(product) {
    checkCancelled(); await this.available();
    await activity(`Agregando ${product.biofileProduct}`, { campo: 'producto' });
    const existing = await this.find(product);
    if (existing.length) throw new Error('El producto ya aparece en la orden. Requiere conciliación antes de agregar otra unidad.');
    const entry = this.page.locator(this.selectors.entry || '#trProducto');
    const cells = entry.locator(':scope > td');
    if (await cells.count() < 7) throw new Error('La estructura de productos cambió; no se enviará información por posiciones ambiguas.');
    const qty = cells.nth(0).locator('input:not([type=hidden])').first();
    if (await qty.isEditable()) await qty.fill(String(product.cantidad));
    else if (product.cantidad !== 1) throw new Error('BIOFILE no permite editar la cantidad.');
    const name = cells.nth(1).locator('input:not([type=hidden])').first();
    await this.client.seleccionarProductoExacto(name, product.biofileProduct);
    const provider = cells.nth(2).locator('select').first();
    await provider.selectOption({ label: product.prestador });
    const payment = cells.nth(4).locator('select').first();
    await payment.selectOption({ label: product.formaPago });
    if (product.valor !== null) await cells.nth(3).locator('input:not([type=hidden])').first().fill(String(product.valor));
    if (normalized(await name.inputValue()) !== normalized(product.biofileProduct)) throw new Error('El producto seleccionado no coincide exactamente.');
    if (normalized(await provider.locator('option:checked').textContent()) !== normalized(product.prestador)) throw new Error('Prestador incorrecto.');
    const count = await this.table().locator('tr').count();
    const button = entry.locator(this.selectors.add || '#BtnGuardar');
    if (!/AgregarProducto\s*\(/.test(await button.getAttribute('onclick') || '')) throw new Error('El botón no corresponde a AgregarProducto().');
    await activity('Enviando producto a BIOFILE', { persist: true, event: 'PRODUCT_ADD_STARTED' });
    await button.click();
    await this.page.waitForFunction(({ selector, count, expected }) => {
      const table = document.querySelector(selector); if (!table) return false;
      const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toUpperCase();
      return table.querySelectorAll('tr').length > count && [...table.querySelectorAll('tr:not(#trProducto) td')].some(c => norm(c.textContent) === expected);
    }, { selector: this.selectors.table || '#TbProducto', count, expected: normalized(product.biofileProduct) }, { timeout: 15000 });
    const rows = await this.find(product);
    if (!this.matches(rows, product)) throw new Error('No se pudo confirmar cantidad, prestador, valor y pago del producto incorporado.');
    return { productId: product.productId, nombre: product.biofileProduct, cantidad: product.cantidad, confirmadoEn: new Date().toISOString() };
  }
}
