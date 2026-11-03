# QR Salud — MVP online multiusuario

Esta primera versión toma como referencia el diseño, la marca, el perfil de emergencia y los módulos del HTML original. Sustituye el guardado `localStorage` y el PIN fijo de demostración por cuentas en servidor y PostgreSQL.

## Incluye
- Registro e inicio de sesión por nombre de usuario + PIN de 4–6 dígitos.
- PIN almacenado como hash bcrypt; bloqueo temporal/rate limit de intentos de acceso.
- Sesiones privadas con cookie HttpOnly, SameSite Strict y Secure en producción.
- Separación de perfiles, diagnósticos, medicamentos, registros de tomas y documentos por usuario.
- Carga privada de hasta 5 archivos JPG/PNG/PDF por solicitud (10 MB cada uno).
- Horarios de medicamentos y notificaciones del navegador **mientras QR Salud está abierto** y el permiso está concedido.
- Recomendaciones educativas básicas por palabras clave de diagnósticos, sin diagnóstico ni prescripción.
- Conserva una copia del prototipo original en `prototipo-original.html`.

## Requisitos
- Node.js 20 o superior.
- PostgreSQL 14 o superior.
- HTTPS en producción.

## Ejecutar localmente
1. Crea una base PostgreSQL vacía.
2. Ejecuta `schema.sql` en esa base.
3. Copia `.env.example` a `.env` y configura `DATABASE_URL`, `SESSION_SECRET` y `NODE_ENV`.
4. Instala dependencias: `npm install`.
5. Inicia: `npm start`.
6. Abre `http://localhost:3000`.

El servidor lee variables de entorno. Para desarrollo puedes usar `node --env-file=.env server.js` en Node 20.6+.

## Despliegue online
Despliega el servicio Node en un proveedor que permita HTTPS y almacenamiento persistente, y conecta una base PostgreSQL administrada. Configura las variables del `.env.example`. El directorio `private/uploads` debe montarse en un disco privado persistente o reemplazarse por almacenamiento de objetos privado. No publiques ese directorio como estático.

## Limitaciones explícitas de este MVP
- **No está desplegado ni tiene una URL pública**: requiere que el propietario configure el hosting, PostgreSQL, dominio y secretos.
- Las notificaciones son del navegador y funcionan cuando el sitio está abierto; no son push en segundo plano ni SMS/WhatsApp. Para eso se debe integrar Web Push (VAPID) y/o un proveedor de mensajería con consentimiento.
- El PIN de 4–6 dígitos es una credencial débil por sí sola. Se limita el ritmo de intentos y se usa bcrypt, pero antes de almacenar historiales reales se recomienda añadir segundo factor, recuperación segura de cuenta y auditoría de seguridad.
- Los archivos se guardan fuera del directorio público, pero este MVP no implementa cifrado de archivos en reposo, antivirus ni almacenamiento privado gestionado. Debe añadirse antes de producción.
- La extracción automática de texto de recetas/fotos (OCR/IA), QR público de emergencia y permisos para familiares/clínicas no están conectados en esta fase. El QR público se pospone deliberadamente para diseñar consentimiento y minimizar exposición de datos sensibles.
- Las recomendaciones son reglas informativas muy básicas, no recomendaciones clínicas personalizadas.
- No se ha realizado auditoría de seguridad ni revisión legal. Antes del uso real, revisar la Ley peruana 29733 y su reglamento vigente, consentimiento, política de privacidad, retención, derechos ARCO y contratos con proveedores.

## Datos médicos
Usa únicamente datos ficticios en pruebas. No cargues historiales, recetas ni boletas reales hasta completar revisión técnica, seguridad, privacidad y validación legal.


## Actualización: QR personal y aplicación instalable (PWA)

Esta versión incorpora:
- Instalación desde el navegador mediante el manifiesto PWA y el service worker.
- Íconos de aplicación para 192 y 512 px.
- Menú **Mi código QR** con descarga del código personal.
- Página pública `/emergency/:token` que no requiere iniciar sesión y muestra únicamente los campos seleccionados y autorizados en **Mi perfil**.
- El QR permanece desactivado hasta que el usuario marque expresamente la autorización.

### Publicación en Render
1. Reemplaza los archivos del repositorio con el contenido de esta carpeta y haz commit/push a la rama conectada a Render.
2. Render instalará la dependencia `qrcode` durante el despliegue. No se requiere modificar `schema.sql` ni ejecutar una migración SQL adicional.
3. Espera a que el servicio aparezca como **Live**.
4. Entra a QR Salud, abre **Mi perfil**, selecciona qué datos deseas compartir y activa la casilla de autorización. Guarda.
5. Abre **Mi código QR** para ver o descargar el QR. Escanéalo con otro teléfono para comprobar la página pública.

**Privacidad y límites:** el QR es un enlace público con un token aleatorio; cualquier persona que tenga el QR/enlace puede ver los campos autorizados. No incluyas datos médicos reales en esta demo. El almacenamiento de archivos sigue dependiendo del disco del servicio; en Render Free los archivos locales pueden no ser persistentes entre despliegues/reinicios. La PWA guarda solo la carcasa de la aplicación; no almacena en caché respuestas privadas de la API. Para producción se requiere revisión de seguridad, privacidad, consentimiento, respaldo y almacenamiento persistente.
