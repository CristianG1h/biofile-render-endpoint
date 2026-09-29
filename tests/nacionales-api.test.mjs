import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createNationalApi, duplicateBarrier, NATIONAL_RESET_MARKER_ID } from '../src/nacionales/index.js';
function harness() {
  const items=new Map(),jobs=new Map();let executed=0,response;
  const service={store:{items,save:async r=>items.set(r.id,structuredClone(r)),delete:async id=>{items.delete(id);return true;}},jobs,enqueue:async()=>{executed++;return{job:{id:'x'}};}};
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
test('Ingresados and Eliminados are shared globally while pending records remain owner-scoped',async()=>{
  for(const rol of ['user','admin','superadmin']){
    const h=harness();
    h.items.set(NATIONAL_RESET_MARKER_ID,{id:NATIONAL_RESET_MARKER_ID,kind:'national-reset-marker'});
    h.items.set('own',{id:'own',kind:'national-concept',usuarioId:'a',patient:{},employment:{},exams:[]});
    h.items.set('other-pending',{id:'other-pending',kind:'national-concept',usuarioId:'b',patient:{},employment:{},exams:[]});
    h.items.set('deleted',{id:'deleted',kind:'national-concept',usuarioId:'b',deletedAt:'2026-09-29T10:00:00.000Z',patient:{},employment:{},exams:[]});
    h.items.set('completed',{id:'completed',kind:'national-concept',usuarioId:'b',patient:{},employment:{},exams:[]});
    h.jobs.set('job-completed',{id:'job-completed',kind:'national-job',conceptId:'completed',usuarioId:'b',estado:'completado',creadoEn:'2026-09-29T11:00:00.000Z'});
    const r=await h.request('history','GET',{id:'a',rol,usuario:'A'});
    assert.equal(r.status,200);
    assert.deepEqual(new Set(r.body.concepts.map(x=>x.id)),new Set(['own','deleted','completed']));
    assert(!r.body.concepts.some(x=>x.id==='other-pending'));
    assert.deepEqual(r.body.sharedSections,['ingresado','eliminado']);
  }
});

test('owner can delete an uploaded concept when it is not active',async()=>{const h=harness(),id='22222222-2222-2222-2222-222222222222';h.items.set(id,{id,kind:'national-concept',usuarioId:'a'});const r=await h.request('concepts/'+id,'DELETE',{id:'a',rol:'user'});assert.equal(r.status,200);assert(h.items.get(id).deletedAt);assert.equal((await h.request('concepts/'+id+'/restore','POST',{id:'b',rol:'user'})).status,404);assert.equal((await h.request('concepts/'+id+'/restore','POST',{id:'a',rol:'user'})).status,200);assert.equal(h.items.get(id).deletedAt,undefined);});
test('concept deletion is blocked while its BIOFILE job is active',async()=>{const h=harness(),id='33333333-3333-3333-3333-333333333333';h.items.set(id,{id,kind:'national-concept',usuarioId:'a'});h.jobs.set('j',{id:'j',kind:'national-job',conceptId:id,usuarioId:'a',estado:'procesando'});const r=await h.request('concepts/'+id,'DELETE',{id:'a',rol:'user'});assert.equal(r.status,409);assert.equal(h.items.has(id),true);});

test('first history after deployment clears all previous Nacionales concepts and jobs once',async()=>{
  const h=harness();
  h.items.set('concept-old',{id:'concept-old',kind:'national-concept',usuarioId:'a',patient:{},employment:{},exams:[]});
  h.items.set('job-old',{id:'job-old',kind:'national-job',conceptId:'concept-old',usuarioId:'a',estado:'completado'});
  h.items.set('map',{id:'map',kind:'product-map',value:{city:'CALI'}});
  h.jobs.set('job-old',h.items.get('job-old'));
  const first=await h.request('history','GET',{id:'a',rol:'user',usuario:'A'});
  assert.equal(first.status,200);
  assert.deepEqual(first.body.concepts,[]);
  assert.equal(h.items.has('concept-old'),false);
  assert.equal(h.items.has('job-old'),false);
  assert.equal(h.jobs.has('job-old'),false);
  assert.equal(h.items.has('map'),true);
  assert.equal(h.items.has(NATIONAL_RESET_MARKER_ID),true);

  h.items.set('new',{id:'new',kind:'national-concept',usuarioId:'a',patient:{},employment:{},exams:[]});
  const second=await h.request('history','GET',{id:'a',rol:'user',usuario:'A'});
  assert.equal(second.status,200);
  assert.equal(second.body.concepts.some(x=>x.id==='new'),true);
});

test('only Super Admin can permanently delete records already in Eliminados',async()=>{
  const h=harness(),id='44444444-4444-4444-4444-444444444444';
  h.items.set(id,{id,kind:'national-concept',usuarioId:'b',deletedAt:'2026-09-29T10:00:00.000Z',patient:{},employment:{},exams:[]});
  h.items.set('job-related',{id:'job-related',kind:'national-job',conceptId:id,usuarioId:'b',estado:'completado'});
  h.jobs.set('job-related',h.items.get('job-related'));
  assert.equal((await h.request('concepts/'+id+'/permanent','DELETE',{id:'a',rol:'user'})).status,403);
  const removed=await h.request('concepts/'+id+'/permanent','DELETE',{id:'admin',rol:'superadmin',usuario:'Super Admin'});
  assert.equal(removed.status,200);
  assert.equal(h.items.has(id),false);
  assert.equal(h.items.has('job-related'),false);
  assert.equal(h.jobs.has('job-related'),false);
});

test('shared deleted records can only be restored by owner or Super Admin',async()=>{
  const h=harness(),id='55555555-5555-5555-5555-555555555555';
  h.items.set(id,{id,kind:'national-concept',usuarioId:'b',deletedAt:'2026-09-29T10:00:00.000Z'});
  assert.equal((await h.request('concepts/'+id+'/restore','POST',{id:'a',rol:'user'})).status,404);
  assert.equal((await h.request('concepts/'+id+'/restore','POST',{id:'admin',rol:'superadmin'})).status,200);
});
