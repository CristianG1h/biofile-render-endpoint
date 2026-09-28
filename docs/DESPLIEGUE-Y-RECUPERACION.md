# Despliegue y recuperación

## Render

Conserve las variables y el secreto Google actuales. El Dockerfile instala Poppler, Tesseract español y Chromium compatible. El comando de arranque es `npm start`, sin patches. El servicio Google necesita permiso de edición y creación de pestañas en la hoja existente; al iniciar se crea TRABAJOS_BIOFILE y se concilian trabajos anteriores. Si falla la persistencia, los nuevos envíos se bloquean.

**Este almacén admite una sola instancia escritora.** No escale a múltiples réplicas ni ejecute copias de desarrollo contra la hoja de producción. Despliegue con las colas vacías: la transición de Render puede superponer instancias. El journal de Sheets no ofrece un bloqueo distribuido ni una transacción conjunta con BIOFILE. Los guardados inciertos se bloquean conservadoramente para conciliación humana.

Verifique `/api/health`, los logs de inicio y el envío autenticado. Un health HTTP correcto no acredita permisos de la hoja ni éxito BIOFILE. El navegador permanece compartido, pero cada contexto/cookie es privado por cuenta; la caché de sesión vive en memoria 15 minutos. Tras un reinicio vuelve a autenticar.

## Variables nuevas opcionales

No copie líneas vacías sobre valores actuales. `.env.example` contiene solo nombres, sin secretos. Los valores siguientes son los defaults del código, no credenciales.

| Variable | Default | Función |
|---|---|---|
| BIOFILE_JOBS_SHEET | TRABAJOS_BIOFILE | Journal de trabajos, conceptos y mapeos. |
| JOB_IDLE_TIMEOUT_MS | 90000 | Sin actividad confirmada antes de cancelar. |
| JOB_MAX_DURATION_MS | 600000 | Duración máxima de ejecución. |
| JOB_MAX_AUTO_RETRIES | 0 | De 0 a 2; solo errores de conexión anteriores a cualquier guardado, con backoff de 1/2 s. |
| BROWSER_MAX_CONTEXTS | 2 | Límite de contextos; use 1 si la memoria de Render es escasa. |
| BIOFILE_FIELD_TIMEOUT_MS | 8000 | Operaciones de campos. |
| BIOFILE_NAVIGATION_TIMEOUT_MS | 15000 | Navegación. |
| SCREENSHOT_RETENTION_MS | 86400000 | Retención de capturas privadas. |
| NACIONALES_MAX_FILE_BYTES | 10485760 | Límite por archivo; panel limita también a 10 MB. |
| NACIONALES_MAX_PAGES | 10 | Páginas por PDF. |
| PDFINFO_BIN / PDFTOTEXT_BIN / PDFTOPPM_BIN / TESSERACT_BIN | binarios del PATH | Rutas opcionales a motores locales. |

Las capturas privadas se purgan después de 24 horas al iniciar y cada hora. No se publican como archivos estáticos. Se accede a la captura de Nacionales mediante `GET /api/nacionales/jobs/:id/screenshot`, autenticado como Super Admin. El historial administrativo permanece en Sheets; aplique allí la política de retención de su organización. El webhook de experiencia se desacopla del tiempo de la orden y no tiene cola durable de entrega.

## Netlify

El panel conserva su despliegue separado. El build pasa a `node scripts/verify-build.mjs`; valida el código consolidado en lugar de modificarlo. No necesita nuevos secretos. Publique backend primero y panel después. Compruebe login, Nacionales y Centro VIP. Puede ser necesario cerrar sesión y entrar para refrescar los datos del panel.

## Comandos de verificación

Backend: `npm ci`, `npm test`. Para navegador: `npx playwright install chromium` y `node scripts/test-browser.mjs`. Defina PANEL_DIR con el directorio del frontend para incluir su prueba responsive. En Linux local instale Poppler/Tesseract o use el Dockerfile.

Frontend: `node scripts/verify-build.mjs`, `node scripts/verificar-panel-v7-3.mjs`, `node scripts/verificar-directorio-v7-4.mjs`.

## Incidentes y rollback

Si hay una orden parcial, conserve su número y compare los productos. Reanude solo con selectores de búsqueda verificados; si no están disponibles, concilie manualmente en BIOFILE. No borre el journal para forzar reintentos. Si un trabajo quedó antes del guardado, el sistema puede ofrecer reintentar. Los timeouts después del clic no acreditan que no se haya guardado.

Para revertir código use un commit de reversión normal y redepliegue ambos proyectos con las colas vacías; no borre hojas, mapeos ni historial. La versión previa no interpreta el journal nuevo: concilie primero todos los trabajos pendientes antes de regresar a ella.
