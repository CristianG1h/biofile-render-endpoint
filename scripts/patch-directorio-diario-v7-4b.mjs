import fs from 'node:fs';

const serverPath = new URL('../src/server.js', import.meta.url);
let server = fs.readFileSync(serverPath, 'utf8');
const MARCA = 'DIRECTORIO_EMPRESAS_DIARIO_V74B';

if (server.includes(`/* ${MARCA} */`)) {
  console.log('[Directorio] calendario diario v7.4b ya instalado.');
  process.exit(0);
}
if (!server.includes('DIRECTORIO_EMPRESAS_BIOFILE_V74')) {
  throw new Error('Primero debe ejecutarse patch-directorio-empresas-v7-4.mjs.');
}

const viejo = `async function directorioVencido() {
  const estado = await directorioEmpresasStore.obtenerEstado().catch(() => ({}));
  const ultimo = Date.parse(estado.ultimoExitoIso || '') || 0;
  return { estado, vencido: !ultimo || Date.now() - ultimo >= DIRECTORIO_SYNC_INTERVAL_MS };
}`;

const nuevo = `/* ${MARCA} */
function diaBogotaDirectorio(fecha = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(fecha);
}

function proximoDiaBogotaIso() {
  const hoy = diaBogotaDirectorio(new Date());
  const [y, m, d] = hoy.split('-').map(Number);
  // Colombia permanece en UTC-5: 00:05 local equivale a 05:05 UTC.
  return new Date(Date.UTC(y, m - 1, d + 1, 5, 5, 0)).toISOString();
}

async function directorioVencido() {
  const estado = await directorioEmpresasStore.obtenerEstado().catch(() => ({}));
  const ultimo = Date.parse(estado.ultimoExitoIso || '') || 0;
  const cambioDeDia = !ultimo || diaBogotaDirectorio(new Date(ultimo)) !== diaBogotaDirectorio(new Date());
  const superoIntervalo = !ultimo || Date.now() - ultimo >= DIRECTORIO_SYNC_INTERVAL_MS;
  return { estado, vencido: cambioDeDia || superoIntervalo };
}`;

if (!server.includes(viejo)) throw new Error('No se encontró directorioVencido() v7.4.');
server = server.replace(viejo, nuevo);

const proximaVieja = `    proximaRevisionIso: estado.ultimoExitoIso
      ? new Date((Date.parse(estado.ultimoExitoIso) || Date.now()) + DIRECTORIO_SYNC_INTERVAL_MS).toISOString()
      : ''`;
const proximaNueva = `    proximaRevisionIso: estado.ultimoExitoIso
      ? (() => {
          const porIntervalo = new Date((Date.parse(estado.ultimoExitoIso) || Date.now()) + DIRECTORIO_SYNC_INTERVAL_MS).getTime();
          const porDia = Date.parse(proximoDiaBogotaIso());
          return new Date(Math.min(porIntervalo, porDia)).toISOString();
        })()
      : ''`;
if (!server.includes(proximaVieja)) throw new Error('No se encontró cálculo de próxima revisión v7.4.');
server = server.replace(proximaVieja, proximaNueva);

if (!server.includes(MARCA) || !server.includes('diaBogotaDirectorio')) {
  throw new Error('Directorio diario v7.4b quedó incompleto.');
}

fs.writeFileSync(serverPath, server, 'utf8');
console.log('[Directorio] v7.4b: la vigencia se controla por día calendario de Bogotá además del intervalo configurado.');
