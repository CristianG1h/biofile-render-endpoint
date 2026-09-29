import { activity, checkCancelled } from './jobs/execution.js';

const normalized = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s*\/\/\s*/g,' // ').replace(/\s+/g,' ').trim().toUpperCase();

export function money(value) {
  let text=String(value ?? '').replace(/[^\d,.-]/g,'');
  if (!text) return NaN;
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(text)) text=text.replace(/[.,]/g,'');
  else if (/[.,]\d{1,2}$/.test(text)) {
    const index=Math.max(text.lastIndexOf(','),text.lastIndexOf('.'));
    text=text.slice(0,index).replace(/[.,]/g,'')+'.'+text.slice(index+1);
  }
  return Number(text);
}

export function needsMinimumUnitPrice(value) {
  const parsed=money(value);
  return !Number.isFinite(parsed) || parsed <= 0;
}

async function visible(locator) {
  try { return await locator.count() > 0 && await locator.first().isVisible(); }
  catch { return false; }
}

export class BiofileProducts {
  constructor(client) {
    this.client = client;
    this.page = client.page;
    this.selectors = client.config.selectors.products || {};
  }

  async table() {
    const configured=this.page.locator(this.selectors.table || '#TbProducto').first();
    if (await visible(configured)) return configured;
    const byHeader=this.page.locator('table').filter({hasText:/Nombre del Producto o Servicio/i}).first();
    if (await visible(byHeader)) return byHeader;
    return null;
  }

  async entry() {
    const configured=this.page.locator(this.selectors.entry || '#trProducto').first();
    if (await visible(configured)) return configured;
    const table=await this.table();
    if (!table) return null;
    const rows=table.locator('tr');
    const count=await rows.count();
    for(let i=count-1;i>=0;i--){
      const row=rows.nth(i);
      if (!await row.isVisible().catch(()=>false)) continue;
      const cells=row.locator(':scope > td');
      if (await cells.count() < 5) continue;
      const nameInput=cells.nth(1).locator('input:not([type=hidden])').first();
      if (await visible(nameInput) && await nameInput.isEditable().catch(()=>false)) return row;
    }
    return null;
  }

  async available({ timeoutMs = 20000 } = {}) {
    const until=Date.now()+timeoutMs;
    while(Date.now()<until){
      checkCancelled();
      const table=await this.table();
      const entry=await this.entry();
      if(table && entry) return {table,entry};
      await this.page.waitForTimeout(250);
    }
    throw new Error('La orden fue creada, pero BIOFILE no mostró la fila para agregar productos. No se creará otra orden; use “Reintentar productos” sobre la O.S. existente.');
  }

