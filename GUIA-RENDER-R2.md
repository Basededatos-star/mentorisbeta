# Mentoris: publicar en Render + guardar en Cloudflare R2

Tiempo aproximado: 30–40 minutos la primera vez. Todo se puede hacer desde el navegador.

## Cómo funciona (en 3 líneas)
- **Render** ejecuta el servidor (`server.js`) y entrega la app a los teléfonos.
- **Cloudflare R2** guarda lo que no se puede perder: la base de datos (`db/db.json`), una copia diaria (`db/backups/`, últimas 14), los archivos subidos (`files/`) y el ícono de la app (`icons/`).
- Render (plan gratis) **borra su disco** en cada reinicio o redeploy; por eso todo va a R2.

---

## PARTE 1 — Cloudflare R2 (almacenamiento)

1. Entra a https://dash.cloudflare.com y crea una cuenta gratis (o inicia sesión).
2. En el menú izquierdo abre **R2 Object Storage** (puede estar dentro de "Storage & databases"). Si es tu primera vez, te pedirá activar R2; puede pedirte una tarjeta, pero no cobra mientras estés dentro del uso gratis (10 GB, 1 millón de escrituras y 10 millones de lecturas al mes).
3. **Anota tu Account ID**: aparece en la página de R2 (a la derecha, "Account ID") o en la URL `dash.cloudflare.com/<ESTE_ES_TU_ACCOUNT_ID>/...`. → será `R2_ACCOUNT_ID`.
4. Pulsa **Create bucket**:
   - Nombre: `mentoris-datos` (minúsculas, sin espacios). → será `R2_BUCKET`.
   - Ubicación: *Automatic*. Déjalo **privado** (no actives acceso público ni dominio público: los archivos se sirven a través de Mentoris, solo a usuarios con sesión).
5. Crea las claves de acceso: en la página de R2 busca **Manage API tokens** (o "API" → "Manage") → **Create API token**:
   - Permisos: **Object Read & Write**.
   - Alcance: **solo el bucket `mentoris-datos`** (Apply to specific buckets only).
   - Pulsa **Create API Token**.
6. La pantalla siguiente muestra **Access Key ID** y **Secret Access Key**. **Cópialos ahora** (el secreto no se vuelve a mostrar). → serán `R2_ACCESS_KEY_ID` y `R2_SECRET_ACCESS_KEY`. No uses el "Token value" largo ni la URL del endpoint: Mentoris arma el endpoint solo con tu Account ID.

Ya tienes 4 datos: `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.

---

## PARTE 2 — Subir el código a GitHub

Render toma el código desde GitHub.

1. Crea cuenta en https://github.com → **New repository** → nombre `mentoris` → **Private** → *Create repository*.
2. Descomprime `mentoris.zip` en tu computadora.
3. En el repositorio nuevo pulsa **uploading an existing file**.
4. Arrastra **el contenido** de la carpeta `mentoris` (los archivos `server.js`, `package.json`, `render.yaml`… y las carpetas `public` y `lib`). Importante: que en GitHub se vea `server.js` en la raíz, no una carpeta `mentoris` dentro.
5. Escribe un mensaje (ej. "Mentoris") → **Commit changes**.

> No subas un archivo `.env` ni las claves de R2 a GitHub. Las claves se escriben solo en Render (Parte 3).

---

## PARTE 3 — Crear el servicio en Render

1. Entra a https://render.com y crea cuenta (puedes usar tu GitHub).
2. **New +** → **Web Service** → conecta GitHub y elige el repositorio `mentoris`.
3. Configura:
   | Campo | Valor |
   |---|---|
   | Name | `mentoris` (tu dirección será `mentoris.onrender.com`; si está ocupada, Render sugiere otra) |
   | Region | la más cercana a Guatemala: **Ohio** o **Virginia** (US East) |
   | Branch | `main` |
   | Runtime / Language | **Node** |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | **Free** para probar · **Starter** para uso real (ver nota abajo) |
4. Abre **Advanced** → **Health Check Path**: `/healthz`
5. En **Environment Variables** agrega (botón *Add Environment Variable*):
   | Key | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `NODE_VERSION` | `22` |
   | `SESSION_SECRET` | un texto largo al azar (mínimo 16 caracteres; ej. 40 letras y números mezclados). No lo compartas. |
   | `R2_ACCOUNT_ID` | el de la Parte 1 |
   | `R2_BUCKET` | `mentoris-datos` |
   | `R2_ACCESS_KEY_ID` | el de la Parte 1 |
   | `R2_SECRET_ACCESS_KEY` | el de la Parte 1 |
6. Pulsa **Create Web Service**. Render construye y arranca (1–3 min).
7. En **Logs** deben aparecer estas líneas:
   ```
   Almacenamiento: Cloudflare R2
   Base de datos nueva (primer arranque).
   Mentoris escuchando en el puerto ...
   ```
   Si dice `carpeta local ./data (sin R2)` → falta alguna variable `R2_*` o está mal escrita.
   Si aparece `No se pudo leer la base de datos del almacenamiento` → revisa Account ID, nombre del bucket y las claves (y que el token tenga *Object Read & Write* sobre ese bucket). El servidor se detiene a propósito para no trabajar sin guardar.
8. Abre `https://TU-NOMBRE.onrender.com/healthz`: debe mostrar `{"ok":true,"storage":"r2"}`.

