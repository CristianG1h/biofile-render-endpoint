import { config, validarConfiguracion } from './config.js';
import { BaseGoogleSheets } from './google-sheets.js';

function ocultarDocumento(documento) {
  const s = String(documento || '');
  if (s.length <= 4) return '****';
  return `${'*'.repeat(s.length - 4)}${s.slice(-4)}`;
}

async function main() {
  validarConfiguracion({ requiereBiofile: false, requiereDefaults: false, requiereGoogle: true });
  const base = await new BaseGoogleSheets({
    urlOId: config.google.urlOId,
    hoja: config.google.hoja,
    authMode: config.google.authMode,
    credentialsPath: config.google.credentialsPath,
    logger: console
  }).cargar();

  const resumen = base.resumen();
  const pendientes = base.obtenerPendientes({ max: 1 });
  console.log('\nCONEXIÓN CORRECTA CON GOOGLE SHEETS');
  console.log(`Hoja: ${resumen.hoja}`);
  console.log(`Modo: ${resumen.authMode}`);
  console.log(`Filas de datos: ${resumen.filas}`);
  console.log(`Columnas: ${resumen.columnas}`);
  console.log(`Encabezados: ${resumen.encabezados.join(' | ')}`);

  if (!pendientes.length) {
    console.log('\nNo se encontró ninguna fila pendiente.');
    return;
  }
  const r = pendientes[0];
  console.log('\nPRIMER REGISTRO PENDIENTE');
  console.log(`Fila: ${r.row}`);
  console.log(`Documento: ${ocultarDocumento(r.numeroDocumento)}`);
  console.log(`Nombre: ${r.primerNombre} ${r.primerApellido}`);
  console.log(`Fecha Biofile: ${r.fechaNacimiento}`);
  console.log(`Foto: ${r.fotoUrl ? 'Sí' : 'No'}`);
  console.log(`Firma: ${r.firmaUrl ? 'Sí' : 'No'}`);
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}\n`);
  process.exitCode = 1;
});
