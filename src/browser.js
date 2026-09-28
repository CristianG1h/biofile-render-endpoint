import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import { execution, registerSession, checkCancelled } from './jobs/execution.js';
import { asegurarDirectorio } from './util.js';

async function locatorVisible(locator) {
  try {
    return (await locator.count()) > 0 && await locator.first().isVisible();
  } catch {
    return false;
  }
}

let browserPromise;
const states = new Map(), accountTails = new Map();
let openContexts = 0;
const slots = [];
async function slot() {
  if (openContexts >= Number(process.env.BROWSER_MAX_CONTEXTS || 2)) await new Promise(r => slots.push(r));
  else openContexts++;
  return () => { const next = slots.shift(); if (next) next(); else openContexts--; };
}

export async function waitForAccountTurn(previous, { signal = execution.getStore()?.signal, timeoutMs = Number(process.env.BIOFILE_SESSION_WAIT_MS || 45000) } = {}) {
  if (!previous) return;
  signal?.throwIfAborted();
  let timer, abortHandler;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('La sesión BIOFILE está ocupada por otra operación. Reintente en unos segundos.'), { code:'BIOFILE_SESSION_BUSY' })), Math.max(1000, timeoutMs));
  });
  const aborted = signal ? new Promise((_, reject) => {
    abortHandler = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Operación cancelada.'));
    signal.addEventListener('abort', abortHandler, { once:true });
  }) : new Promise(()=>{});
  try { await Promise.race([previous.catch(() => {}), timeout, aborted]); }
  finally {
    clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  }
}
export async function cerrarNavegador() { if (browserPromise) await (await browserPromise).close(); browserPromise = null; }
export async function crearSesion(config, logger) {
  checkCancelled();
  const account = config.biofile.usuario.trim().toUpperCase();
  const hadPrevious = accountTails.has(account);
  const previous = accountTails.get(account) || Promise.resolve();
  let unlock;
  const pending = new Promise(r => { unlock = r; });
  const tail = previous.catch(() => {}).then(() => pending);
  accountTails.set(account, tail);
  if (hadPrevious) {
    await activity('Esperando que termine otra operación en esta sesión BIOFILE.', { etapa:'Esperando sesión BIOFILE', persist:true });
    try {
      await waitForAccountTurn(previous);
      await activity('Turno BIOFILE disponible. Abriendo navegador.', { persist:true });
    } catch (error) {
      unlock();
      if (accountTails.get(account) === tail) accountTails.delete(account);
      throw error;
    }
  }
  let releaseSlot;
  let context, closed = false;
  const version = crypto.createHash('sha256').update(account + ':' + config.biofile.contrasena).digest('hex');
  const release = async () => {
    if (closed) return; closed = true;
    if (context) {
      if (!execution.getStore()?.signal.aborted) {
        try { states.set(account, { version, at: Date.now(), value: await context.storageState() }); } catch {}
      }
      await context.close().catch(() => {});
    }
    releaseSlot?.(); unlock();
    if (accountTails.get(account) === tail) accountTails.delete(account);
  };
  try {
    checkCancelled(); releaseSlot = await slot(); checkCancelled();
    asegurarDirectorio(path.dirname(config.browser.authPath)); asegurarDirectorio(config.paths.screenshots);
    if (!browserPromise) {
      browserPromise = chromium.launch({ headless: config.browser.headless, slowMo: config.browser.slowMo, args: config.browser.args, ...(config.browser.executablePath ? { executablePath: config.browser.executablePath } : {}) });
      browserPromise.then(b => b.on('disconnected', () => { browserPromise = null; states.clear(); })).catch(() => { browserPromise = null; });
    }
    const realBrowser = await browserPromise;
    const saved = states.get(account);
    context = await realBrowser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true,
      ...(saved?.version === version && Date.now() - saved.at < 15 * 60 * 1000 ? { storageState: saved.value } : {}) });
    const page = await context.newPage();
    page.setDefaultTimeout(Number(process.env.BIOFILE_FIELD_TIMEOUT_MS || 8000));
    page.setDefaultNavigationTimeout(Number(process.env.BIOFILE_NAVIGATION_TIMEOUT_MS || 15000));
    page.on('dialog', dialog => dialog.accept().catch(() => {}));
    async function estaEnLogin() { return /IniciarSesion/i.test(page.url()) || await locatorVisible(page.locator('input[type="password"]')); }
    async function asegurarLogin() {
      checkCancelled();
      await page.goto(config.biofile.ordenUrl, { waitUntil: 'domcontentloaded' });
      if (await estaEnLogin()) {
        const user = page.locator(config.selectors.loginUsuario || 'input[type="text"]:visible').first();
        const password = page.locator(config.selectors.loginContrasena || 'input[type="password"]:visible').first();
        await user.fill(config.biofile.usuario); await password.fill(config.biofile.contrasena);
        let button = config.selectors.loginBoton ? page.locator(config.selectors.loginBoton).first() : page.getByRole('button', { name: /Ingresar al sistema/i }).first();
        if (!await locatorVisible(button)) button = page.locator('input[type="submit"]:visible').first();
        await button.click();
        await page.waitForFunction(() => !/IniciarSesion/i.test(location.href) && !document.querySelector('input[type="password"]'), { }, { timeout: 15000 });
        if (await estaEnLogin()) throw new Error('BIOFILE rechazó el inicio de sesión.');
      }
      if (!/OrdenesServiciosSaludOcupacional/i.test(page.url())) await page.goto(config.biofile.ordenUrl, { waitUntil: 'domcontentloaded' });
      await page.locator('body').waitFor({ state:'visible', timeout:15000 });
      if (await estaEnLogin()) throw new Error('BIOFILE devolvió nuevamente la pantalla de inicio de sesión.');
      states.set(account, { version, at: Date.now(), value: await context.storageState() });
    }
    const session = { context, page, browser: { close: release }, asegurarLogin,
      diagnose: async id => { const filename = path.join(config.paths.screenshots, `${id}.png`); await page.screenshot({ path: filename, timeout: 3000 }); return filename; } };
    registerSession(session); return session;
  } catch (error) { await release(); throw error; }
}
