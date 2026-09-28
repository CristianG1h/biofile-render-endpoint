import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createNationalApi, duplicateBarrier } from '../src/nacionales/index.js';
function harness() {
  const items=new Map(),jobs=new Map();let executed=0,response;
  const service={store:{items,save:async r=>items.set(r.id,structuredClone(r))},jobs,enqueue:async()=>{executed++;return{job:{id:'x'}};}};
  const handler=createNationalApi({service,ready:Promise.resolve(),send:(_q,_s,status,body)=>{response={status,body};},companies:async()=>[],screenshotsRoot:'/private'});
  return {items,jobs,get executed(){return executed;},async request(route,method,actor,body={}){const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method=method;req.headers={};await handler(req,{},new URL('http://local/api/nacionales/'+route),actor);return response;}};
}
test('duplicate confirmation never bypasses an uncertain later order',()=>{
  const superadmin={rol:'superadmin'}, done={id:'one',estado:'completado'};
  assert.equal(duplicateBarrier([done],superadmin,true),done);
  assert.throws(()=>duplicateBarrier([done],{rol:'user'},true));
  assert.throws(()=>duplicateBarrier([done,{estado:'parcial',guardadoIntentado:true}],superadmin,true));
});
test('configuration writes are enforced server-side for every role',async()=>{
  for(const rol of ['user','admin']){const h=harness();const r=await h.request('config/companies','PUT',{id:'a',rol},{alias:'A',acuerdoBiofile:'ACUERDO',empresaMisionBiofile:'MISION',activo:true});assert.equal(r.status,403);assert.equal(h.items.size,0);}
  const h=harness();const r=await h.request('config/companies','PUT',{id:'a',rol:'superadmin'},{alias:'A',acuerdoBiofile:'ACUERDO',empresaMisionBiofile:'MISION',activo:true});assert.equal(r.status,200);assert.equal(h.items.size,1);
});
test('forged concept owner cannot edit or process another user records',async()=>{
  const h=harness(),id='11111111-1111-1111-1111-111111111111';h.items.set(id,{id,kind:'national-concept',usuarioId:'a'});
  for(const role of ['user','admin','superadmin']){assert.equal((await h.request('concepts/'+id,'PATCH',{id:'b',rol:role},{usuarioId:'b'})).status,404);assert.equal((await h.request('process','POST',{id:'b',rol:role},{id})).status,404);}assert.equal(h.executed,0);
});
test('all roles access Nacionales but histories remain owner-scoped',async()=>{
  const h=harness();h.items.set('a',{id:'a',kind:'national-concept',usuarioId:'a'});h.items.set('b',{id:'b',kind:'national-concept',usuarioId:'b'});
  for(const rol of ['user','admin','superadmin']){const r=await h.request('history','GET',{id:'a',rol});assert.equal(r.status,200);assert.deepEqual(r.body.concepts.map(c=>c.id),['a']);}
});
