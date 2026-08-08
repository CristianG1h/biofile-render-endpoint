# BIOFILE Robot API para Render

Este proyecto expone un endpoint HTTP protegido para enviar a BIOFILE un paciente específico de Google Sheets. Admite acceso multiusuario: cada persona inicia sesión con sus propias credenciales de BIOFILE y conserva una sesión de navegador independiente.

Las contraseñas nunca deben guardarse en GitHub ni dentro del HTML del panel.

## Flujo

1. El usuario inicia sesión en el panel.
2. La API valida sus credenciales configuradas de forma secreta en Render y devuelve un token temporal.
3. La página envía el documento y, preferiblemente, la fila exacta de Google Sheets.
4. La API usa la cuenta BIOFILE del usuario conectado, llena la orden y guarda.
5. Según `subirImagenes`, también carga fotografía y firma.
6. Google Sheets queda marcado como `COMPLETADO`, `ERROR` o `PARCIAL`.
7. Solo se ejecuta un robot a la vez para reducir duplicados.

La integración anterior mediante `X-API-Key` continúa disponible durante la migración de los frontends.

## Endpoints

### Salud

```http
GET /api/health
```

No requiere autenticación.

### Iniciar sesión

```http
POST /api/auth/login
Content-Type: application/json

{
  "usuario": "USUARIO BIOFILE",
  "contrasena": "CONTRASEÑA BIOFILE"
}
```

Respuesta:

```json
{
  "ok": true,
  "token": "TOKEN_TEMPORAL",
  "expiraEnSegundos": 43200,
  "usuario": {
    "id": "usuario-biofile",
    "nombre": "USUARIO BIOFILE",
    "usuario": "USUARIO BIOFILE"
  },
  "mensaje": "Hola USUARIO BIOFILE, estás conectado con BIOFILE."
}
```

Después del quinto intento incorrecto desde la misma conexión, el inicio de sesión se bloquea temporalmente durante 15 minutos.

### Consultar la sesión

```http
GET /api/auth/me
Authorization: Bearer TOKEN_TEMPORAL
```

Sirve para restaurar el saludo cuando el usuario vuelve a abrir o recarga el panel.

### Enviar paciente a BIOFILE

```http
POST /api/biofile/enviar
Content-Type: application/json
Authorization: Bearer TOKEN_TEMPORAL

{
  "documento": "52103281",
  "fila": 25,
  "subirImagenes": true
}
```

Enviar `fila` junto con `documento` activa la lectura rápida: la API consulta solamente el encabezado y la fila seleccionada, en vez de descargar toda la hoja. Si el frontend todavía no conoce la fila, puede enviar únicamente el documento y el comportamiento anterior se conserva.

La respuesta es `202 Accepted` y contiene `job.id`.

### Consultar el trabajo

```http
GET /api/biofile/trabajos/JOB_ID
Authorization: Bearer TOKEN_TEMPORAL
```

Estados posibles:

- `en_cola`
- `procesando`
- `completado`
- `error`

Un usuario con token solo puede consultar sus propios trabajos. La clave API heredada conserva acceso administrativo a todos los trabajos creados durante la ejecución actual.

## Configuración multiusuario en Render

Agrega estas variables en **Environment**:

- `SESSION_SECRET`: cadena aleatoria de 32 caracteres o más. Debe conservarse estable para que los tokens sigan siendo válidos después de un despliegue.
- `BIOFILE_USERS_JSON`: arreglo JSON con las cuentas autorizadas.
- `SESSION_TTL_MS`: duración de la sesión; `43200000` equivale a 12 horas.
- `ALLOWED_ORIGINS`: URLs públicas exactas de los frontends, separadas por coma.

Formato de `BIOFILE_USERS_JSON`:

