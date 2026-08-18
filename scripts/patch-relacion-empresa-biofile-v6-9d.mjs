import fs from 'node:fs';

const procesarPath = new URL('../src/procesar-registro.js', import.meta.url);
const llamadaSegura = 'await base.marcarOrdenCreada(registro.row, numeroOrden, usuario.usuario, jobId);';
const llamadaBase = 'await base.marcarOrdenCreada(registro.row, numeroOrden, usuario.usuario);';

let procesar = fs.readFileSync(procesarPath, 'utf8');
let adaptoSeguridad = false;

// Seguridad v6 añade jobId a esta llamada. El patch empresarial reutiliza el
// punto de inserción histórico y al terminar restauramos la firma segura.
if (procesar.includes(llamadaSegura) && !procesar.includes(llamadaBase)) {
  procesar = procesar.replace(llamadaSegura, llamadaBase);
  fs.writeFileSync(procesarPath, procesar, 'utf8');
  adaptoSeguridad = true;
}

await import('./patch-relacion-empresa-biofile-v6-9b.mjs');

if (adaptoSeguridad) {
  procesar = fs.readFileSync(procesarPath, 'utf8');
  if (!procesar.includes(llamadaBase)) {
    throw new Error('No se encontró la llamada a marcarOrdenCreada después del patch empresarial.');
  }
  procesar = procesar.replace(llamadaBase, llamadaSegura);
  fs.writeFileSync(procesarPath, procesar, 'utf8');
}

console.log('[BIOFILE] v6.9d: compatibilidad con idempotencia/seguridad v6 verificada.');
