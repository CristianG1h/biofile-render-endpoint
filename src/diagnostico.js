import { config, validarConfiguracion } from './config.js';
import { crearSesion } from './browser.js';
import { BiofileClient } from './biofile.js';
import { crearLogger } from './logger.js';
import { asegurarDirectorio } from './util.js';

async function main() {
  validarConfiguracion({ requiereGoogle: false });
  asegurarDirectorio(config.paths.logs);
  const logger = crearLogger(config.paths.logs);
  const sesion = await crearSesion(config, logger);
  try {
    await sesion.asegurarLogin();
    const biofile = new BiofileClient({ page: sesion.page, context: sesion.context, config, logger });
    const resultado = await biofile.diagnostico();
    console.log('\nDiagnóstico terminado:');
    console.log(`- Controles encontrados: ${resultado.cantidad}`);
    console.log(`- Archivo JSON: ${resultado.jsonPath}`);
    console.log(`- Captura: ${resultado.captura}`);
  } finally {
    await sesion.context.storageState({ path: config.browser.authPath }).catch(() => {});
    await sesion.context.close().catch(() => {});
    await sesion.browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}\n`);
  process.exitCode = 1;
});
