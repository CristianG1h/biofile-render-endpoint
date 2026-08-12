# BIOFILE Robot API para Render

Backend de **VIP Salud Ocupacional** para automatizar el ingreso de pacientes a BIOFILE a partir de Google Sheets. Está desarrollado en **Node.js + Playwright**, se ejecuta en Render y trabaja junto con el repositorio `panel-gestion-biofile-vip`.

> **Documentación actualizada: 12 de agosto de 2026.**

## Qué hace actualmente

- Recibe uno o varios pacientes seleccionados desde el panel web.
- Inicia sesión en BIOFILE con el usuario que está trabajando.
- Procesa cada paciente mediante Playwright y registra la orden en BIOFILE.
- Mantiene **colas independientes por usuario**, permitiendo trabajo simultáneo sin compartir una misma sesión.
- Reutiliza el `storageState` de cada usuario para reducir logins repetidos.
- Evita que el mismo documento quede procesándose dos veces al mismo tiempo.
- Actualiza Google Sheets con estado, fecha, usuario responsable, modo de ingreso y trazabilidad.
- Permite ingreso automático, ingreso manual, edición de datos y envío a eliminados.
- Informa al panel el **estado del trabajo, etapa actual, porcentaje de progreso y número de OS** cuando BIOFILE lo entrega.
- Genera estadísticas operativas por usuario.
- Incluye administración de usuarios, roles y auditoría para superadministradores.
- Normaliza documentos y teléfonos para evitar diferencias por puntos, guiones, espacios o sufijos `.0` provenientes de Sheets.
- Maneja ciudades y países de nacimiento con equivalencias y capitales de respaldo.

## Arquitectura multiusuario

```text
Panel Netlify
     │
     │ HTTPS + Bearer token
     ▼
BIOFILE Robot API - Render
     │
     ├── Autenticación y roles
     ├── Cola CRISTIAN ──► sesión Playwright propia ──► BIOFILE
     ├── Cola AURA ──────► sesión Playwright propia ──► BIOFILE
     ├── Cola OTRO ──────► sesión Playwright propia ──► BIOFILE
     │
     ├── Google Sheets: registros y trazabilidad
     └── Google Sheets: usuarios administrados y auditoría
```

Los navegadores no permanecen abiertos permanentemente. Se crean cuando existe trabajo y reutilizan el estado de sesión correspondiente a cada usuario.

## Roles y permisos

El sistema maneja tres niveles:

| Rol | Alcance |
|---|---|
| `user` | Buscar pacientes, editar datos permitidos, enviar a BIOFILE y realizar ingresos manuales. |
| `admin` | Incluye las funciones operativas y acceso al dashboard/estadísticas administrativas. |
| `superadmin` | Incluye administración de usuarios, roles, activación/desactivación y consulta de auditoría. |

Los usuarios creados desde el panel pueden tener rol `user` o `admin`. Los **`superadmin` se definen únicamente desde las variables seguras de Render**, evitando que un usuario pueda elevarse a superadministrador desde la interfaz.

## Gestión segura de usuarios

La versión actual ya no requiere guardar todos los usuarios directamente en Render.

- El superadministrador permanece configurado en Render.
- Los usuarios administrados se almacenan en hojas de Google Sheets.
- Las contraseñas tienen hash para validación y una copia cifrada para que el robot pueda iniciar sesión en BIOFILE cuando corresponda.
- La clave maestra se mantiene únicamente en Render mediante `BIOFILE_ENCRYPTION_KEY` y debe tener al menos 32 caracteres.
- Las contraseñas y claves privadas **nunca deben subirse a GitHub**.
- Al desactivar un usuario administrado, sus sesiones activas dejan de ser válidas.

La hoja de usuarios utiliza campos equivalentes a:

```text
ID
USUARIO
PASSWORD_HASH
PASSWORD_ENC
ROL
ACTIVO
CREADO_POR
CREADO_EN
ACTUALIZADO_POR
ACTUALIZADO_EN
```

La auditoría registra:

```text
FECHA
ACTOR
ACCION
USUARIO_OBJETIVO
DETALLE
```

## Endpoints principales

| Método | Endpoint | Uso |
|---|---|---|
| `POST` | `/api/auth/login` | Iniciar sesión y obtener token temporal. |
| `GET` | `/api/auth/me` | Consultar la sesión actual. |
| `POST` | `/api/auth/logout` | Cerrar la sesión del panel. |
| `POST` | `/api/biofile/enviar` | Crear un trabajo para ingresar un paciente. |
| `GET` | `/api/biofile/trabajos/:id` | Consultar estado, progreso y resultado del trabajo. |
| `PATCH` | `/api/registros/actualizar` | Actualizar un campo permitido del paciente en Sheets. |
| `POST` | `/api/registros/marcar-manual` | Registrar un ingreso realizado manualmente. |
| `GET` | `/api/admin/estadisticas` | Estadísticas para `admin` y `superadmin`. |
| `GET` | `/api/superadmin/usuarios` | Listar usuarios administrados. |
| `POST` | `/api/superadmin/usuarios` | Crear un usuario `user` o `admin`. |
| `PATCH` | `/api/superadmin/usuarios/:id` | Modificar usuario, rol, contraseña o estado. |
| `GET` | `/api/superadmin/auditoria` | Consultar acciones administrativas y operativas auditadas. |
| `GET` | `/api/health` | Health check utilizado por Render. |