---

## PARTE 4 — Primer uso

1. Abre `https://TU-NOMBRE.onrender.com`. La primera vez pide crear la cuenta del **administrador** (nombre del colegio, usuario y contraseña).
2. **Si tenías datos de la versión anterior**: en esa pantalla abre *"Ya tengo un respaldo (.json)"* y sube el archivo que exportaste con **Diseño → Exportar respaldo** en la versión vieja. Se copian usuarios, cursos, tareas y archivos, y entras con tu usuario de siempre. (Hazlo antes de crear el administrador nuevo.)
3. **Diseño → Ícono de la app instalada**: sube la imagen que quieras para el ícono (cuadrada, ideal 512×512). La app instalada se llama **Mentoris**.
4. Prueba subir una foto en una tarea: se comprime antes de subir y se guarda en R2 (puedes verla en Cloudflare → R2 → tu bucket → carpeta `files/`).

### Instalar en el teléfono
- **Android (Chrome)**: menú ⋮ → *Instalar app* / *Agregar a pantalla principal*.
- **iPhone (Safari)**: botón Compartir → *Agregar a pantalla de inicio*.
- Si cambias el ícono después, en teléfonos que ya la instalaron puede tardar o hay que desinstalar y volver a instalar.

---

## Qué cambió en esta versión
1. **Sesión**: ya no se cierra por inactividad. Dura 90 días en cada dispositivo (hasta que pulses *Salir*), y al reabrir la app vuelve a la última pantalla.
2. **Botón "atrás"**: en el teléfono y en el navegador regresa a la pantalla anterior (y cierra ventanas emergentes) en vez de salir. Además hay una flecha ← arriba y los botones "Volver" usan el mismo historial.
3. **Compresión**: las fotos se reducen en el teléfono antes de subir (máx. 1600 px, JPG; una foto de 5–8 MB queda en unos 300–600 KB). PDF, Word, texto, etc. se comprimen en el servidor cuando ayuda. Los archivos que se reemplazan o eliminan se borran de R2 automáticamente (limpieza cada 6 h, con 24 h de margen).
4. **Horarios por día** en los cursos: cada día marcado tiene su propia hora (lunes 8:00, jueves 10:00…). Se valida contra el horario del grado, los recreos y choques con otros cursos o del maestro. Los cursos anteriores se convierten solos.
5. **Ícono y nombre de la app instalada**: se llama Mentoris y el ícono lo sube el administrador (independiente del logo del colegio).

## Cosas que cambian por tener servidor
- Los datos ahora son **compartidos**: todos los dispositivos ven lo mismo (se actualiza solo cada ~12 s).
- Las contraseñas se verifican en el servidor; los dispositivos nunca reciben las contraseñas de otros.
- Alumnos y padres solo reciben sus propios datos (entregas, notas, asistencia, mensajes).
- El servidor hace una **copia diaria** (últimas 14) en `db/backups/` dentro de R2.
- Las notificaciones de "nueva tarea" las genera el servidor.

## Límites que debes conocer
- **Render gratis se duerme** tras 15 min sin visitas y tarda ~1 min en despertar; además puede reiniciarse en cualquier momento. Para uso diario con alumnos, usa un plan de pago (Starter). Los datos no se pierden, están en R2.
- **Una sola instancia**: no aumentes el número de instancias (la base de datos se mantiene en memoria y se guarda en R2).
- **Exámenes**: la calificación automática sigue ocurriendo en el navegador del alumno; un alumno técnico podría ver las respuestas correctas con las herramientas del navegador. Para exámenes de alto impacto, el siguiente paso es calificar en el servidor.
- **Notificaciones**: aparecen mientras la app está abierta o en segundo plano reciente; no hay notificaciones "push" con la app cerrada.
- Los maestros ven los datos de contacto de los usuarios (igual que antes).

## Uso en tu computadora (opcional)
```
node server.js        # abre http://localhost:3000 ; guarda en la carpeta ./data (sin R2)
```
Requiere Node 18 o superior. Sin variables `R2_*` usa la carpeta local `data/`.

## Costos aproximados
- R2: gratis hasta 10 GB, 1 M de escrituras y 10 M de lecturas al mes; la salida de datos es gratis. Luego ~US$0.015 por GB al mes.
- Render: plan Free sin costo (con las limitaciones de arriba); Starter es de pago mensual (revisa el precio vigente en render.com/pricing).
