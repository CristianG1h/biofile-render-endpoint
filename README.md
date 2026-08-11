# BIOFILE Robot API para Render

Servicio Node.js + Playwright que recibe un paciente específico, lo ingresa en BIOFILE y actualiza Google Sheets.

## Arquitectura multiusuario

El panel ya no comparte una sola clave/API para trabajar con BIOFILE. Cada persona inicia sesión con su propio usuario de BIOFILE y el endpoint valida esas credenciales contra variables de entorno de Render.

Cada usuario tiene:

- su propia cola serial de trabajos;
- su propio `storageState` de Playwright;
- su propia sesión BIOFILE;
- trazabilidad en Google Sheets mediante `USUARIO_BIOFILE`;
- posibilidad de trabajar al mismo tiempo que otros usuarios sobre pacientes diferentes.

No se mantienen cuatro navegadores abiertos permanentemente. El navegador se abre cuando hay un trabajo y reutiliza el estado de sesión del usuario, reduciendo consumo cuando no hay actividad.

## Variables de entorno multiusuario

Use un sufijo estable para cada persona:

```env
BIOFILE_USER_CRISTIAN=USUARIO BIOFILE
BIOFILE_PASSWORD_CRISTIAN=CONTRASENA BIOFILE
BIOFILE_ROLE_CRISTIAN=admin

BIOFILE_USER_AURA=USUARIO BIOFILE
BIOFILE_PASSWORD_AURA=CONTRASENA BIOFILE

BIOFILE_USER_LUISA_RIOS=USUARIO BIOFILE
BIOFILE_PASSWORD_LUISA_RIOS=CONTRASENA BIOFILE

BIOFILE_USER_LUISA_BENAVIDES=USUARIO BIOFILE
BIOFILE_PASSWORD_LUISA_BENAVIDES=CONTRASENA BIOFILE
```

Las contraseñas deben existir únicamente en Render; nunca en GitHub ni en el HTML del panel.

`BIOFILE_USUARIO`, `BIOFILE_CONTRASENA` y `API_KEY` se conservan temporalmente por compatibilidad con herramientas anteriores. El panel v3 usa sesiones Bearer y no solicita la API key al usuario.

## Endpoints principales

```text
POST  /api/auth/login
GET   /api/auth/me
POST  /api/auth/logout
POST  /api/biofile/enviar
GET   /api/biofile/trabajos/:id
PATCH /api/registros/actualizar
POST  /api/registros/marcar-manual
GET   /api/admin/estadisticas
GET   /api/health
```

`/api/admin/estadisticas` requiere un usuario con rol `admin`.

## Google Sheets

El servicio usa `GOOGLE_AUTH_MODE=service_account` y necesita permisos de Editor sobre la hoja. Además de las columnas de control anteriores, agrega automáticamente cuando falten:

```text
FECHA_BIOFILE_ISO
USUARIO_BIOFILE
MODO_INGRESO_BIOFILE
```

Las correcciones realizadas desde el lápiz del ingreso manual se escriben directamente en la fila del paciente. Si `Estrato` está vacío, el sistema usa y guarda `1` antes de enviar a BIOFILE.

## Colas

Los trabajos del mismo usuario se ejecutan uno detrás de otro. Las colas de usuarios diferentes son independientes, por lo que dos o más usuarios pueden procesar pacientes distintos simultáneamente. Existe protección adicional para impedir que el mismo documento quede activo dos veces al mismo tiempo.

## Despliegue

Render ejecuta el servicio con Docker y usa `/api/health` como health check. Mantenga también las variables de Google Sheets y los valores `DEFAULT_*` que ya estaban configurados.

Después de modificar variables de entorno, guarde los cambios y despliegue el último commit de `main`.
