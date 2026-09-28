import test from 'node:test';
import assert from 'node:assert/strict';
import { JobService, recoverJob } from '../src/jobs/job-service.js';
import { waitForAccountTurn } from '../src/browser.js';
const actor={id:'a',usuario:'TEST',rol:'user'};
class MemoryStore {items=new Map();async init(){} async save(j){this.items.set(j.id,structuredClone(j));}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('queue is sequential and duplicate submission is atomic',async()=>{
  const service=await new JobService(new MemoryStore()).init();let running=0,max=0;
  const runner=async()=>{running++;max=Math.max(max,running);await sleep(15);running--;return {numeroOrden:'TEST'};};
  const results=await Promise.all([service.enqueue({documento:'123'},actor,runner),service.enqueue({documento:'123'},actor,runner)]);
  assert.equal(results.filter(r=>r.duplicado).length,1);await service.enqueue({documento:'456'},actor,runner);await Promise.all(service.queues.values());assert.equal(max,1);
});
test('idle watchdog ends a hanging job without inventing progress',async()=>{
  const store=new MemoryStore(),service=await new JobService(store,{idleMs:25,maxMs:200}).init();
  const {job}=await service.enqueue({documento:'123'},actor,async({onProgress})=>{await onProgress({porcentaje:52,etapa:'Paciente'});await new Promise(()=>{});});
  await sleep(100);assert.equal(job.estado,'interrumpido');assert.equal(job.progreso,52);assert.equal(job.error.etapa,'Paciente');assert.equal(store.items.get(job.id).estado,'interrumpido');
});
test('order checkpoint prevents retry after later failure',async()=>{
  const service=await new JobService(new MemoryStore()).init();
  const {job}=await service.enqueue({documento:'123'},actor,async({onProgress})=>{await onProgress({numeroOrden:'OS-TEST',guardadoIntentado:true,guardadoConfirmado:true,etapa:'Productos',porcentaje:85});throw new Error('timeout producto');});
  await Promise.all(service.queues.values());assert.equal(job.estado,'parcial');assert.equal(job.reintentable,false);assert.equal(job.numeroOrden,'OS-TEST');assert.equal(job.progreso,85);
});
test('restart recovery preserves confirmed and uncertain order barriers',()=>{
  const a={estado:'procesando',numeroOrden:'OS-TEST',etapa:'Productos'};recoverJob(a);assert.equal(a.estado,'parcial');assert.equal(a.reintentable,false);
  const b={estado:'procesando',guardadoIntentado:true};recoverJob(b);assert.equal(b.estado,'interrumpido');assert.equal(b.reintentable,false);
  const c={estado:'completado',progreso:100};assert.equal(recoverJob(c),false);
});
test('persistence failure prevents starting automation',async()=>{const store=new MemoryStore();const service=await new JobService(store).init();store.save=async()=>{throw new Error('offline');};let ran=false;await assert.rejects(service.enqueue({},actor,async()=>{ran=true;}));assert.equal(ran,false);});
test('shutdown interrupts queued work without starting another browser',async()=>{
  const service=await new JobService(new MemoryStore()).init();let calls=0;
  const runner=async()=>{calls++;await sleep(40);return {};};
  await service.enqueue({documento:'1'},actor,runner);
  const {job}=await service.enqueue({documento:'2'},actor,runner);
  await service.shutdown();assert.equal(calls,1);assert.equal(job.estado,'interrumpido');
});
test('automatic retries are bounded and stop at the first save intent',async()=>{
  const old=process.env.JOB_MAX_AUTO_RETRIES;process.env.JOB_MAX_AUTO_RETRIES='1';
  try {
    const service=await new JobService(new MemoryStore()).init();let attempts=0;
    const {job}=await service.enqueue({documento:'123'},actor,async()=>{if(++attempts===1)throw new Error('ECONNRESET');return {};});
    await Promise.all(service.queues.values());assert.equal(attempts,2);assert.equal(job.estado,'completado');
    let unsafeAttempts=0;
    const next=await service.enqueue({documento:'456'},actor,async({onProgress})=>{unsafeAttempts++;await onProgress({guardadoIntentado:true,persist:true});throw new Error('ECONNRESET');});
    await Promise.all(service.queues.values());assert.equal(unsafeAttempts,1);assert.equal(next.job.reintentable,false);
  } finally {if(old===undefined)delete process.env.JOB_MAX_AUTO_RETRIES;else process.env.JOB_MAX_AUTO_RETRIES=old;}
});

test('BIOFILE account turn wait is abort-aware and cannot leave a job hanging forever',async()=>{
  const controller=new AbortController();
  setTimeout(()=>controller.abort(new Error('cancelled wait')),10);
  await assert.rejects(waitForAccountTurn(new Promise(()=>{}),{signal:controller.signal,timeoutMs:200}),/cancelled wait/);
});
test('BIOFILE account turn wait returns a clear retryable busy error',async()=>{
  await assert.rejects(
    waitForAccountTurn(new Promise(()=>{}),{timeoutMs:15}),
    error=>error.code==='BIOFILE_SESSION_BUSY' && /ocupada/i.test(error.message)
  );
});
