import fs from 'node:fs';

const file = new URL('../src/google-sheets.js', import.meta.url);
let text = fs.readFileSync(file, 'utf8');

if (!text.includes('/* GRID_COLUMNS_AUTO_V5 */')) {
  const marker = `  async batchUpdateValues(spreadsheetId, data) {\n    return this.request(\`https://sheets.googleapis.com/v4/spreadsheets/\${spreadsheetId}/values:batchUpdate\`, {\n      method: 'POST',\n      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data })\n    });\n  }\n`;

  if (!text.includes(marker)) {
    throw new Error('No se encontró batchUpdateValues() en google-sheets.js.');
  }

  const replacement = `${marker}\n  /* GRID_COLUMNS_AUTO_V5 */\n  async ensureColumnCount(spreadsheetId, sheetName, requiredColumns) {\n    const required = Number(requiredColumns || 0);\n    if (!Number.isFinite(required) || required <= 0) return;\n\n    const metadata = await this.request(\n      \`https://sheets.googleapis.com/v4/spreadsheets/\${spreadsheetId}?fields=sheets.properties(sheetId,title,gridProperties(columnCount))\`\n    );\n\n    const sheet = (metadata.sheets || []).find(\n      (item) => String(item?.properties?.title || '') === String(sheetName || '')\n    );\n\n    if (!sheet?.properties) {\n      throw new Error(\`No se encontró la hoja "\${sheetName}" para ampliar sus columnas.\`);\n    }\n\n    const current = Number(sheet.properties.gridProperties?.columnCount || 0);\n    if (current >= required) return;\n\n    const length = required - current;\n    await this.request(\n      \`https://sheets.googleapis.com/v4/spreadsheets/\${spreadsheetId}:batchUpdate\`,\n      {\n        method: 'POST',\n        body: JSON.stringify({\n          requests: [{\n            appendDimension: {\n              sheetId: sheet.properties.sheetId,\n              dimension: 'COLUMNS',\n              length\n            }\n          }]\n        })\n      }\n    );\n  }\n`;

  text = text.replace(marker, replacement);

  const before = `    const inicio = (this.rows[0]?.length || 0) + 1;\n    const data = faltantes.map((nombre, index) => ({\n      range: \`${'${escaparHoja(this.hoja)}'}!${'${columnaA1(inicio + index)}'}1\`,\n      values: [[nombre]]\n    }));`;

  const after = `    const inicio = (this.rows[0]?.length || 0) + 1;\n    const ultimaColumnaNecesaria = inicio + faltantes.length - 1;\n\n    // Google Sheets no permite escribir, por ejemplo, AS1 si la hoja física\n    // solo llega hasta AR. Ampliamos primero la cuadrícula y luego agregamos\n    // las columnas de control. Esto evita el error \"Range exceeds grid limits\".\n    await this.api.ensureColumnCount(\n      this.spreadsheetId,\n      this.hoja,\n      ultimaColumnaNecesaria\n    );\n\n    const data = faltantes.map((nombre, index) => ({\n      range: \`${'${escaparHoja(this.hoja)}'}!${'${columnaA1(inicio + index)}'}1\`,\n      values: [[nombre]]\n    }));`;

  if (!text.includes(before)) {
    throw new Error('No se encontró el bloque de columnas faltantes en google-sheets.js.');
  }

  text = text.replace(before, after);
  fs.writeFileSync(file, text, 'utf8');
}

if (!text.includes('async ensureColumnCount(')) {
  throw new Error('No quedó instalada la ampliación automática de columnas.');
}

console.log('[BIOFILE] Cuadrícula de Google Sheets: ampliación automática de columnas habilitada.');
