import fs from 'node:fs';
import path from 'node:path';
import { asegurarDirectorio, fechaArchivo } from './util.js';

export function crearLogger(dir) {
  asegurarDirectorio(dir);
  const archivo = path.join(dir, `ejecucion-${fechaArchivo()}.log`);

  function escribir(nivel, mensaje, datos) {
    const linea = `[${new Date().toISOString()}] [${nivel}] ${mensaje}${datos ? ` ${JSON.stringify(datos)}` : ''}`;
    console.log(linea);
    fs.appendFileSync(archivo, `${linea}\n`, 'utf8');
  }

  return {
    archivo,
    info: (m, d) => escribir('INFO', m, d),
    warn: (m, d) => escribir('WARN', m, d),
    error: (m, d) => escribir('ERROR', m, d)
  };
}
