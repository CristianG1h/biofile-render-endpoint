import fs from 'node:fs';

const sheetsPath = new URL('../src/google-sheets.js', import.meta.url);
let sheets = fs.readFileSync(sheetsPath, 'utf8');

if (!sheets.includes('/* FECHA_LOCAL_COLOMBIA_V63 */')) {
  const anterior = "      if (typeof valor === 'number' && normalizar(encabezado).includes('FECHA')) {\n        const ms = Date.UTC(1899, 11, 30) + Math.round(valor * 86400000);\n        const d = new Date(ms);\n        if (!Number.isNaN(d.getTime())) return d.toISOString();\n      }";
  const nuevo = "      if (typeof valor === 'number' && normalizar(encabezado).includes('FECHA')) {\n        /* FECHA_LOCAL_COLOMBIA_V63 */\n        const ms = Date.UTC(1899, 11, 30) + Math.round(Number(valor) * 86400000);\n        const d = new Date(ms);\n        if (!Number.isNaN(d.getTime())) {\n          const p = (n) => String(n).padStart(2, '0');\n          const yyyy = d.getUTCFullYear();\n          const mm = p(d.getUTCMonth() + 1);\n          const dd = p(d.getUTCDate());\n          const hh = p(d.getUTCHours());\n          const mi = p(d.getUTCMinutes());\n          const ss = p(d.getUTCSeconds());\n          return yyyy + '-' + mm + '-' + dd + 'T' + hh + ':' + mi + ':' + ss + '-05:00';\n        }\n      }";
  if (!sheets.includes(anterior)) throw new Error('No se encontró la conversión numérica de fechas del listado v6.1.');
  sheets = sheets.replace(anterior, nuevo);
  fs.writeFileSync(sheetsPath, sheets, 'utf8');
}

console.log('[BIOFILE] Hora Colombia v6.3 aplicada.');
