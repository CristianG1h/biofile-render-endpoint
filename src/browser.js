import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { asegurarDirectorio } from './util.js';

async function locatorVisible(locator) {
  try {
    return (await locator.count()) > 0 && await locator.first().isVisible();
  } catch {
    return false;
  }
}

export async function crearSesion(config, logger) {
  asegurarDirectorio(path.dirname(config.browser.authPath));
  asegurarDirectorio(config.paths.screenshots);

  const launchOptions = {
    headless: config.browser.headless,
    slowMo: config.browser.slowMo,
    args: config.browser.args
  };
  if (config.browser.executablePath) launchOptions.executablePath = config.browser.executablePath;

  const browser = await chromium.launch(launchOptions);
  const contextOptions = {
    viewport: { width: 1600, height: 1000 },
    ignoreHTTPSErrors: true,
    acceptDownloads: true
  };
  if (fs.existsSync(config.browser.authPath)) contextOptions.storageState = config.browser.authPath;

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(config.browser.timeout);
  page.on('dialog', async (dialog) => {
    logger?.warn('Biofile mostró un diálogo del navegador.', { type: dialog.type(), message: dialog.message() });
    await dialog.accept().catch(() => {});
  });

  async function estaEnLogin() {
    return /IniciarSesion/i.test(page.url()) ||
      await locatorVisible(page.locator('input[type="password"]'));
  }

  async function asegurarLogin() {
    logger?.info('Abriendo Biofile y verificando la sesión.');
    await page.goto(config.biofile.ordenUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    if (await estaEnLogin()) {
      logger?.info('La sesión no estaba activa. Iniciando sesión.');
      const usuario = config.selectors.loginUsuario
        ? page.locator(config.selectors.loginUsuario).first()
        : page.locator('input[type="text"]:visible').first();
      const contrasena = config.selectors.loginContrasena
        ? page.locator(config.selectors.loginContrasena).first()
        : page.locator('input[type="password"]:visible').first();

      await usuario.fill(config.biofile.usuario);
      await contrasena.fill(config.biofile.contrasena);

      let boton;
      if (config.selectors.loginBoton) {
        boton = page.locator(config.selectors.loginBoton).first();
      } else {
        boton = page.getByRole('button', { name: /Ingresar al sistema/i }).first();
        if (!await locatorVisible(boton)) {
          boton = page.locator('input[type="submit"]:visible').first();
        }
      }

      await Promise.all([
        page.waitForLoadState('domcontentloaded').catch(() => {}),
        boton.click()
      ]);
      await page.waitForTimeout(2000);

      if (await estaEnLogin()) {
        throw new Error('Biofile no permitió iniciar sesión. Revisa el usuario, la contraseña o un mensaje de validación en pantalla.');
      }
      await context.storageState({ path: config.browser.authPath });
      logger?.info('Sesión iniciada y guardada localmente.');
    } else {
      logger?.info('Biofile conservó la sesión anterior.');
    }

    if (!/OrdenesServiciosSaludOcupacional/i.test(page.url())) {
      await page.goto(config.biofile.ordenUrl, { waitUntil: 'domcontentloaded' });
    }
    await page.waitForTimeout(1800);
  }

  return { browser, context, page, asegurarLogin };
}
