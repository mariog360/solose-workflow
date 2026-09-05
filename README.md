# Workflow Casita Solosé

Tablero privado de **Mario × Fer Piña** para llevar el control de la construcción de la app
del torneo de Casita Solosé. No es la app del torneo: es la herramienta interna de los dos.

Seis listas en una sola vista: **Acuerdos** (con fecha) · **To-do's** (con responsable) ·
**En curso** · **Completadas** · **Notas** · **Largo plazo**.

---

## Puesta en marcha — 20 minutos, una sola vez

### 1. Crear el proyecto de Supabase

1. Entra a <https://supabase.com> y crea una cuenta (con `mariog36@gmail.com`).
2. **New project** → nombre `casita-solose-workflow`, región **East US (North Virginia)**
   (la más cercana con menos latencia desde CDMX), y guarda la contraseña de la base en tu
   gestor de contraseñas — no la vas a necesitar para esto, pero sí para la app del torneo.
3. Espera a que termine de aprovisionar (~2 min).

### 2. Correr el esquema

1. En el menú lateral: **SQL Editor** → **New query**.
2. Abre `supabase/schema.sql` de esta carpeta, copia **todo** el contenido, pégalo y dale **Run**.
3. Debe decir *Success. No rows returned*. Eso ya creó las tablas, las políticas de seguridad,
   la lista de correos con `mariog36@gmail.com` y `solosefc@gmail.com`, el candado de registro
   y el realtime.

### 3. Configurar el acceso por correo

En **Authentication → Sign In / Providers → Email**:

- **Enable Email provider**: ON
- **Confirm email**: ON
- **Enable email signups**: ON  ← déjalo prendido; el candado de la base es el que filtra
- **Secure email change**: ON

En **Authentication → URL Configuration**:

- **Site URL**: la URL de Vercel (paso 5). Al principio pon `http://localhost:3000`.
- **Redirect URLs**: agrega la URL de Vercel y `http://localhost:3000/**`.

> **Sobre los correos:** el SMTP incluido de Supabase está limitado (unos pocos correos por
> hora) y es solo para pruebas. Para dos personas alcanza. Para la app del torneo hay que
> conectar un SMTP propio — ver `DECISIONES-TECNICAS.md`.

### 4. Pegar las credenciales

En **Project Settings → API** copia:

- **Project URL** → `https://xxxxxxxx.supabase.co`
- **anon public** key → `eyJhbGciOi...`

Ábrelas en `config.js` y pégalas ahí:

```js
window.SOLOSE_CONFIG = {
  url: "https://xxxxxxxx.supabase.co",
  anonKey: "eyJhbGciOi..."
};
```

La `anon key` es pública por diseño: sin estar en la lista de correos no da acceso a nada.

> Si no quieres tocar el archivo, la app también acepta las credenciales desde la propia
> pantalla de configuración y las guarda en ese navegador. Para el despliegue conviene
> dejarlas en `config.js`.

### 5. Desplegar en Vercel

**Opción A — línea de comandos (la más rápida):**

```bash
cd "C:\Users\mariog\Documents\Solose\workflow-casita-solose"
npx vercel        # primera vez: te pide login y confirmaciones, di que sí a todo
npx vercel --prod # publica
```

**Opción B — GitHub (mejor si vas a seguir cambiándolo):**

1. Crea un repo privado en GitHub y sube esta carpeta.
2. En <https://vercel.com/new> importa el repo.
3. Framework preset: **Other**. Build command: vacío. Output directory: vacío.
4. **Deploy**.

Vercel te da una URL tipo `https://workflow-casita-solose.vercel.app`.

### 6. Cerrar el círculo

Vuelve a Supabase → **Authentication → URL Configuration** y pon esa URL de Vercel como
**Site URL** y en **Redirect URLs**. Sin esto, el link del correo no regresa al tablero.

### 7. Probar

1. Abre la URL, escribe tu correo, dale **Enviarme el link**.
2. Abre el correo **desde el mismo teléfono o compu** y toca el link.
3. Manda la URL a Fer por WhatsApp. Ella hace lo mismo con `solosefc@gmail.com`.

---

## Agregarlo a la pantalla de inicio

**iPhone (Safari):** abre la URL → botón Compartir → *Añadir a pantalla de inicio*.
**Android (Chrome):** abre la URL → menú ⋮ → *Instalar app* o *Añadir a pantalla principal*.

Se abre a pantalla completa, sin barra del navegador. La sesión queda guardada: no hay que
volver a pedir el link cada vez.

---

## Uso diario

- **Agregar**: escribe en la caja de cada sección y Enter (Shift+Enter para salto de línea).
- **Completar**: un clic en la casilla. La tarea se va a *Completadas*.
- **Reabrir**: un clic en la palomita verde. Regresa a la sección de donde salió.
- **Editar / borrar**: los iconos a la derecha. El borrado pide confirmación en dos toques.
- **Promover una idea de largo plazo**: la flecha `→` la pasa a *En curso*.
- **Colapsar secciones**: toca el título. *Completadas* arranca cerrada.
- Lo que agrega uno le aparece al otro **sin recargar**.

## Cambiar o agregar correos

Icono de engrane (arriba a la derecha) → **Quién puede entrar**.

- Agrega el correo personal de Fer si prefiere ese en lugar de `solosefc@gmail.com`.
- Puedes quitar cualquier correo menos el tuyo (para que nadie se quede fuera por accidente).
- Un correo que no esté en esa lista **no puede ni crear cuenta**, aunque tenga el link.
- Si quitas un correo que ya había entrado alguna vez, deja de ver los datos al instante
  (lo bloquea RLS), pero su cuenta sigue existiendo. Para borrarla del todo:
  Supabase → **Authentication → Users** → borrar ese usuario.

---

## Si algo falla

| Síntoma | Causa casi siempre |
|---|---|
| *"Ese correo no está en la lista"* al pedir el link | El correo no está en **Quién puede entrar**. Agrégalo desde el tablero con la cuenta que sí entra. |
| El link del correo abre y regresa al login | La URL de Vercel no está en **Redirect URLs** de Supabase. |
| Entra pero dice *"Sin acceso"* | Falta correr `supabase/schema.sql`, o se corrió a medias. Vuelve a correrlo completo. |
| No llega el correo | Límite del SMTP de prueba de Supabase. Espera ~1 h o conecta SMTP propio. |
| Cambié el código y el móvil sigue viejo | El service worker cachea. Cierra la app de la pantalla de inicio y vuelve a abrirla, o sube el número de versión en `sw.js` (`solose-workflow-v1` → `v2`). |

---

## Estructura

```
workflow-casita-solose/
├─ index.html              las tres pantallas: config, login, tablero
├─ styles.css              identidad visual Casita Solosé
├─ app.js                  toda la lógica (ES module, sin build step)
├─ config.js               credenciales públicas de Supabase  ← editar
├─ manifest.webmanifest    PWA: instalable en pantalla de inicio
├─ sw.js                   service worker (shell offline, datos siempre en red)
├─ vercel.json             headers y no-index
├─ icons/                  iconos de la app
├─ supabase/schema.sql     tablas + RLS + candado de registro + realtime
└─ DECISIONES-TECNICAS.md  lo reutilizable para la app del torneo
```
