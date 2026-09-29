import { config } from '../config.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateFile, extractFile } from './file-service.js';
import { parseDocument, repairStoredConcept, documentOcrPlan } from './parser.js';
import { applyDefaults } from './defaults.js';
import { validateConcept } from './validators.js';
import { catalog, automaticCityMap, mapProducts, mappingKey, validateProductMapping } from './product-mapper.js';
import { processNational } from './processing-service.js';
import { norm, canonicalCity } from './normalize.js';
export const canRead = (actor, item) => actor.id === item.usuarioId || actor.rol === 'superadmin';
export const NATIONAL_RESET_MARKER_ID = 'national-reset-2026-09-29-v1';
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
  if (typeof body.companyId === 'string') c.companyId = body.companyId.trim().slice(0,100);
  if (typeof body.companyAgreement === 'string') c.companyAgreement = body.companyAgreement.trim().slice(0,180);
  c.reviewed = body.reviewed === true;
  return c;
}

export function directoryCompanyMatch(items, value) {
  const key = norm(value);
  if (!key) return null;
  return (items || []).filter(item=>item.activo!==false).find(item => norm(item?.acuerdo) === key || norm(item?.cliente) === key) || null;
}

export function companyForConcept(concept, configuredCompanies = []) {
  const agreement = String(concept?.companyAgreement || '').trim();
  if (agreement) {
    return {
      id: 'directory:' + norm(agreement),
      alias: agreement,
      acuerdoBiofile: agreement,
      empresaMisionBiofile: agreement,
      activo: true,
      source: 'directorio'
    };
  }
  return configuredCompanies.find(c => c.id === concept?.companyId && c.activo) || null;
}

