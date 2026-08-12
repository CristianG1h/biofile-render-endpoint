import fs from 'node:fs';

const file = new URL('../src/google-sheets.js', import.meta.url);
let text = fs.readFileSync(file, 'utf8');
const before = "const range = `${escaparHoja(this.hoja)}!A:AZ`;";
const after = "const range = `${escaparHoja(this.hoja)}!A:ZZ`;";
if (text.includes(before)) {
  text = text.replace(before, after);
  fs.writeFileSync(file, text, 'utf8');
}
console.log('[BIOFILE] Rango de Google Sheets ampliado hasta ZZ.');