  async find(product) {
    const table=await this.table();
    if(!table) return [];
    const entry=await this.entry();
    const entryHandle=entry ? await entry.elementHandle() : null;
    try { return await table.locator('tr').evaluateAll((rows, {expected, entry}) => {
      const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s*\/\/\s*/g,' // ').replace(/\s+/g,' ').trim().toUpperCase();
      return rows.filter(r=>r!==entry && r.id!=='trProducto' && !r.querySelector('[onclick*="AgregarProducto"]')).map(r => [...r.querySelectorAll('td')].map(c => {
        const selected=c.querySelector('select option:checked');
        const input=c.querySelector('input:not([type=hidden])');
        return selected ? selected.textContent.trim() : input ? input.value.trim() : c.textContent.trim();
      })).filter(cells => cells.some(c => norm(c) === expected));
    }, {expected:normalized(product.biofileProduct),entry:entryHandle}); } finally { await entryHandle?.dispose(); }
  }

  matches(rows, product) {
    if (rows.length !== 1) return false;
    const cells=rows[0];
    const qty=Number(String(cells[0] || '').replace(/[^\d.-]/g,''));
    const name=cells.some(c=>normalized(c)===normalized(product.biofileProduct));
    return name && Number.isFinite(qty) && qty===Number(product.cantidad || 1);
  }

  async #addButton(entry) {
    const configured=entry.locator(this.selectors.add || '#BtnGuardar').first();
    if(await visible(configured)) return configured;
    const candidates=entry.locator('input[type="image"],input[type="button"],button,a');
    const count=await candidates.count();
    for(let i=0;i<count;i++){
      const c=candidates.nth(i);
      if(!await c.isVisible().catch(()=>false)) continue;
      const meta=[
        await c.getAttribute('onclick').catch(()=>''),
        await c.getAttribute('title').catch(()=>''),
        await c.getAttribute('value').catch(()=>''),
        await c.getAttribute('alt').catch(()=>''),
        await c.getAttribute('src').catch(()=>'')
      ].join(' ');
      if(/AgregarProducto|guardar|agregar|save/i.test(meta)) return c;
    }
    return null;
  }

  async #ensurePositiveUnitPrice(cells) {
    const unit = cells.nth(3).locator('input:not([type=hidden])').first();
    if (!await visible(unit)) return { changed:false, value:NaN };

    // BIOFILE a veces tarda unos milisegundos en cargar el precio del producto.
    // Si llega un valor válido (>0), se conserva exactamente como lo puso BIOFILE.
    const until=Date.now()+1000;
    let current=money(await unit.inputValue().catch(()=>''));
    while(Date.now()<until && needsMinimumUnitPrice(current)){
      await this.page.waitForTimeout(100);
      current=money(await unit.inputValue().catch(()=>''));
    }
    if(!needsMinimumUnitPrice(current)) return { changed:false, value:current };

    if(!await unit.isEditable().catch(()=>false)) {
      throw new Error('BIOFILE dejó el Vr. Unitario en 0 y el campo no permite corregirlo automáticamente.');
    }

    await unit.click({clickCount:3}).catch(()=>{});
    await unit.fill('1');
    await unit.evaluate(el=>{
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
    }).catch(()=>{});
    await unit.press('Tab').catch(()=>{});
    await this.page.waitForTimeout(150);

    let confirmed=money(await unit.inputValue().catch(()=>''));
    if(needsMinimumUnitPrice(confirmed)){
      // Algunos onchange de BIOFILE vuelven a escribir 0. Se fuerza una vez más
      // justo antes de guardar el producto para no enviar un campo rojo.
      await unit.fill('1');
      confirmed=money(await unit.inputValue().catch(()=>''));
    }
    if(needsMinimumUnitPrice(confirmed)) {
      throw new Error('No fue posible establecer un Vr. Unitario mínimo de 1 para el producto.');
    }

    await activity('Vr. Unitario ajustado a 1 porque BIOFILE lo dejó en 0', {
      campo:'valorUnitario',
      persist:true
    });
    return { changed:true, value:confirmed };
  }

  async add(product, { confirmationTimeoutMs = 15000 } = {}) {
    checkCancelled();
    const {table,entry}=await this.available();
    await activity(`Agregando ${product.biofileProduct}`, { campo: 'producto' });

    const existing = await this.find(product);
    if (existing.length) throw new Error('El producto ya aparece en la orden. Se detuvo para evitar duplicarlo.');

    const cells = entry.locator(':scope > td');
    if (await cells.count() < 5) throw new Error('BIOFILE cambió la fila de productos y no es seguro continuar automáticamente.');

    const qty = cells.nth(0).locator('input:not([type=hidden])').first();
    if (await visible(qty) && await qty.isEditable().catch(()=>false)) {
      const current=String(await qty.inputValue().catch(()=>'')).trim();
      if(current!==String(product.cantidad || 1)) await qty.fill(String(product.cantidad || 1));
    }

    const name = cells.nth(1).locator('input:not([type=hidden])').first();
    if(!await visible(name)) throw new Error('BIOFILE no mostró el campo “Nombre del Producto o Servicio”.');
    await this.client.seleccionarProductoExacto(name, product.biofileProduct);

    if (normalized(await name.inputValue()) !== normalized(product.biofileProduct)) {
      throw new Error(`BIOFILE no seleccionó exactamente “${product.biofileProduct}”.`);
    }

    // Prestador y Forma de Pago se conservan tal como BIOFILE los cargue.
    // Vr. Unitario también se conserva, excepto cuando BIOFILE lo deja vacío o en 0:
    // en ese único caso se establece el mínimo 1 para que el producto pueda guardarse.
    await this.page.waitForTimeout(350);
    await this.#ensurePositiveUnitPrice(cells);

    const button=await this.#addButton(entry);
    if(!button) throw new Error('BIOFILE no mostró el botón de guardar/agregar producto.');

    await activity('Guardando producto en BIOFILE', { persist:true, event:'PRODUCT_ADD_STARTED' });
    await button.click();

    // Respaldo para el mensaje "Ingrese los campos en rojo": si BIOFILE vuelve a
    // dejar el unitario en 0 en el instante del guardado, corrige y reintenta una vez.
    await this.page.waitForTimeout(250);
    const redAlert=this.page.getByText(/Ingrese los campos en rojo para guardar el producto/i).first();
    if(await visible(redAlert)){
      const understood=this.page.getByRole('button',{name:/Entendido/i}).first();
      if(await visible(understood)) await understood.click().catch(()=>{});
      await this.#ensurePositiveUnitPrice(cells);
      await button.click();
    }

    const until=Date.now()+confirmationTimeoutMs;
    while(Date.now()<until){
      checkCancelled();
      const rows=await this.find(product);
      if(rows.length===1 && this.matches(rows,product)){
        return {
          productId:product.productId,
          nombre:product.biofileProduct,
          cantidad:product.cantidad || 1,
          confirmadoEn:new Date().toISOString()
        };
      }
      await this.page.waitForTimeout(250);
    }
    throw new Error(`BIOFILE no confirmó la incorporación de “${product.biofileProduct}”. La orden existe; revise antes de reintentar ese producto.`);
  }
}
