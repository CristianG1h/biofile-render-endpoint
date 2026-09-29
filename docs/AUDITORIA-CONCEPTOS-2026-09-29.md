# Auditoría del ZIP de conceptos — 29 de septiembre de 2026

Se revisaron los 166 PDF y la imagen JPG del ZIP proporcionado, con lectura digital y OCR local mediante Poppler y Tesseract en español. Los documentos de pacientes y su texto no se incorporan al repositorio. El informe cuenta campos detectados; no certifica la exactitud de cada dato clínico.

## Estructuras

| Formato detectado | Cantidad | Estructura y tratamiento |
|---|---:|---|
| worker-table | 136 | Tabla de trabajador, identidad y edad en filas; ciudad en fecha/lugar de realización. |
| osteomuscular-sections | 15 | Apellido y nombre separados, cargo/ciudad y tabla de exámenes. No aplica se trata como ciudad ausente. |
| compact-aptitude | 6 | Identificación y nombre completo, edad, atención y exámenes practicados. Sede en pie de página gráfico; requiere OCR. |
| clinical-certificate | 3 | Historia clínica, datos del paciente y ubicación por departamento/ciudad. |
| patient-admission | 2 | Admisión, fecha de ingreso y certificado de aptitud. |
| physical-aptitude | 1 | Documento/nombre/sexo en una fila y ciudad junto a fecha. |
| attention-sections | 1 | Datos del cliente y sección de atención. |
| aptitude-sections | 1 | Paciente, residencia y lugar explícito de realización. |
| labor-certificate | 1 | Certificado laboral, identificación partida y referencia Cartago/Valle del Cauca. |
| diagnostic-aids | 1 JPG | Imagen invertida, etiquetas en una sola línea; orientación OCR y límites por etiquetas para separar identidad, residencia y ciudad del examen. |

## Correcciones verificables

| Cambio | Comprobación |
|---|---|
| Error de carga persistente por archivo | El panel conserva nombre y mensaje aunque termine el lote. |
| Reintento del mismo archivo | El selector se limpia al terminar, permitiendo seleccionar de nuevo el PDF. |
| Concepto cargado visible | Al recibir el resultado se abre su sección y se limpia el filtro de estado. |
| OCR con orientación | Recupera la imagen invertida del ZIP; reconoce Sopó como ciudad del examen y separa Tocancipá como residencia. |
| Pie de página pequeño | Segunda pasada a mayor resolución solo si faltan datos tras la primera; no se activa en los PDF digitales ya resueltos. |
| Fallo parcial del OCR | Conserva el texto digital y deja una advertencia para revisión; los archivos sin texto legible siguen mostrando un error. |
| Diagnóstico del motor | Mensajes indican inspección, texto, conversión o página OCR; no exponen stderr clínico. |
| Memoria y archivos temporales | Procesamiento de una página cada vez, borrado de imágenes y limpieza final. |
| Ciudad vacía | No consume el título de la sección siguiente como si fuera una ciudad. |

El concepto señalado por el usuario se probó individualmente: lectura completa, identidad presente y Pereira identificada por la dirección de la sede ya verificada. No se reprodujo la excepción del servidor original: la captura solo contiene un contador genérico y no permite atribuirla a una causa concreta.

## Reproducción

`scripts/audit-concepts.mjs` recibe JSONL por stdin con `name`, `mime` y `data` base64. Devuelve únicamente conteos, índices anónimos y errores de lectura. No escribe los documentos de entrada. Requiere Poppler, Tesseract, idioma `spa` y orientación `osd`; admite las variables `PDFINFO_BIN`, `PDFTOTEXT_BIN`, `PDFTOPPM_BIN` y `TESSERACT_BIN`.

Validación: `npm test`, `node scripts/test-file-engines.mjs`, y `node scripts/test-browser.mjs` con `PANEL_DIR` apuntando al panel. Las pruebas del navegador simulan un fallo de carga y la reselección del mismo archivo. No crean órdenes reales.

## Resultado del corpus completo

167 archivos leídos, cero fallos de extracción. Documento, primer nombre y primer apellido presentes en los 167 resultados. Ciudad identificada en 160; siete requieren confirmación. 153 archivos se resolvieron con texto digital; 13 PDF necesitaron OCR complementario y el JPG necesitó OCR completo.

| Ciudad detectada | Archivos |
|---|---:|
| SANTA MARTA | 1 |
| SOPÓ | 1 |
| BOGOTÁ | 75 |
| MEDELLÍN | 30 |
| MONTERÍA | 2 |
| MANIZALES | 1 |
| CARTAGENA | 6 |
| VILLAVICENCIO | 3 |
| VALLEDUPAR | 2 |
| CALI | 8 |
| POR CONFIRMAR | 7 |
| BARRANQUILLA | 21 |
| CÚCUTA | 1 |
| TUNJA | 1 |
| BUCARAMANGA | 1 |
| CARTAGO | 1 |
| PEREIRA | 6 |

Los siete pendientes corresponden a osteomuscular-sections con ciudad «No aplica» y ciudad de atención vacía. Los índices anónimos figuran en el JSON adjunto. Se verificó visualmente una muestra de esta estructura; la lectura completa no encontró evidencia suficiente para asignarles ciudad.
