import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BiofileProducts } from '../src/biofile-products.js';
import { crearSesion, cerrarNavegador } from '../src/browser.js';
const browser=await chromium.launch({headless:true});
try {
  const sessionConfig=(usuario,password='synthetic-test')=>({biofile:{usuario,contrasena:password},browser:{headless:true,authPath:path.join(process.env.TEMP || '/tmp','biofile-synthetic-test','auth.json')},paths:{screenshots:path.join(process.env.TEMP || '/tmp','biofile-synthetic-test')},selectors:{}});
  const sessionA=await crearSesion(sessionConfig('SYNTHETIC_A'));
  await sessionA.context.addCookies([{name:'account',value:'A',domain:'example.test',path:'/'}]);
  await sessionA.browser.close();
  const sessionB=await crearSesion(sessionConfig('SYNTHETIC_B'));
  assert.equal((await sessionB.context.cookies()).length,0);await sessionB.browser.close();
  const restored=await crearSesion(sessionConfig('SYNTHETIC_A'));
  assert.equal((await restored.context.cookies())[0].value,'A');await restored.browser.close();
  const changed=await crearSesion(sessionConfig('SYNTHETIC_A','new-synthetic-test'));
  assert.equal((await changed.context.cookies()).length,0);await changed.browser.close();
  await cerrarNavegador();
  const page=await browser.newPage();
  await page.setContent(`<table id="TbProducto"><tr><th>Cantidad</th><th>Producto</th><th>Prestador</th><th>Valor</th><th>Pago</th><th>Total</th><th></th></tr><tr id="trProducto"><td><input value="1"></td><td><input></td><td><select><option>No Aplica</option></select></td><td><input value="100"></td><td><select><option>CONTADO</option></select></td><td><input value="100"></td><td><input type="image" id="BtnGuardar" onclick="return AgregarProducto();"></td></tr></table><script>function AgregarProducto(){const tr=document.createElement('tr');tr.innerHTML='<td>1</td><td>AUDIOMETRÍA</td><td>No Aplica</td><td>100</td><td>CONTADO</td><td>100</td><td></td>';document.querySelector('#TbProducto').append(tr);return false;}</script>`);
  const products=new BiofileProducts({page,config:{selectors:{}},seleccionarProductoExacto:async(l,v)=>l.fill(v)});
  const product={productId:'TEST',biofileProduct:'AUDIOMETRÍA',prestador:'No Aplica',formaPago:'CONTADO',cantidad:1,valor:100};
  const result=await products.add(product);assert.equal(result.productId,'TEST');assert.equal((await products.find(product)).length,1);await assert.rejects(products.add(product),/ya aparece/);assert(!products.matches(await products.find(product),{...product,cantidad:2}));
  if(process.env.PANEL_DIR){
    const root=path.resolve(process.env.PANEL_DIR);
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.hostname==='panel.test'){
        const filename=path.resolve(root,'.'+(url.pathname==='/'?'/app-v3.html':url.pathname));
        if(!filename.startsWith(root+path.sep))return route.abort();
        try{return route.fulfill({body:await fs.readFile(filename),contentType:filename.endsWith('.css')?'text/css':filename.endsWith('.js')?'application/javascript':'text/html'});}catch{return route.fulfill({status:404,body:''});}
      }
      if(url.pathname.startsWith('/api/')){
        let data={ok:true,registros:[],jobs:[],concepts:[],companies:[],products:[],catalog:[],usuarios:[]};
        if(url.pathname.endsWith('/config'))data.canConfigure=true;
        return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
      }
      return route.fulfill({body:''});
    });
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://panel.test/app-v3.html');
    await page.evaluate(()=>iniciarApp({id:'test',nombre:'USUARIO PRUEBA',rol:'superadmin'}));
    await page.locator('#btnNacionales').click();await page.locator('#nacionalesDialog[open]').waitFor();
    await page.locator('#natConfigToggle').click();await page.locator('#natConfig:not([hidden])').waitFor();
    await page.screenshot({path:process.env.TEMP+'/biofile-nacionales-desktop.png'});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:process.env.TEMP+'/biofile-nacionales-mobile.png'});
    assert.equal(await page.locator('#nacionalesDialog').evaluate(el=>el.getBoundingClientRect().width<=innerWidth),true);
    await page.evaluate(()=>cerrarSesionLocal());assert.equal(await page.locator('#nacionalesDialog').getAttribute('open'),null);assert.deepEqual(errors,[]);
  }
  console.log('Browser: producto confirmado, duplicado bloqueado y panel responsive verificados.');
}finally{await browser.close();await cerrarNavegador();}