```json
[
  {
    "id": "persona-uno",
    "nombre": "PERSONA UNO",
    "usuario": "USUARIO REAL EN BIOFILE",
    "contrasena": "CONTRASEÑA REAL EN BIOFILE"
  },
  {
    "id": "persona-dos",
    "nombre": "PERSONA DOS",
    "usuario": "OTRO USUARIO EN BIOFILE",
    "contrasena": "OTRA CONTRASEÑA EN BIOFILE"
  }
]
```

El JSON real se pega únicamente en Render. No reemplaces los ejemplos del repositorio con datos reales.

Como alternativa a la variable, se puede crear un Secret File con el JSON y configurar:

```env
BIOFILE_USERS_FILE=/etc/secrets/biofile-users.json
```

### Compatibilidad durante la migración

Estas variables pueden permanecer mientras se actualizan las páginas existentes:

- `API_KEY`
- `BIOFILE_USUARIO`
- `BIOFILE_CONTRASENA`

Las solicitudes antiguas siguen funcionando con:

```http
X-API-Key: TU_API_KEY
```

Después de que todos los frontends usen `/api/auth/login`, se puede retirar la clave compartida y las credenciales heredadas.

## Otras variables obligatorias

- `GOOGLE_SHEETS_URL`
- `GOOGLE_SHEETS_HOJA`, normalmente `Hoja 1`
- `GOOGLE_AUTH_MODE=service_account`
- `GOOGLE_SERVICE_ACCOUNT_FILE=/etc/secrets/google-service-account.json`
- `DEFAULT_LOCALIDAD`
- `DEFAULT_SEDE`
- `DEFAULT_TIPO_EVALUACION`

Revisa [.env.example](.env.example) para los valores opcionales.

## Cuenta de servicio de Google

En Render, dentro de **Environment → Secret Files**:

1. Crea un archivo secreto llamado `google-service-account.json`.
2. Pega el contenido completo del JSON de la cuenta de servicio.
3. Mantén `GOOGLE_SERVICE_ACCOUNT_FILE=/etc/secrets/google-service-account.json`.
4. Comparte el Google Sheet con el `client_email` del JSON y permiso **Editor**.

## Despliegue en Render

1. Crea o abre el Web Service conectado a este repositorio.
2. Usa el runtime `Docker`; Render detectará el `Dockerfile`.
3. Configura el Health Check Path como `/api/health`.
4. Agrega las variables y los Secret Files.
5. Despliega primero una rama de prueba y verifica `/api/health` antes de promoverla.

También se puede usar `render.yaml` como Blueprint.

No subas al repositorio:

- `.env`
- `.auth/`
- `credentials/*.json`
- `node_modules/`
- `logs/`
- `screenshots/`

## Integración recomendada del frontend

1. Mostrar campos de usuario y contraseña al pulsar **Conectar con BIOFILE**.
2. Enviar esas credenciales a `POST /api/auth/login`.
3. Guardar el token en `sessionStorage`, no la contraseña.
4. Mostrar `respuesta.mensaje` en el encabezado.
5. Enviar `Authorization: Bearer TOKEN` en las solicitudes posteriores.
6. Al cerrar sesión, borrar el token y el saludo del navegador.

Ejemplo mínimo:

```js
const respuesta = await fetch(`${API_URL}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ usuario, contrasena })
});

const datos = await respuesta.json();
if (!respuesta.ok) throw new Error(datos.error);

sessionStorage.setItem('biofile_token', datos.token);
encabezado.textContent = datos.mensaje;
```

Para enviar un paciente:

```js
const token = sessionStorage.getItem('biofile_token');

await fetch(`${API_URL}/api/biofile/enviar`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  },
  body: JSON.stringify({ documento, fila, subirImagenes: true })
});
```

## Pruebas

```bash
npm test
```

Las pruebas cubren autenticación, expiración y alteración de tokens, protección de contraseñas y conversión de fechas.

## Verificación de acceso

Conexión de escritura de GitHub verificada correctamente el 8 de agosto de 2026.