La API también conserva compatibilidad temporal con integraciones antiguas que usaban API key, pero el panel actual trabaja con sesiones Bearer.

## Progreso detallado de trabajos

El backend instrumenta cada trabajo para que el panel pueda mostrar más que `procesando/completado`.

Actualmente puede entregar:

- etapa del proceso;
- porcentaje aproximado;
- estado de cola;
- usuario que lo está procesando;
- errores detectados;
- número de **OS** generado en BIOFILE, cuando está disponible.

Esto permite identificar si el robot está iniciando sesión, llenando datos, cargando imágenes, guardando o finalizando la orden.

## Google Sheets y columnas de control

El servicio trabaja con `GOOGLE_AUTH_MODE=service_account` y la cuenta de servicio necesita permisos de **Editor** sobre el archivo.

El sistema valida y amplía automáticamente la cuadrícula de la hoja cuando necesita más columnas, evitando fallos por escribir fuera del rango disponible.

Entre las columnas de trazabilidad utilizadas actualmente están:

```text
FECHA_BIOFILE_ISO
USUARIO_BIOFILE
MODO_INGRESO_BIOFILE
REGISTRADO_POR_BIOFILE
ELIMINADO_POR
FECHA_ELIMINADO_ISO
MOTIVO_ELIMINADO
```

### Ingreso manual

Cuando una persona registra manualmente un paciente:

- se identifica quién ejecutó la acción;
- puede quedar atribuido el responsable real del ingreso;
- se conserva el modo de ingreso;
- la acción se agrega a la auditoría;
- si `Estrato` está vacío, se utiliza y guarda `1` antes de continuar cuando corresponde.

### Eliminados

Los registros enviados a eliminados conservan usuario, fecha y motivo. Además:

- la acción se audita;
- los eliminados no se contabilizan como producción normal en las estadísticas operativas;
- el panel puede diferenciarlos de pacientes pendientes o ingresados.

## Ciudades y países de nacimiento

La selección de lugar de nacimiento fue reforzada para los valores que llegan desde Google Sheets.

El robot:

1. separa municipio, departamento y país cuando están disponibles;
2. normaliza tildes, variantes y nombres equivalentes;
3. busca la opción correcta en el autocompletado de BIOFILE;
4. contempla equivalencias conocidas de municipios;
5. para Colombia puede utilizar la capital del departamento como respaldo cuando BIOFILE no expone el municipio esperado;
6. para otros países puede utilizar la capital del país como alternativa controlada;
7. valida el valor seleccionado antes de continuar.

La tabla de países/capitales fue ampliada para cubrir los países manejados por el formulario de brigadas.

## Colas y concurrencia

- Los trabajos de **un mismo usuario** se ejecutan en serie.
- Los trabajos de **usuarios diferentes** pueden ejecutarse simultáneamente.
- Cada usuario conserva su propio estado de sesión BIOFILE.
- Existe un bloqueo adicional por documento para evitar crear dos órdenes simultáneas para la misma persona.

## Variables sensibles

Mantener únicamente en Render o en un entorno local seguro:

```env
BIOFILE_ENCRYPTION_KEY=...
GOOGLE_SERVICE_ACCOUNT_JSON=...

BIOFILE_USER_<SUFIJO>=...
BIOFILE_PASSWORD_<SUFIJO>=...
BIOFILE_ROLE_<SUFIJO>=superadmin
```

También deben conservarse las variables de Google Sheets, configuración `DEFAULT_*`, URLs permitidas y cualquier credencial utilizada por BIOFILE.

No publicar archivos JSON de cuentas de servicio, contraseñas ni tokens en este repositorio.

## Ejecución

El proyecto requiere **Node.js >= 20.10** y actualmente usa Playwright `1.61.1`.

```bash
npm install
npm start
```

El `start` actual aplica los parches operativos necesarios, valida la sintaxis de los archivos principales y después inicia `src/server.js`.

Comandos adicionales disponibles:

```bash
npm run dev
npm run diagnostico
npm run probar-hoja
npm run test:fechas
```

## Despliegue en Render

El servicio se despliega con Docker/Render y utiliza:

```text
Health check: /api/health
Rama: main
```

Después de modificar variables de entorno, guardar los cambios y desplegar el último commit de `main`.

## Cambios recientes consolidados

### 11–12 de agosto de 2026

- Arquitectura multiusuario con colas y sesiones independientes.
- Usuarios administrados desde el panel y almacenados de forma protegida en Sheets.
- Roles `user`, `admin` y `superadmin`.
- Panel de auditoría y registro de acciones administrativas.
- Auditoría de ingresos manuales y envíos a eliminados.
- Atribución del responsable real del ingreso.
- Exclusión de eliminados de las estadísticas operativas.
- Progreso detallado con etapas, porcentaje y número de OS.
- Manejo reforzado de municipios, países, equivalencias y capitales.
- Ampliación automática de columnas/cuadrícula de Google Sheets.
- Mejor normalización de documentos y números provenientes de Sheets.

---

**VIP Salud Ocupacional — Automatización BIOFILE**
