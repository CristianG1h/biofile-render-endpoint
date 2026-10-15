import test from 'node:test';
import assert from 'node:assert/strict';
import { aplicarDatosRegistroBiofile } from '../src/aplicar-datos-registro.js';

// Catálogo de CbLocalidad en el HTML de Biofile proporcionado el 15/10/2026.
const nombres = ['USAQUÉN','CHAPINERO','SANTAFÉ','SAN CRISTÓBAL','USME','TUNJUELITO','BOSA','KENNEDY','FONTIBÓN','ENGATIVÁ','SUBA','BARRIOS UNIDOS','TEUSAQUILLO','LOS MÁRTIRES','ANTONIO NARIÑO','PUENTE ARANDA','LA CANDELARIA','RAFAEL URIBE URIBE','CIUDAD BOLÍVAR','SUMAPAZ'];
function escenario() {
  let elegido;
  const control = {
    first(){return this;}, count:async()=>1, isVisible:async()=>true,
    evaluate:async fn=>fn({tagName:'SELECT',dispatchEvent(){}}),
    locator:()=>({evaluateAll:async fn=>fn([{value:'',textContent:'Seleccione'},...nombres.map((textContent,i)=>({value:String(i+1),textContent}))])}),
    selectOption:async value=>{elegido=value;}
  };
  return {page:{locator:()=>control}, elegido:()=>elegido};
}
for(const [i,nombre] of nombres.entries()) test(`localidad ${i+1}: ${nombre}`,async()=>{
  const s=escenario();
  await aplicarDatosRegistroBiofile({page:s.page,config:{selectors:{localidad:'#CbLocalidad'}},registro:{localidad:nombre.normalize('NFD').replace(/[\u0300-\u036f]/g,'')},defaults:{}});
  assert.equal(s.elegido(),String(i+1));
});
test('SANTA FE histórica selecciona SANTAFÉ, código 3',async()=>{
  const s=escenario();
  await aplicarDatosRegistroBiofile({page:s.page,config:{selectors:{localidad:'#CbLocalidad'}},registro:{localidad:'Santa Fe'},defaults:{}});
  assert.equal(s.elegido(),'3');
});
test('no acepta coincidencias parciales ni localidades inexistentes',async()=>{
  for(const localidad of ['SANTA','SANTA FE DE ANTIOQUIA','SAN','INEXISTENTE']) {
    const s=escenario();
    await assert.rejects(aplicarDatosRegistroBiofile({page:s.page,config:{selectors:{localidad:'#CbLocalidad'}},registro:{localidad},defaults:{}}),/no contiene/);
    assert.equal(s.elegido(),undefined);
  }
});
