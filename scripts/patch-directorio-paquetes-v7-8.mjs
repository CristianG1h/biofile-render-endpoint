import fs from 'node:fs';

const directorioPath = new URL('../src/directorio-empresas-biofile.js', import.meta.url);
const biofilePath = new URL('../src/biofile.js', import.meta.url);
const MARCA = 'DIRECTORIO_ESTABLE_SIN_MISION_V78';

let directorio = fs.readFileSync(directorioPath, 'utf8');
let biofile = fs.readFileSync(biofilePath, 'utf8');
let cambioDirectorio = false;
let cambioBiofile = false;

// 1) Cuando el directorio se consolida (por ejemplo 715 filas -> 706 empresas
// únicas), limpiar las filas antiguas que queden por debajo del nuevo final.
// Antes se reescribía solo A1:I707 y las 9 filas viejas seguían en Sheets; al
// reiniciar el servicio volvían a leerse y el contador regresaba a 715.
if (!directorio.includes(`/* ${MARCA}_DIRECTORIO */`)) {
  if (!directorio.includes('async limpiar(id, range)')) {
    const cierreSheetsClient = directorio.indexOf('\n}\n\nexport class DirectorioEmpresasBiofileStore');
    const inicioEscribir = directorio.indexOf('  async escribir(id, range, values) {');
    if (inicioEscribir < 0 || cierreSheetsClient < 0 || cierreSheetsClient <= inicioEscribir) {
      throw new Error('No se encontró SheetsClient.escribir() para instalar limpieza de filas sobrantes.');
    }
    const metodoLimpiar = `\n\n  async limpiar(id, range) {\n    return this.request(\n      \`https://sheets.googleapis.com/v4/spreadsheets/\${id}/values/\${encodeURIComponent(range)}:clear\`,\n      { method: 'POST', body: '{}' }\n    );\n  }`;
    directorio = directorio.slice(0, cierreSheetsClient) + metodoLimpiar + directorio.slice(cierreSheetsClient);
  }

  const escritura = "      await this.client.escribir(this.spreadsheetId, `${escaparHoja(this.hojaEmpresas)}!A1:I${values.length}`, values);";
  if (!directorio.includes(escritura)) {
    throw new Error('No se encontró la escritura principal del directorio para limpiar filas sobrantes.');
  }
  const escrituraSegura = `${escritura}\n\n      /* ${MARCA}_DIRECTORIO */\n      const ultimaFilaNueva = items.length + 1; // encabezado + empresas únicas\n      const ultimaFilaAnterior = existentes.length + 1;\n      if (ultimaFilaAnterior > ultimaFilaNueva) {\n        const desde = ultimaFilaNueva + 1;\n        const rangoSobrante = \`${'${escaparHoja(this.hojaEmpresas)}'}!A\${desde}:I\${ultimaFilaAnterior}\`;\n        await this.client.limpiar(this.spreadsheetId, rangoSobrante);\n      }`;
  directorio = directorio.replace(escritura, escrituraSegura);
  cambioDirectorio = true;
}

// 2) La revisión de paquetes NO necesita consultar "Nombre de la Empresa en
// Misión". El paquete se obtiene directamente desde Órdenes de Servicio para el
// acuerdo comercial y el tipo de evaluación seleccionados. Se elimina esa
// consulta para evitar resultados confusos y reducir trabajo del navegador.
if (!biofile.includes(`/* ${MARCA}_SIN_MISION */`)) {
  const inicioMision = biofile.indexOf('      if (!empresasMision.length) {');
  const inicioPaquete = biofile.indexOf('\n      const inputPaquete =', inicioMision);
  if (inicioMision < 0 || inicioPaquete < 0 || inicioPaquete <= inicioMision) {
    throw new Error('No se encontró el bloque de Empresa en Misión dentro de investigarCatalogoEmpresa().');
  }
  const reemplazo = `      /* ${MARCA}_SIN_MISION */\n      // No consultar Empresa en Misión durante la investigación de paquetes.\n      // Se conserva empresasMision=[] únicamente por compatibilidad de respuesta.\n`;
  biofile = biofile.slice(0, inicioMision) + reemplazo + biofile.slice(inicioPaquete + 1);
  cambioBiofile = true;
}

if (!directorio.includes(`/* ${MARCA}_DIRECTORIO */`) ||
    !directorio.includes('async limpiar(id, range)') ||
    !biofile.includes(`/* ${MARCA}_SIN_MISION */`)) {
  throw new Error('La corrección v7.8 quedó incompleta.');
}

if (cambioDirectorio) fs.writeFileSync(directorioPath, directorio, 'utf8');
if (cambioBiofile) fs.writeFileSync(biofilePath, biofile, 'utf8');

console.log('[BIOFILE] v7.8: directorio estable sin filas sobrantes y revisión de paquetes sin Empresa en Misión.');
