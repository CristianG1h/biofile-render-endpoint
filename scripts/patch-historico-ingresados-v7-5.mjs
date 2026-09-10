import fs from 'node:fs';

const sheetsPath = new URL('../src/google-sheets.js', import.meta.url);
let sheets = fs.readFileSync(sheetsPath, 'utf8');

if (!sheets.includes('/* HISTORICO_INGRESADOS_BACKEND_V75 */')) {
  const anterior = "      if (!estadoListado && corteHistorico && fechaListado && fechaListado < corteHistorico) continue;";
  const nuevo = `      /* HISTORICO_INGRESADOS_BACKEND_V75 */
      if (!estadoListado && corteHistorico && fechaListado && fechaListado < corteHistorico) {
        // Estos registros existían antes de activar la trazabilidad ESTADO_BIOFILE.
        // Se devuelven al panel como históricos sin modificar Google Sheets y sin
        // mezclarlos con la cola operativa de pendientes actuales.
        registro['ESTADO_BIOFILE'] = 'HISTORICO';
        if (!texto(registro['MODO_INGRESO_BIOFILE'])) registro['MODO_INGRESO_BIOFILE'] = 'HISTORICO';
        registro['_HISTORICO_BIOFILE'] = true;
      }`;

  if (!sheets.includes(anterior)) {
    throw new Error('No se encontró el corte histórico v6.2. Verifique el orden de los parches.');
  }
  sheets = sheets.replace(anterior, nuevo);
  fs.writeFileSync(sheetsPath, sheets, 'utf8');
}

if (!sheets.includes("registro['ESTADO_BIOFILE'] = 'HISTORICO'")) {
  throw new Error('No quedó instalada la restauración de registros históricos.');
}

console.log('[BIOFILE] Históricos anteriores al control automático restaurados para el panel.');
