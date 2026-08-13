import fs from 'node:fs';

const sheetsPath = new URL('../src/google-sheets.js', import.meta.url);
let sheets = fs.readFileSync(sheetsPath, 'utf8');

if (!sheets.includes('/* CORTE_HISTORICO_PENDIENTES_V62 */')) {
  const cabecera = "    const q = normalizar(busqueda);\n    const registros = [];\n\n    const valorListado";
  if (!sheets.includes(cabecera)) throw new Error('No se encontró listarRegistros() generado por seguridad v6.1.');

  sheets = sheets.replace(
    cabecera,
    `    const q = normalizar(busqueda);\n    const registros = [];\n    /* CORTE_HISTORICO_PENDIENTES_V62 */\n    const corteHistorico = String(process.env.BIOFILE_LISTADO_DESDE || '2026-08-13').trim();\n\n    const fechaSolo = (valor) => {\n      const s = String(valor ?? '').trim();\n      if (!s) return '';\n      let m = s.match(/^(\\d{4})-(\\d{2})-(\\d{2})/);\n      if (m) return \`\${m[1]}-\${m[2]}-\${m[3]}\`;\n      m = s.match(/^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})/);\n      if (m) return \`\${m[3]}-\${m[2].padStart(2, '0')}-\${m[1].padStart(2, '0')}\`;\n      return '';\n    };\n\n    const valorListado`
  );

  const antesBusqueda = "      if (q) {\n        const bolsa = normalizar(Object.values(registro).join(' '));";
  if (!sheets.includes(antesBusqueda)) throw new Error('No se encontró el punto de filtrado del listado v6.1.');

  sheets = sheets.replace(
    antesBusqueda,
    `      if (!texto(registro['N° documento'])) continue;\n      const estadoListado = normalizar(registro['ESTADO_BIOFILE']);\n      const fechaListado = fechaSolo(registro['Fecha de registro']);\n      if (!estadoListado && corteHistorico && fechaListado && fechaListado < corteHistorico) continue;\n\n      if (q) {\n        const bolsa = normalizar(Object.values(registro).join(' '));`
  );

  fs.writeFileSync(sheetsPath, sheets, 'utf8');
}

console.log('[BIOFILE] Seguridad v6.2: pendientes históricos sin estado excluidos del listado operativo.');