async function readBody(req, max = 65536) {
  if (Number(req.headers['content-length'] || 0) > max) throw Object.assign(new Error('Archivo demasiado grande.'), { statusCode: 413 });
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw Object.assign(new Error('Solicitud demasiado grande.'), { statusCode: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Solicitud JSON inválida.'), { statusCode: 400 }); }
}
export function createNationalApi({ service, ready, send, companies, screenshotsRoot }) {
  let analyzing = false;
  let resetPromise = null;
  const store = service.store;
  const records = kind => [...store.items.values()].filter(r => r.kind === kind);
  const conceptPermissions = (actor, concept) => {
    const owns = actor.id === concept.usuarioId;
    const superadmin = actor.rol === 'superadmin';
    return {
      canEdit: !concept.deletedAt && (owns || superadmin),
      canSoftDelete: !concept.deletedAt && (owns || superadmin),
      canRestore: Boolean(concept.deletedAt) && (owns || superadmin),
      canPurge: Boolean(concept.deletedAt) && superadmin
    };
  };
  const purgeConcept = async concept => {
    const related = [...service.jobs.values()].filter(j => j.kind === 'national-job' && j.conceptId === concept.id);
    for (const job of related) {
      await store.delete(job.id);
      service.jobs.delete(job.id);
    }
    await store.delete(concept.id);
    service.jobs.delete(concept.id);
  };
  const resetNationalDataOnce = async () => {
    if (store.items.has(NATIONAL_RESET_MARKER_ID)) return false;
    if (resetPromise) return resetPromise;
    resetPromise = (async () => {
      const targets = [...store.items.values()].filter(item => item.kind === 'national-concept' || item.kind === 'national-job');
      for (const item of targets) {
        await store.delete(item.id);
        service.jobs.delete(item.id);
      }
      await store.save({
        id: NATIONAL_RESET_MARKER_ID,
        kind: 'national-reset-marker',
        version: 1,
        creadoEn: new Date().toISOString(),
        descripcion: 'Reinicio solicitado de todos los registros históricos de Nacionales.'
      });
      return true;
    })();
    try { return await resetPromise; }
    finally { resetPromise = null; }
  };
  const configuration = () => ({ products: records('product-map').map(r => r.value), companies: records('company-map').map(r => ({ ...r.value, id: r.id })) });
  const publicJob = j => { const { captura, concept, ...safe } = j; return { ...safe, hasScreenshot: Boolean(captura), patient: concept?.patient, autoFilledFields: concept?.autoFilledFields }; };
  const prepare = concept => {
    const conf = configuration(), errors = validateConcept(concept);
    const company = companyForConcept(concept, conf.companies);
    if (!company) errors.push('Seleccione la empresa / acuerdo BIOFILE antes de enviar.');
    const mapped = mapProducts(concept, conf.products);
    errors.push(...mapped.errors);
    return { errors, company, products: mapped.products };
  };
  const refreshConcept = concept => {
    const upgraded = applyDefaults(repairStoredConcept(concept));
    upgraded.validationErrors = prepare(upgraded).errors;
    upgraded.estado = upgraded.validationErrors.length ? 'REQUIERE_REVISION' : 'LISTO';
    return upgraded;
  };
  return async function handle(req, res, url, actor) {
    if (!url.pathname.startsWith('/api/nacionales/')) return false;
    await ready;
    try {
      const route = url.pathname.slice('/api/nacionales/'.length);
      if (route === 'config' && req.method === 'GET') {
        send(req,res,200,{ ok:true, ...configuration(), catalog, automaticCityMap, tiposEvaluacion: ['INGRESO','PERIÓDICO','EGRESO','POST INCAPACIDAD'], canConfigure: actor.rol === 'superadmin', canResumeProducts: true }); return true;
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
          if (existing && canonicalCity(existing.cityExam)) {
            const upgraded = refreshConcept(existing);
            if (JSON.stringify(upgraded) !== JSON.stringify(existing)) await store.save(upgraded);
            send(req,res,200,{ ok:true,concept:upgraded,duplicate:true,duplicateWarning:'Este archivo ya fue analizado. Se recuperó la vista previa existente con las reglas actuales de Nacionales.' });
            return true;
          }
          const extracted = await extractFile(bytes, metadata, documentOcrPlan);
          const digital=extracted.digitalText ? parseDocument(extracted.digitalText) : null;
          const parsed=digital?.patient.numeroDocumento && digital?.patient.primerNombre ? digital : parseDocument(extracted.text);
          if (!parsed.cityExam && extracted.text!==extracted.digitalText) { const ocr=parseDocument(extracted.text);parsed.cityExam=ocr.cityExam;parsed.warnings.push(...ocr.warnings.filter(w=>/Ciudad identificada/.test(w))); }
          if (parsed.cityExam) parsed.warnings=parsed.warnings.filter(w=>w!=='Confirme la ciudad donde se realizó el examen.');
          parsed.warnings.push(...(extracted.warnings||[]));
          const c = { ...applyDefaults(parsed), ...metadata, extractionMethod:extracted.method, id:crypto.randomUUID(),kind:'national-concept',usuarioId:actor.id,usuarioNombre:actor.usuario,creadoEn:new Date().toISOString(),reviewed:false,companyAgreement:'' };
          if(existing){const recoveredCity=c.cityExam;Object.assign(c,existing,{cityExam:recoveredCity,extractionMethod:extracted.method,reviewed:false,warnings:[...new Set([...(existing.warnings||[]).filter(w=>!recoveredCity||w!=='Confirme la ciudad donde se realizó el examen.'),...parsed.warnings])]});for(const key of ['municipioResidencia','ciudadNacimiento'])if(!canonicalCity(c.patient[key]))c.patient[key]=recoveredCity;}
          c.estado='REQUIERE_REVISION'; c.validationErrors=prepare(c).errors;
          if (duplicates.length) c.warnings.push('Este documento fue cargado anteriormente por otro usuario.');
          await store.save(c); send(req,res,200,{ ok:true,concept:c });
        } finally { analyzing=false; }
        return true;
      }
      const conceptMatch = /^concepts\/([0-9a-f-]+)$/.exec(route);
      if (conceptMatch && req.method === 'DELETE') {
        const source = store.items.get(conceptMatch[1]);
        if (!source || source.kind !== 'national-concept' || (source.usuarioId !== actor.id && actor.rol !== 'superadmin')) throw Object.assign(new Error('Concepto no encontrado.'),{statusCode:404});
        const active = [...service.jobs.values()].find(j => j.kind === 'national-job' && j.conceptId === source.id && ['en_cola','procesando'].includes(j.estado));
        if (active) throw Object.assign(new Error('No se puede eliminar mientras el concepto está en cola o enviándose a BIOFILE.'),{statusCode:409});
        await store.save({...source,deletedAt:new Date().toISOString(),deletedBy:actor.id,deletedByName:actor.usuario || ''});
        send(req,res,200,{ok:true,id:source.id});
        return true;
      }
      const restoreMatch=/^concepts\/([0-9a-f-]+)\/restore$/.exec(route);
      if (restoreMatch && req.method==='POST') {
        const source=store.items.get(restoreMatch[1]);
        if(!source || source.kind!=='national-concept' || (source.usuarioId!==actor.id && actor.rol!=='superadmin')) throw Object.assign(new Error('Concepto no encontrado.'),{statusCode:404});
        const restored={...source};delete restored.deletedAt;delete restored.deletedBy;delete restored.deletedByName;
        await store.save(restored);
        send(req,res,200,{ok:true,concept:{...restored,permissions:conceptPermissions(actor,restored)}});
        return true;
      }
      const purgeMatch=/^concepts\/([0-9a-f-]+)\/permanent$/.exec(route);
      if (purgeMatch && req.method==='DELETE') {
        if (actor.rol !== 'superadmin') throw Object.assign(new Error('Solo Super Admin puede eliminar permanentemente.'),{statusCode:403});
        const source=store.items.get(purgeMatch[1]);
        if(!source || source.kind!=='national-concept') throw Object.assign(new Error('Concepto no encontrado.'),{statusCode:404});
        if(!source.deletedAt) throw Object.assign(new Error('Primero mueva el concepto a Eliminados antes de borrarlo permanentemente.'),{statusCode:409});
        await purgeConcept(source);
        send(req,res,200,{ok:true,id:source.id,permanent:true});
        return true;
      }
      if (conceptMatch && req.method === 'PATCH') {
        const source = store.items.get(conceptMatch[1]);
        if (!source || source.kind !== 'national-concept' || source.usuarioId !== actor.id) throw Object.assign(new Error('Concepto no encontrado.'),{statusCode:404});
        if(source.deletedAt)throw new Error('Restaure el concepto antes de editarlo.');
        const body=await readBody(req), c=sanitizeEdit(body,source);
        if (typeof body.companyAgreement === 'string') {
          c.companyId = '';
          const requested = String(c.companyAgreement || '').trim();
          if (requested) {
            const match = directoryCompanyMatch(await companies(), requested);
            if (!match?.acuerdo) throw Object.assign(new Error('Seleccione una empresa válida de la lista de BIOFILE; no escriba un nombre libre.'), { statusCode:400 });
            c.companyAgreement = String(match.acuerdo).trim().slice(0,180);
          }
        }
        c.validationErrors=prepare(c).errors;
        c.estado=c.validationErrors.length?'REQUIERE_REVISION':'LISTO';
        await store.save(c);send(req,res,200,{ok:true,concept:c});return true;
      }
      if (route === 'process' && req.method === 'POST') {
        const body=await readBody(req), c=store.items.get(body.id);
        if (!c || c.kind !== 'national-concept' || c.usuarioId !== actor.id) throw Object.assign(new Error('Concepto no encontrado.'),{statusCode:404});
        if(c.deletedAt)throw new Error('Restaure el concepto antes de enviarlo.');
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
          if(store.items.get(job.conceptId)?.deletedAt)throw new Error('Restaure el concepto antes de reintentar.');
          const later = [...service.jobs.values()].filter(j => j.kind==='national-job' && (j.conceptId===job.conceptId || j.fileHash===job.fileHash));
          if (later.at(-1)?.id !== job.id) throw new Error('Existe un intento posterior. Consulte el último trabajo para continuar sin duplicar operaciones.');
          const resume = job.estado==='parcial' && job.numeroOrden;
          if(job.usuarioId!==actor.id || (!resume && (!job.reintentable || job.guardadoIntentado))) throw new Error('Este trabajo requiere conciliación de la orden existente. No se autoriza crear otra.');
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
        await resetNationalDataOnce();
        const allConcepts = records('national-concept');
        const allJobs = [...service.jobs.values()].filter(j=>j.kind==='national-job');
        const latestByConcept = new Map();
        for (const job of allJobs) {
          const previous=latestByConcept.get(job.conceptId);
          if(!previous || String(job.creadoEn||'') >= String(previous.creadoEn||'')) latestByConcept.set(job.conceptId,job);
        }
        const shared = allConcepts.filter(concept => {
          if (concept.usuarioId === actor.id) return true;
          if (concept.deletedAt) return true;
          return latestByConcept.get(concept.id)?.estado === 'completado';
        }).slice(-500);
        const concepts = shared.map(original => {
          const upgraded=refreshConcept(original);
          return {...upgraded,permissions:conceptPermissions(actor,upgraded)};
        });
        const visibleIds=new Set(shared.map(c=>c.id));
        const jobs=allJobs.filter(j=>visibleIds.has(j.conceptId)).slice(-500).map(publicJob);
        send(req,res,200,{ok:true,concepts,jobs,sharedSections:['ingresado','eliminado'],resetVersion:1});
        return true;
      }
      throw Object.assign(new Error('Ruta Nacionales no encontrada.'),{statusCode:404});
    } catch(error) {send(req,res,error.statusCode || 400,{ok:false,error:String(error.message).slice(0,1500)});return true;}
  };
}
