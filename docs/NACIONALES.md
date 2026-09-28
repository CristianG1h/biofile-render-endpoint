# Nacionales: operación y verificación

El módulo usa el login, los tres roles y la cola BIOFILE existentes. No crea pacientes sin revisión humana del documento. Los PDF e imágenes se procesan en temporales y se eliminan al terminar; el historial conserva únicamente datos administrativos, mapeos, hash y resultados. No se versionan documentos clínicos.

## Configuración inicial

1. Entre al panel con Super Admin y abra **Nacionales → Configuración Super Admin**.
2. Configure alias de empresa, acuerdo y empresa en misión con nombres exactos. El formulario consulta el directorio existente como referencia. Los alias se guardan como configuración, sin sustituir ese directorio.
3. Configure cada pareja ciudad/examen con uno de los **1008 productos** importados de Productos-y-Servicios.xlsx. Defina prestador, forma de pago y cantidad. El valor puede quedar vacío para conservar el valor BIOFILE; el precio del Excel es referencia y no una regla de cobro automática.
4. No se cargan mapeos inventados: el Excel no especifica prestadores ni equivalencias completas ciudad/examen. Un producto o empresa sin configurar bloquea el envío.
5. La reanudación de productos sobre una orden parcial necesita verificar en BIOFILE y completar `orderSearchInput`, `orderSearchButton` y `numeroOrden` en `config/selectors.json` (o el archivo privado definido por SELECTORS_PATH). Permanecen vacíos porque no hay evidencia del DOM de búsqueda. La creación normal obtiene el número por la etiqueta existente `N°. O.S.`.

## Flujo

Cargue uno o varios PDF/JPG/PNG, revise cada vista previa, corrija identidad, nacimiento, ciudad, evaluación y exámenes, seleccione empresa y marque la revisión. Puede filtrar, seleccionar, excluir del lote y enviar. La exclusión es una selección local de la sesión; no elimina el historial.

La extracción intenta texto PDF primero y OCR español solo si hace falta. Los documentos desconocidos usan un parser genérico. La presencia de una palabra de examen o un nombre dividido automáticamente no acredita precisión: compruebe exámenes realmente realizados y todos los campos marcados. Los valores administrativos permitidos aparecen como AUTO y con motivo. Nunca se inventa la identidad.

El envío valida todo antes de abrir BIOFILE. Registra la intención de guardar antes del clic; verifica la confirmación, conserva la orden y agrega productos secuencialmente mediante `#TbProducto #trProducto #BtnGuardar` y `AgregarProducto()`. Verifica nombre, cantidad, prestador, pago y precio explícito. No envía foto ni firma.

Un fallo después de guardar conserva el número y los productos confirmados como PARCIAL. No se crea otra orden. Un guardado incierto exige conciliación. Un duplicado completado requiere confirmación explícita de Super Admin; esa confirmación nunca autoriza ignorar otro guardado incierto. Los reintentos antiguos quedan bloqueados si existe un intento posterior.

## Tabla de comprobación

| Cambio | Cómo comprobarlo |
|---|---|
| Progreso por eventos | El porcentaje cambia con etapas confirmadas; los segundos solo actualizan duración. |
| Watchdog | Un bloqueo termina en error/interrumpido/parcial y conserva etapa y porcentaje. |
| Persistencia | Revise TRABAJOS_BIOFILE; reinicie en una prueba controlada y compruebe conciliación. |
| Aislamiento | Dos cuentas tienen colas y cookies independientes; una misma cuenta trabaja en secuencia. |
| Archivos | Pruebe PDF digital, PDF escaneado e imagen; tipo/extensión incorrectos se rechazan. |
| Revisión | Sin datos críticos, empresa o producto configurados no se puede procesar. |
| Productos | Compare la orden y cada fila con el mapeo; un reintento no debe repetir filas. |
| Permisos | user/admin usan el módulo; solo Super Admin configura y accede a capturas. |
| Historial | Compruebe orden, tiempo, etapa, error, métricas y productos confirmados en Ver detalle. |
| Panel existente | Compruebe dashboard, Centro VIP, directorio, ingreso manual y Eliminado por. |

## Validación realizada y límites

Se revisaron 166 PDF (180 páginas) y una imagen del ZIP, agrupando estructuras equivalentes. El corpus PDF se ejecutó en memoria con texto de pypdf en modo layout; no constituye validación del OCR de producción ni una medición de exactitud. Hay nueve familias PDF reconocidas y fallback genérico; la imagen requiere OCR. Muchos conceptos no contienen fecha de nacimiento, educación o municipio de residencia: se pide completar esos datos.

Las pruebas automatizadas usan datos sintéticos: parsers, defaults, fechas, permisos, mapeos, colas, duplicados, watchdog y recuperación. La prueba Playwright reproduce la tabla observada y comprueba integración del panel en escritorio y móvil. No se crearon órdenes reales ni se validaron credenciales BIOFILE durante desarrollo. La prueba final con una orden autorizada debe realizarse tras configurar los mapeos reales.

## Archivos principales

| Archivos | Responsabilidad |
|---|---|
| src/jobs/job-store.js, job-service.js, execution.js, recovery.js | Historial durable, colas, cancelación, watchdog y conciliación. |
| src/nacionales/file-service.js, template-detector.js, parser.js, normalize.js | Validación de archivos, extracción/OCR y datos normalizados. |
| src/nacionales/defaults.js, validators.js, product-mapper.js | Defaults identificados, revisión obligatoria y catálogo exacto. |
| src/nacionales/index.js, processing-service.js | API autenticada y flujo de orden/productos. |
| src/biofile-products.js, diagnostic-store.js | Confirmación de filas y retención de capturas. |
| config/nacionales/product-catalog.json, config/selectors.json | Catálogo importado y controles DOM. |
| src/server.js, procesar-registro.js, biofile.js | Integración del flujo existente con progreso, persistencia y guardado seguro. |
| src/browser.js, google-sheets.js, datos-registro-adicionales.js, fetch-resiliente.js | Navegador compartido, sesiones aisladas, lectura por fila y caché de autenticación. |
| package.json, Dockerfile, .github/workflows/ci.yml | Arranque directo, motores OCR y pruebas de CI. |
| tests/*.test.mjs, scripts/test-browser.mjs, scripts/verify-corpus.mjs | Verificaciones sintéticas y corpus sin publicar pacientes. |

Los cambios antiguos de scripts patch se consolidaron en los archivos fuente (incluidos directorio, catálogo y relaciones). Los scripts históricos siguen disponibles como referencia, pero no deben ejecutarse sobre las fuentes actuales.
