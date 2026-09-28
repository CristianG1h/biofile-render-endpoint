import crypto from 'node:crypto';
import { execution } from './execution.js';
import { setTimeout as backoff } from 'node:timers/promises';
const active = j => ['en_cola', 'procesando'].includes(j.estado);
const now = () => new Date().toISOString();
export function recoverJob(job) {
  if (!active(job)) return false;
  job.estado = job.numeroOrden || job.guardadoConfirmado ? 'parcial' : 'interrumpido';
  job.reintentable = !job.guardadoIntentado && !job.numeroOrden;
  job.error = { mensaje: 'El servidor reinició antes de finalizar. Revise la última operación antes de continuar.', etapa: job.etapa, codigo: 'SERVER_RESTART', reintentable: job.reintentable };
  job.finalizadoEn = now(); return true;
}
export class JobService {
  constructor(store, { idleMs = Number(process.env.JOB_IDLE_TIMEOUT_MS || 90000), maxMs = Number(process.env.JOB_MAX_DURATION_MS || 600000) } = {}) {
    this.store = store; this.jobs = new Map(); this.queues = new Map(); this.controllers = new Map(); this.idleMs = idleMs; this.maxMs = maxMs; this.accepting = true; this.creating = Promise.resolve();
  }
  async init() {
    await this.store.init();
    for (const job of this.store.items.values()) {
      if (recoverJob(job)) await this.store.save(job);
      this.jobs.set(job.id, job);
    }
    return this;
  }
  async enqueue(input, usuario, runner) {
    const task = this.creating.catch(() => {}).then(async () => {
      if (!this.accepting) throw new Error('El servidor se está reiniciando. Intente nuevamente.');
      const duplicate = [...this.jobs.values()].find(j => active(j) && ((input.documento && j.documento === input.documento) || (input.conceptId && j.conceptId === input.conceptId) || (input.fileHash && j.fileHash === input.fileHash)));
      if (duplicate) return { job: duplicate, duplicado: true };
      const job = { ...input, id: crypto.randomUUID(), usuarioId: usuario.id, usuarioNombre: usuario.usuario, estado: 'en_cola', progreso: 5, etapa: 'En cola', detalle: 'Esperando turno en su sesión BIOFILE.', creadoEn: now(), ultimaActividad: now(), reintentable: false, metrics: {}, events: [], numeroOrden: input.numeroOrden || '', productosAgregados: input.productosAgregados || [] };
      await this.store.save(job); this.jobs.set(job.id, job);
      const key = usuario.usuario.trim().toUpperCase();
      const chain = (this.queues.get(key) || Promise.resolve()).catch(() => {}).then(() => this.run(job, usuario, runner));
      this.queues.set(key, chain);
      chain.finally(() => { if (this.queues.get(key) === chain) this.queues.delete(key); }).catch(() => {});
      return { job, duplicado: false };
    });
    this.creating = task; return task;
  }
  async run(job, usuario, runner) {
    if (!this.accepting) {
      recoverJob(job);
      await this.store.save(job);
      return;
    }
    const controller = new AbortController(); this.controllers.set(job.id, controller);
    const start = Date.now(); let lastEvent = start; let lastStage = job.etapa;
    const scope = { signal: controller.signal, job, session: null, progress: async info => {
      controller.signal.throwIfAborted();
      const time = Date.now();
      if (info.etapa && info.etapa !== lastStage) {
        job.metrics[lastStage] = (job.metrics[lastStage] || 0) + time - lastEvent;
        lastStage = info.etapa; lastEvent = time;
      }
      if (Number.isFinite(info.porcentaje)) job.progreso = Math.max(job.progreso, Math.min(99, info.porcentaje));
      for (const k of ['etapa', 'detalle', 'numeroOrden', 'guardadoIntentado', 'guardadoConfirmado', 'ultimoPasoEjecutado', 'productosAgregados', 'captura', 'selector', 'campo']) if (info[k] !== undefined) job[k] = info[k];
      job.ultimaActividad = now();
      if (info.etapa || info.persist) {
        job.events.push({ event: info.event || info.etapa || 'CHECKPOINT', at: job.ultimaActividad, durationMs: time - start });
        job.events = job.events.slice(-60);
        await this.store.save(job);
        console.info(JSON.stringify({ event:info.event || 'JOB_STAGE', jobId:job.id, etapa:job.etapa, durationMs:time-start }));
      }
    } };
    job.estado = 'procesando'; job.iniciadoEn = now(); job.ultimaActividad = now();
    job.metrics.cola = start - Date.parse(job.creadoEn);
    let timer, watchdogFiring=false;
    try {
      await this.store.save(job);
      const timedOut = new Promise((_, reject) => {
        timer = setInterval(async () => {
          if (controller.signal.aborted || watchdogFiring) return;
          if (Date.now() - Date.parse(job.ultimaActividad) < this.idleMs && Date.now() - start < this.maxMs) return;
          watchdogFiring=true;
          const error = Object.assign(new Error(`Sin actividad confirmada en ${job.etapa}. La automatización fue interrumpida.`), { code: 'JOB_TIMEOUT' });
          if (scope.session?.page && !scope.session.page.isClosed()) {
            try { job.captura = await scope.session.diagnose?.(job.id); } catch {}
          }
          controller.abort(error); reject(error);
        }, Math.min(1000, this.idleMs));
        timer.unref?.();
      });
      const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once:true }));
      const runAttempts = async () => {
        const limit = Math.min(2, Math.max(0, Number(process.env.JOB_MAX_AUTO_RETRIES || 0) || 0));
        for (let attempt = 0; ; attempt++) {
          job.intento = attempt + 1;
          try { return await runner({ usuario, job, onProgress: scope.progress, signal: controller.signal }); }
          catch (error) {
            if (controller.signal.aborted || job.guardadoIntentado || job.numeroOrden || attempt >= limit || !/ECONNRESET|ETIMEDOUT|ERR_CONNECTION|fetch failed|network/i.test(error.message)) throw error;
            await scope.progress({ etapa:'Reintento de conexión', detalle:`Reintento ${attempt+1} de ${limit}, antes de guardar la orden.`, persist:true, event:'JOB_RETRY' });
            await backoff(1000 * (attempt + 1), undefined, { signal:controller.signal });
          }
        }
      };
      const result = await Promise.race([execution.run(scope, runAttempts), timedOut, aborted]);
      job.resultado = result; job.numeroOrden = result.numeroOrden || job.numeroOrden;
      job.estado = 'completado'; job.progreso = 100; job.etapa = 'Completado'; job.detalle = 'Operación confirmada en BIOFILE.';
      job.error = null; job.reintentable = false;
    } catch (error) {
      job.numeroOrden ||= error.detalle?.numeroOrden || '';
      job.estado = job.numeroOrden || job.guardadoConfirmado ? 'parcial' : controller.signal.aborted ? 'interrumpido' : 'error';
      job.reintentable = !job.guardadoIntentado && !job.numeroOrden && /timeout|network|fetch|naveg|conex|interrump|sesión|sesion|ocupad|turno|busy/i.test(error.message);
      if (error.detalle?.captura) job.captura = error.detalle.captura;
      job.error = { mensaje: String(error.message).slice(0, 700), codigo: error.code || 'JOB_FAILED', etapa: job.etapa, campo: error.campo || job.campo || '', selector: error.selector || job.selector || '', numeroOrden: job.numeroOrden, ultimoPasoEjecutado: job.ultimoPasoEjecutado || '', reintentable: job.reintentable };
      job.detalle = job.error.mensaje;
    } finally {
      clearInterval(timer); this.controllers.delete(job.id);
      job.finalizadoEn = now(); job.duracion = Date.now() - start; job.metrics[lastStage] = (job.metrics[lastStage] || 0) + Date.now() - lastEvent; job.metrics.total = job.duracion;
      if (this.onSettled) await this.onSettled(job).catch(() => { job.conciliacionPendiente = true; });
      try { await this.store.save(job); } catch { job.persistenciaPendiente = true; console.error(JSON.stringify({ event: 'JOB_PERSIST_FAILED', jobId: job.id })); }
      console.info(JSON.stringify({ event: job.estado === 'completado' ? 'JOB_COMPLETED' : 'JOB_FAILED', jobId: job.id, durationMs: job.duracion, etapa: job.etapa }));
    }
  }
  async shutdown() { this.accepting = false; for (const c of this.controllers.values()) c.abort(new Error('Reinicio del servidor')); await Promise.allSettled([...this.queues.values()]); }
}
