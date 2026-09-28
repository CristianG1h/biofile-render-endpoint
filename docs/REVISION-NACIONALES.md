# Revisión de fallos sobre la versión actualizada por el usuario

Se integran los cambios existentes hasta 7a9bc3a, conservando los productos compuestos (anexo y examen médico), las reglas de defaults y la preservación de campos comerciales de BIOFILE.

| Problema | Corrección | Verificación |
|---|---|---|
| Producto escrito contado como guardado | La fila de entrada queda fuera de la conciliación; se exige una fila guardada con cantidad correcta. | Navegador: clic sin guardar debe fallar; entrada más fila guardada cuenta una sola vez. |
| Nombre con `//PEREIRA` frente a `// PEREIRA` | Normalización del separador al comparar filas; la búsqueda usa el nombre completo del catálogo. | Caso sintético de anexo Pereira. |
| Cartago rechazado | Municipio exacto y país Colombia; no selecciona Costa Rica ni San Pedro de Cartago. Si hay dos municipios colombianos homónimos, exige departamento. | Pruebas de resolución inequívoca. |
| Ciudad ausente en capa de texto | OCR también cuando falta ciudad; conserva la identidad del texto digital y usa OCR para completar la ciudad. | Prueba de motores reales en CI; nunca se publican PDF de pacientes. |
| Ciudad `NO APLICA` | Se trata como ausente, se buscan etiquetas y pie del documento. | Pruebas con etiquetas, ciudades de residencia diferentes y sede. |
| Formato compacto de Pereira | Reconoce el pie Calle 19 5-13 + Clínica Risaralda, sede confirmada en el ejemplo del usuario. No usa nombre del paciente ni archivo para la ciudad. | Prueba de dirección completa; nombre de clínica solo no basta. |
| Eliminación irreversible | DELETE mueve a Eliminado con fecha/actor; POST concepts/:id/restore restaura. Conserva barreras de duplicación e historial. | Permisos, trabajo activo y restauración. |
| Historial lento | GET history no escribe cada concepto; panel evita consultas superpuestas y pausa polling con pestaña oculta. | Tests API y navegador. |
| Espera de sesión | El temporizador necesario no se desvincula del ciclo de eventos. | Prueba de timeout real y cancelación. |

El panel tiene Pendiente, Error (incluye parciales/interrumpidos), Ingresado y Eliminado. Un parcial conserva su O.S. y se reintenta sobre ella. Los ingresados no ofrecen un envío nuevo ordinario. Los conceptos borrados definitivamente en versiones anteriores no se pueden reconstruir si no existe una copia del archivo.

Para documentos ya cargados sin ciudad, vuelva a cargar el mismo PDF: se relee con las reglas nuevas, se conserva su identificador y el historial, y se exige revisar otra vez. La ciudad sigue pendiente cuando no hay evidencia suficiente; no se inventa por nombre del paciente.

Comandos: `npm test`, `node scripts/test-browser.mjs` (PANEL_DIR opcional), `node scripts/test-file-engines.mjs` con Poppler y Tesseract español instalados. No se crearon órdenes reales durante las pruebas.
