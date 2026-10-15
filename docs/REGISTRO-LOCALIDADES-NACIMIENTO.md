# Correcciones del registro — 15 de octubre de 2026

SANTA FE del formulario corresponde a SANTAFÉ (código 3) en BIOFILE. La selección ahora contempla esa equivalencia explícita sin aceptar nombres parciales. Las 20 localidades tienen pruebas de regresión.

Nacimiento compara ciudad, departamento y país por separado. Evita confundir SAN PEDRO con SAN PEDRO DE URABÁ, SANTANDER con NORTE DE SANTANDER y municipios homónimos. Conserva equivalencias explícitas y nombres de país con paréntesis.

Por solicitud del responsable, cuando no hay una sugerencia válida y única se escribe `bogota`, se selecciona `BOGOTÁ (BOGOTÁ D.C., COLOMBIA)` y se comprueba `HdfCiudadNacimiento`. No se aplica el respaldo si el clic no confirma el código o si la opción de Bogotá tampoco existe. No cambia la localidad ni la residencia.

El cambio se guarda en `ajustesNacimiento` del trabajo, con original, aplicado, motivo y fecha. El evento persistente `BIRTHPLACE_FALLBACK` permite conservarlo si una etapa posterior falla o el servidor reinicia. La API lo entrega al panel; el resultado final también lo incluye. La ficha del panel muestra la advertencia. El valor original de Google Sheets no se sobrescribe.

## Pruebas

- `npm ci` y `npm test`.
- `node scripts/test-browser.mjs` (requiere Chromium de Playwright).
- Con los tres repositorios en carpetas hermanas, ejecutar en Brigadas `node scripts/test-registro-resiliente.mjs` y `node scripts/test-todos-nacimientos.mjs`.
- En el panel, `node scripts/test-aviso-nacimiento.mjs`.

El recorrido exhaustivo usa opciones simuladas en Chromium para todos los lugares ofrecidos por el formulario construido. No acredita que el catálogo privado de BIOFILE contenga cada lugar ni crea órdenes reales. La prueba de localidades utiliza únicamente el SELECT extraído del HTML proporcionado; no se versiona el documento completo.

Publicar backend y panel conjuntamente para que el respaldo siempre tenga su advertencia visible. Verificar un registro autorizado en el entorno real tras desplegar.
