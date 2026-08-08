# BIOFILE Robot API para Render

Este proyecto convierte la automatización local en un **Web Service con endpoint HTTP**.

La API **no toma automáticamente el último registro** y **no procesa toda la hoja**. Cada solicitud debe indicar la cédula/documento exacto del paciente que se seleccionó en la página.

## Flujo

1. La página envía el documento al endpoint.
2. La API busca ese documento exacto en Google Sheets.
3. Solo lo procesa si `ESTADO_BIOFILE` está vacío, `PENDIENTE` o `ERROR`.
4. Abre BIOFILE con Playwright, llena la orden y guarda.
5. Según `subirImagenes`, también carga fotografía y firma.
6. Actualiza Google Sheets como `COMPLETADO`, `ERROR` o `PARCIAL`.
7. Solo se ejecuta un robot a la vez para reducir duplicados.

## Endpoints

### Salud

```http
GET /api/health
```

No requiere clave.

### Enviar paciente a BIOFILE

```http
POST /api/biofile/enviar
Content-Type: application/json
X-API-Key: TU_API_KEY

{
  "documento": "52103281",
  "subirImagenes": true
}
```

La respuesta es `202 Accepted` y contiene un `job.id`.

### Consultar el trabajo

```http
GET /api/biofile/trabajos/JOB_ID
X-API-Key: TU_API_KEY
```

Estados posibles:

- `en_cola`
- `procesando`
- `completado`
- `error`

## Despliegue en Render

### 1. Subir a GitHub

Sube únicamente el contenido de esta carpeta. No subas:

- `.env`
- `.auth/`
- `credentials/*.json`
- `node_modules/`
- `logs/`
- `screenshots/`

### 2. Crear el servicio

En Render:

1. `New` → `Web Service`.
2. Conecta el repositorio de GitHub.
3. Selecciona `Docker`.
4. Render detectará el `Dockerfile`.
5. Health Check Path: `/api/health`.

También puedes usar `render.yaml` como Blueprint.

### 3. Variables obligatorias

Crea en **Environment**:

- `API_KEY`: clave larga y aleatoria para proteger el endpoint.
- `GOOGLE_SHEETS_URL`: URL de la hoja real.
- `GOOGLE_SHEETS_HOJA`: normalmente `Hoja 1`.
- `GOOGLE_AUTH_MODE`: `service_account`.
- `BIOFILE_USUARIO`.
- `BIOFILE_CONTRASENA`.
- `DEFAULT_LOCALIDAD`: opción exacta que aparece en BIOFILE.
- `DEFAULT_SEDE`: opción exacta que aparece en BIOFILE.
- `DEFAULT_TIPO_EVALUACION`: opción exacta que aparece en BIOFILE.

Revisa `.env.example` para los valores opcionales.

### 4. Cuenta de servicio de Google

En Render, dentro de **Environment → Secret Files**:

1. Crea un archivo secreto llamado `google-service-account.json`.
2. Pega el contenido completo del JSON de la cuenta de servicio.
3. Mantén esta variable:

```env
GOOGLE_SERVICE_ACCOUNT_FILE=/etc/secrets/google-service-account.json
```

Comparte el Google Sheet con el `client_email` del JSON y permiso **Editor**.

## Prueba rápida

Reemplaza la URL, la clave y la cédula:

```bash
curl -X POST "https://TU-SERVICIO.onrender.com/api/biofile/enviar" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: TU_API_KEY" \
  -d '{"documento":"52103281","subirImagenes":true}'
```

Luego consulta el `job.id` recibido:

```bash
curl "https://TU-SERVICIO.onrender.com/api/biofile/trabajos/JOB_ID" \
  -H "X-API-Key: TU_API_KEY"
```

## Conexión futura con la página

El botón **Enviar a BIOFILE** deberá:

1. Tomar la cédula del paciente seleccionado.
2. Enviar `POST /api/biofile/enviar`.
3. Guardar el `job.id`.
4. Consultar el endpoint de estado cada 2–3 segundos.
5. Mostrar al usuario si quedó `completado` o `error`.

No se deben poner el usuario ni la contraseña de BIOFILE dentro del HTML.

## Verificación de acceso

Conexión de escritura de GitHub verificada correctamente el 8 de agosto de 2026.
