# Decisiones técnicas — qué reusar en la app del torneo

Este tablero fue el calentamiento. Esto es lo que aprendimos y lo que **sí** se transfiere
a la app de Casita Solosé (v1), y lo que **no**.

---

## 1. Estructura del proyecto

**Aquí:** sitio estático puro — cuatro archivos, cero dependencias, cero build step. Se
despliega copiando la carpeta. Es lo correcto para un tablero de dos personas: nada que
compilar significa nada que se rompa en el deploy.

**En la app del torneo: no repetir esto.** La app tiene vista pública (calendario, tabla de
posiciones, reglamento) que necesita **SEO y carga rápida en móvil con datos**, y eso pide
renderizado en servidor. Ahí va **Next.js (App Router) en Vercel**:

```
app/
├─ (publico)/          renderizado en servidor, sin login
│  ├─ calendario/
│  ├─ posiciones/
│  └─ reglamento/
├─ admin/              protegido, cliente + server actions
└─ api/
lib/supabase/
├─ client.ts           createBrowserClient  (componentes cliente)
└─ server.ts           createServerClient   (server components y actions)
```

La librería es `@supabase/ssr`, no el `createClient` plano que usamos aquí. Lo que sí se
copia tal cual del tablero: el esquema SQL, el patrón de RLS y el manejo de realtime.

## 2. Autenticación

**Lo que funcionó:**

- **Magic link (OTP por correo)**: cero contraseñas que recordar, cero flujo de "olvidé mi
  contraseña", cero soporte. Para Fer fue un correo y un toque.
- **`flowType: 'implicit'`, no `'pkce'`.** PKCE guarda un verificador en el navegador que
  pidió el link, así que si el correo se abre en otro navegador del mismo teléfono (Gmail
  en iOS hace justo eso) el login falla. Implicit aguanta ese caso. El token viaja en el
  fragmento de la URL y se limpia de inmediato con `history.replaceState`.
- **Restricción por allowlist en la base, no en el frontend.** Tres capas, y las tres
  importan:
  1. **Trigger `BEFORE INSERT` en `auth.users`** que lanza excepción si el correo no está
     en `allowed_emails`. La cuenta ni siquiera se crea.
  2. **RLS en cada tabla** con `using (public.is_member())`. Aunque alguien se colara, no
     ve una sola fila.
  3. UI que explica el rechazo en español.

  Nunca depender solo de la capa 1: un cambio de configuración en el dashboard la puede
  desactivar sin avisar.
- **`is_member()` como `security definer`.** Sin esto la política de `allowed_emails` se
  consulta a sí misma y Postgres tira recursión infinita. Es el error clásico y cuesta una
  hora encontrarlo.
- **La `anon key` es pública.** Va en el bundle del cliente sin problema. Lo que protege es
  RLS. La `service_role` key **nunca** toca el navegador.

**Para la app del torneo:**

- La vista pública **no lleva auth**: son `select` anónimos con una política
  `for select to anon using (publicado = true)`. Nada de login para ver el calendario.
- El panel de admin sí usa magic link igual que aquí, con `allowed_emails` como tabla de
  administradores (agregando una columna `rol`).
- **Conectar SMTP propio desde el día uno.** El SMTP incluido de Supabase está limitado a
  unos pocos correos por hora y es explícitamente "solo para desarrollo". Resend tiene capa
  gratuita de 3,000 correos/mes y se conecta en Authentication → Emails → SMTP Settings.
- Personalizar la plantilla del correo con la identidad de Casita Solosé (Authentication →
  Emails → Templates). El correo es el primer contacto y el default de Supabase se ve a
  plantilla genérica.

## 3. Base de datos

**Patrones que se copian:**

- `updated_at` por trigger, nunca desde el cliente.
- Estado como columna `text` con `check (... in (...))`, **no como `enum`**. Agregar un
  valor a un enum en Postgres es un `ALTER TYPE` que no se puede hacer dentro de una
  transacción con otras cosas; cambiar un `check` es un `ALTER TABLE` normal. Vamos a
  querer agregar estados a los partidos.
- `security definer` + `set search_path = public` en toda función que se salte RLS. El
  `search_path` no es opcional: sin él es un hoyo de seguridad.
- Todo el esquema en **un archivo `.sql` idempotente** (`if not exists`, `drop policy if
  exists`, `on conflict do nothing`). Se puede volver a correr sin miedo.

**Lo que ya está acordado y hay que respetar desde la primera migración** (viene del
documento de acuerdo con Fer): **`torneo_id` y `ubicacion`/`cancha` en las tablas desde el
día uno**, aunque el piloto sea un solo torneo en una sola cancha. Agregar esas columnas
después obliga a rehacer todas las consultas y todas las políticas.

Para la app del torneo, además: usar **migraciones versionadas** con el CLI de Supabase
(`supabase migration new ...`) en vez de un solo archivo. Con tabla de posiciones y
desempates el esquema va a cambiar varias veces y hay que poder volver atrás.

## 4. Realtime

Se suscribe a `postgres_changes` en la tabla y **al recibir cualquier evento se recarga la
consulta completa**, en vez de aplicar el cambio a mano sobre el estado local.

Con volúmenes chicos esto es correcto: es imposible que el estado se desincronice, y el
código es una décima parte. Para la app del torneo aplica igual en el panel de admin. En la
vista pública **no usar realtime**: usar revalidación de Next.js (ISR, ~60 s) — es más
barato, cachea en el edge y aguanta que 200 personas abran la tabla de posiciones al mismo
tiempo el domingo.

Requisito fácil de olvidar: la tabla debe estar en la publicación
(`alter publication supabase_realtime add table ...`) **y** el usuario debe poder leerla por
RLS. Si RLS no deja leer, realtime no manda nada y no hay error visible.

## 5. Despliegue

- Sitio estático + `vercel.json` con `X-Robots-Tag: noindex` (herramienta interna).
- `sw.js` con estrategia **network-first**, y las llamadas a `*.supabase.co` excluidas del
  caché. Cache-first en una app de datos hace que la gente vea información vieja y no sepa
  por qué.
- `Cache-Control: max-age=0, must-revalidate` en `sw.js` e `index.html`, o el propio service
  worker se queda cacheado y ya nunca se actualiza la app.

Para la app del torneo: mismo Vercel, pero **el proyecto y el dominio a nombre de Casita
Solosé**, con Mario como miembro con permisos de administrador (así quedó en el acuerdo).
Conectar el repo de GitHub para tener previews por rama y poder enseñarle avances a Fer sin
tocar producción.

## 6. PWA

Manifest + service worker + `apple-touch-icon` bastan para que se instale en iOS y Android
sin pasar por ninguna tienda. Tres detalles que sí importan:

- `viewport-fit=cover` + `env(safe-area-inset-*)` en el padding, o el notch del iPhone tapa
  el encabezado.
- `apple-mobile-web-app-capable` y `apple-mobile-web-app-title` — iOS ignora buena parte del
  manifest y lee estos meta.
- Icono `maskable` aparte, con ~14 % de margen. Sin él Android recorta el logo en redondo.

Para la app del torneo esto vale doble: es exactamente lo que evita construir una app nativa
y pelearse con App Store y Play Store.

## 7. Costos

Todo esto está en $0: capa gratuita de Supabase (500 MB de base, 50,000 usuarios activos al
mes) y capa gratuita de Vercel (100 GB de tráfico). El piloto del torneo entra de sobra.
Los dos costos reales que van a aparecer: SMTP propio si se pasan de la capa gratuita de
Resend, y el dominio — que ya es de Fer.
