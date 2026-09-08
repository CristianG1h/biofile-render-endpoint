import fs from 'node:fs';

const path = new URL('../src/relacion-empresa.js', import.meta.url);
let codigo = fs.readFileSync(path, 'utf8');
const MARCA = 'RELACION_PLACEHOLDER_V73';

if (codigo.includes(MARCA)) {
  console.log('[BIOFILE] v7.3: recuperación de relación con placeholder ya instalada.');
  process.exit(0);
}

const anterior = `    return { ambiguo: true, fuente: 'par-explicito-invalido' };\n  }\n\n  if (misionTexto) {`;

const nuevo = `    /* ${MARCA} */\n    // Algunos registros antiguos conservan PARTICULARES en el campo Acuerdo\n    // aunque Empresa en misión sí trae la empresa real. Ese valor es un\n    // placeholder histórico y no debe invalidar una misión exacta del catálogo.\n    const esPlaceholder = (valor) => ['PARTICULARES', 'PARTICULAR'].includes(claveEmpresa(valor));\n    const acuerdoPlaceholder = esPlaceholder(acuerdoTexto);\n    const misionPlaceholder = esPlaceholder(misionTexto);\n\n    if (acuerdoPlaceholder && !misionPlaceholder) {\n      const porMision = resolverMisionExacta(indice, misionTexto);\n      if (porMision && !porMision.ambiguo && porMision.acuerdo && porMision.empresaMision) {\n        return {\n          ...porMision,\n          fuente: 'mision-recuperada-acuerdo-particulares'\n        };\n      }\n    }\n\n    if (misionPlaceholder && !acuerdoPlaceholder) {\n      const porAcuerdo = resolverAcuerdoExacto(indice, acuerdoTexto);\n      if (porAcuerdo && !porAcuerdo.ambiguo && porAcuerdo.acuerdo && porAcuerdo.empresaMision) {\n        return {\n          ...porAcuerdo,\n          fuente: 'acuerdo-recuperado-mision-particulares'\n        };\n      }\n    }\n\n    // Si ninguno era placeholder, solo se recupera cuando resolver cada campo\n    // por separado conduce exactamente a la misma pareja. Así no se adivina.\n    if (!acuerdoPlaceholder && !misionPlaceholder) {\n      const porMision = resolverMisionExacta(indice, misionTexto);\n      const porAcuerdo = resolverAcuerdoExacto(indice, acuerdoTexto);\n      if (\n        porMision && !porMision.ambiguo && porMision.acuerdo && porMision.empresaMision &&\n        porAcuerdo && !porAcuerdo.ambiguo && porAcuerdo.acuerdo && porAcuerdo.empresaMision &&\n        claveEmpresa(porMision.acuerdo) === claveEmpresa(porAcuerdo.acuerdo) &&\n        claveEmpresa(porMision.empresaMision) === claveEmpresa(porAcuerdo.empresaMision)\n      ) {\n        return {\n          acuerdo: porMision.acuerdo,\n          empresaMision: porMision.empresaMision,\n          fuente: 'par-explicito-reconciliado'\n        };\n      }\n    }\n\n    return { ambiguo: true, fuente: 'par-explicito-invalido' };\n  }\n\n  if (misionTexto) {`;

if (!codigo.includes(anterior)) {
  throw new Error('No se encontró el punto de recuperación de relación empresarial.');
}

codigo = codigo.replace(anterior, nuevo);
fs.writeFileSync(path, codigo, 'utf8');
console.log('[BIOFILE] v7.3: PARTICULARES ya no anula una Empresa en misión válida del catálogo.');
