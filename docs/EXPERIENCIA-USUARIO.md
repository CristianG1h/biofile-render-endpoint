# Encuesta de experiencia de usuario

Integración de VIP Salud Ocupacional para programar encuestas después del ingreso en BIOFILE.

## Flujo

1. BIOFILE queda completado.
2. El backend registra el evento de experiencia.
3. Google Apps Script guarda el paciente en CONTROL_ENCUESTAS.
4. El correo se programa tres horas después.
5. El paciente responde Google Forms con un código prellenado.
6. La respuesta queda asociada al registro del paciente.

## Configuración de Render

El servicio usa dos variables de entorno para conectarse con el webhook de experiencia. Sus valores reales deben mantenerse únicamente en Render.

## Prueba rápida

Para probar sin esperar tres horas, use un paciente de prueba con un correo controlado. Cuando aparezca en CONTROL_ENCUESTAS, cambie FECHA_PROGRAMADA_ENVIO a una hora anterior a la actual y ejecute manualmente procesarCorreosPendientes desde Apps Script.
