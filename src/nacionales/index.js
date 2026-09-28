import { config } from '../config.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateFile, extractFile } from './file-service.js';
import { parseDocument } from './parser.js';
import { applyDefaults } from './defaults.js';
import { validateConcept } from './validators.js';
import { catalog, mapProducts, mappingKey, validateProductMapping } from './product-mapper.js';
import { processNational } from './processing-service.js';
import { norm } from './normalize.js';
export const canRead = (actor, item) => actor.id === item.usuarioId || actor.rol === 'superadmin';
export function duplicateBarrier(previous, actor, confirmed) {
  const uncertain = previous.find(j => j.estado !== 'completado' && (j.guardadoIntentado || j.numeroOrden));
  const completed = previous.filter(j => j.estado === 'completado').at(-1);
  if (uncertain || (completed && !(actor.rol === 'superadmin' && confirmed === true))) throw Object.assign(new Error('Este concepto tiene un guardado previo o incierto. Consulte su historial; no se creará otra orden.'), { statusCode:409 });
  return completed;
}
export function sanitizeEdit(body, source) {
  const c = structuredClone(source);
  for (const group of ['patient','employment']) for (const key of Object.keys(c[group] || {})) if (typeof body[group]?.[key] === 'string') c[group][key] = body[group][key].trim().slice(0,200);
  if (typeof body.cityExam === 'string') c.cityExam = body.cityExam.trim().slice(0,100);
  if (Array.isArray(body.exams) && body.exams.length <= 20) c.exams = [...new Set(body.exams.map(e => String(e).trim().slice(0,120)).filter(Boolean))];
  c.companyId = String(body.companyId || '').slice(0,100); c.reviewed = body.reviewed === true;
  return c;
}
async function readBody(req, max = 65536) {
  if (Number(req.headers['content-length'] || 0) > max) throw Object.assign(new Error('Archivo demasiado grande.'), { statusCode: 413 });
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw Object.assign(new Error('Solicitud demasiado grande.'), { statusCode: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Solicitud JSON inválida.'), { statusCode: 400 }); }
}
export function createNationalApi({ service, ready, send, companies, screenshotsRoot }) {
  let analyzing = false;
  const store = service.store;
  const records = kind => [...store.items.values()].filter(r => r.kind === kind);
  const configuration = () => ({ products: records('product-map').map(r => r.value), companies: records('company-map').map(r => ({ ...r.value, id: r.id })) });
  const publicJob = j => { const { captura, concept, ...safe } = j; return { ...safe, hasScreenshot: Boolean(captura), patient: concept?.patient, autoFilledFields: concept?.autoFilledFields }; };
  const prepare = concept => {
    const conf = configuration(), errors = validateConcept(concept);
    const company = conf.companies.find(c => c.id === concept.companyId && c.activo);
    if (!company) errors.push('Seleccione una empresa configurada por Super Admin.');
    const mapped = mapProducts(concept, conf.products); errors.push(...mapped.errors);
    return { errors, company, products: mapped.products };
  };
  return async function handle(req, res, url, actor) {
    if (!url.pathname.startsWith('/api/nacionales/')) return false;
    await ready;
    try {
      const route = url.pathname.slice('/api/nacionales/'.length);
      if (route === 'config' && req.method === 'GET') {
        send(req,res,200,{ ok:true, ...configuration(), catalog, tiposEvaluacion: ['INGRESO','PERIÓDICO','EGRESO','POST INCAPACIDAD'], canConfigure: actor.rol === 'superadmin', canResumeProducts: Boolean(config.selectors.orderSearchInput && config.selectors.orderSearchButton && config.selectors.numeroOrden) }); return true;
      }
      if (route === 'config/companies/source' && req.method === 'GET') {
        send(req,res,200,{ ok:true, companies: await companies() }); return true;
      }
      if (['config/products','config/companies'].includes(route) && req.method === 'PUT') {
        if (actor.rol !== 'superadmin') throw Object.assign(new Error('Solo Super Admin administra los mapeos.'), { statusCode:403 });
        const body = await readBody(req); let value, key, kind;
        if (route.endsWith('products')) { value = validateProductMapping(body); key = mappingKey(value.city,value.exam); kind='product-map'; }
        else {
          if (![body.alias,body.acuerdoBiofile,body.empresaMisionBiofile].every(v => typeof v === 'string' && v.trim() && v.length <= 150)) throw new Error('Complete alias, acuerdo y empresa en misión exactos.');
          value = { alias:body.alias.trim(), acuerdoBiofile:body.acuerdoBiofile.trim(), empresaMisionBiofile:body.empresaMisionBiofile.trim(), activo:body.activo === true }; key=norm(value.alias); kind='company-map';
        }
        const id = kind + '-' + crypto.createHash('sha256').update(key).digest('hex').slice(0,24);
        await store.save({ id,kind,value,usuarioId:actor.id,actualizadoEn:new Date().toISOString() }); send(req,res,200,{ ok:true }); return true;
      }
      if (route === 'analyze' && req.method === 'POST') {
        if (analyzing) throw Object.assign(new Error('El lector está ocupado. Reintente cuando termine el archivo actual.'), { statusCode:429 });
        analyzing = true;
        try {
          const body = await readBody(req, 15 * 1024 * 1024);
          if (typeof body.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw new Error('Archivo base64 inválido.');
          const bytes = Buffer.from(body.data,'base64'), metadata = validateFile(String(body.name || ''),String(body.mime || ''),bytes);
          const duplicates = records('national-concept').filter(c => c.fileHash === metadata.fileHash);
          const existing = duplicates.find(c => c.usuarioId === actor.id);
          if (existing) { send(req,res,200,{ ok:true,concept:existing,duplicate:true,duplicateWarning:'Este archivo ya fue analizado. Se recuperó la vista previa existente.' }); return true; }
          const extracted = await extractFile(bytes, metadata, text => { const p=parseDocument(text).patient; return !p.numeroDocumento || !p.primerNombre; });
          const c = { ...applyDefaults(parseDocument(extracted.text)), ...metadata, extractionMethod:extracted.method, id:crypto.randomUUID(),kind:'national-concept',usuarioId:actor.id,usuarioNombre:actor.usuario,creadoEn:new Date().toISOString(),reviewed:false };
          c.estado='REQUIERE_REVISION'; c.validationErrors=prepare(c).errors;
          if (duplicates.length) c.warnings.push('Este documento fue cargado anteriormente por otro usuario.');
          await store.save(c); send(req,res,200,{ ok:true,concept:c });
        } finally { analyzing=false; }
        return true;
      }
      const conceptMatch = /^concepts\/([0-9a-f-]+)$/.exec(route);
      if (conceptMatch && req.method === 'PATCH') {
        const source = store.items.get(conceptMatch[1]);
        if (!source || source.kind !== 'national-concept' || source.usuarioId !== actor.id) throw Object.assign(new Error('Concepto no encontrado.'),{statusCode:404});
        const body=await readBody(req), c=sanitizeEdit(body,source); c.validationErrors=prepare(c).errors;c.estado=c.validationErrors.length?'REQUIERE_REVISION':'LISTO';
        await store.save(c);send(req,res,200,{ok:true,concept:c});return true;
      }
      if (route === 'process' && req.method === 'POST') {
        const body=await readBody(req), c=store.items.get(body.id);
        if (!c || c.kind !== 'national-concept' || c.usuarioId !== actor.id) throw Object.assign(new Error('Concepto no encontrado.'),{statusCode:404});
        const prepared=prepare(c);if(prepared.errors.length) throw new Error(prepared.errors.join('. '));
        const previous=[...service.jobs.values()].filter(j=>j.kind==='national-job' && (j.fileHash===c.fileHash || j.conceptId===c.id));
        const unsafe=duplicateBarrier(previous,actor,body.confirmDuplicate);
        const repeatAuthorized = Boolean(unsafe);
        const result=await service.enqueue({kind:'national-job',duplicateAuthorizedBy:repeatAuthorized?actor.id:null,duplicateOf:repeatAuthorized?unsafe.id:null,conceptId:c.id,fileHash:c.fileHash,sourceFile:c.sourceFile,documento:c.patient.numeroDocumento,concept:c,products:prepared.products,company:prepared.company},actor,processNational);
        send(req,res,result.duplicado?409:202,{ok:!result.duplicado,job:canRead(actor,result.job)?publicJob(result.job):null,error:result.duplicado?'Existe un trabajo activo para este documento.':undefined});return true;
      }
      const match=/^jobs\/([0-9a-f-]+)(?:\/(retry|screenshot))?$/.exec(route);
      if (match) {
        const job=service.jobs.get(match[1]);
        if(!job || job.kind!=='national-job' || !canRead(actor,job)) throw Object.assign(new Error('Trabajo no encontrado.'),{statusCode:404});
        if(match[2]==='retry' && req.method==='POST') {
          const later = [...service.jobs.values()].filter(j => j.kind==='national-job' && (j.conceptId===job.conceptId || j.fileHash===job.fileHash));
          if (later.at(-1)?.id !== job.id) throw new Error('Existe un intento posterior. Consulte el último trabajo para continuar sin duplicar operaciones.');
          const resume = job.estado==='parcial' && job.numeroOrden;
          if(job.usuarioId!==actor.id || (!resume && (!job.reintentable || job.guardadoIntentado))) throw new Error('Este trabajo requiere conciliación de la orden existente. No se autoriza crear otra.');
          if(resume && !(config.selectors.orderSearchInput && config.selectors.orderSearchButton && config.selectors.numeroOrden)) throw new Error('La reapertura automática requiere configurar los selectores de búsqueda de la orden. Conserve esta orden y revise los productos pendientes.');
          const prepared=prepare(job.concept);if(prepared.errors.length) throw new Error(prepared.errors.join('. '));
          const result=await service.enqueue({kind:'national-job',conceptId:job.conceptId,fileHash:job.fileHash,sourceFile:job.sourceFile,documento:job.documento,concept:job.concept,products:resume?job.products:prepared.products,company:resume?job.company:prepared.company,numeroOrden:resume?job.numeroOrden:'',guardadoIntentado:Boolean(resume),guardadoConfirmado:Boolean(resume),productosAgregados:resume?job.productosAgregados:[]},actor,processNational);
          send(req,res,result.duplicado?409:202,{ok:!result.duplicado,job:publicJob(result.job)});return true;
        }
        if(match[2]==='screenshot' && req.method==='GET') {
          if(actor.rol!=='superadmin') throw Object.assign(new Error('Solo Super Admin puede ver capturas.'),{statusCode:403});
          const file=path.resolve(job.captura || ''), root=path.resolve(screenshotsRoot)+path.sep;
          if(!file.startsWith(root) || !file.endsWith('.png')) throw Object.assign(new Error('Captura no disponible.'),{statusCode:404});
          const data=await fs.readFile(file);res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(data);return true;
        }
        if(!match[2] && req.method==='GET') {send(req,res,200,{ok:true,job:publicJob(job)});return true;}
      }
      if(route==='history' && req.method==='GET') {
        send(req,res,200,{ok:true,concepts:records('national-concept').filter(c=>c.usuarioId===actor.id).slice(-200),jobs:[...service.jobs.values()].filter(j=>j.kind==='national-job' && canRead(actor,j)).slice(-200).map(publicJob)});return true;
      }
      throw Object.assign(new Error('Ruta Nacionales no encontrada.'),{statusCode:404});
    } catch(error) {send(req,res,error.statusCode || 400,{ok:false,error:String(error.message).slice(0,1500)});return true;}
  };
}
