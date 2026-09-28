import { checkCancelled, activity } from './jobs/execution.js';

// Controls verified in the BIOFILE order-search screenshots supplied by the user.
export async function reopenOrder(page, selectors, order, documentId, readCurrent, timeout=15000) {
  const wanted=String(order || '').trim(), doc=String(documentId || '').replace(/[^a-z0-9]/gi,'').toUpperCase();
  if(!wanted || !doc)throw new Error('Se necesita número de orden y documento para reabrir con seguridad.');
  checkCancelled();
  await activity('Abriendo búsqueda de órdenes BIOFILE');
  await page.locator(selectors.orderSearchOpen || '#B_BH_BtnBuscar').click();
  const input=page.locator(selectors.orderSearchInput || '#BuscaNoOrdenServicio');
  await input.waitFor({state:'visible',timeout});
  await input.fill(wanted);
  await page.locator(selectors.orderSearchButton || '#C_BtnAceptaBuscar').click();
  await activity('Buscando la orden existente y verificando su documento');
  await page.waitForFunction(({wanted,doc})=>{
    const normalized=s=>String(s||'').replace(/[^a-z0-9]/gi,'').toUpperCase();
    const rows=[...document.querySelectorAll('tr')].filter(r=>{
      if(!r.getClientRects().length)return false;
      const cells=[...r.querySelectorAll(':scope > td')];
      return cells.length>=3 && cells[1].textContent.trim()===wanted && normalized(cells[2].textContent)===doc && r.querySelector('img[src*="Seleccionar.png"]');
    });
    if(rows.length!==1)return false;
    document.querySelectorAll('[data-biofile-order-result]').forEach(r=>r.removeAttribute('data-biofile-order-result'));
    rows[0].setAttribute('data-biofile-order-result','verified');return true;
  },{wanted,doc},{timeout}).catch(()=>{throw new Error('No se encontró una única fila para la O.S. '+wanted+' y el documento esperado. No se abrirá otra orden.');});
  checkCancelled();
  await page.locator('[data-biofile-order-result="verified"] img[src*="Seleccionar.png"]').click();
  await input.waitFor({state:'hidden',timeout});
  const until=Date.now()+timeout;
  while(Date.now()<until){
    checkCancelled();
    const current=await readCurrent();
    if(String(current.order).trim()===wanted && String(current.documentId).replace(/[^a-z0-9]/gi,'').toUpperCase()===doc)return;
    await page.waitForTimeout(150);
  }
  throw new Error('La orden cargada no coincide con la O.S. y el documento esperados. Se bloqueó el agregado de productos.');
}
