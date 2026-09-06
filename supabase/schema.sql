-- =====================================================================
-- Workflow Casita Solosé — esquema completo de Supabase
-- Corre este archivo tal cual en: Supabase Dashboard > SQL Editor > New query
-- Es idempotente: lo puedes volver a correr sin romper nada.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Lista de correos autorizados (editable desde la app)
-- ---------------------------------------------------------------------
create table if not exists public.allowed_emails (
  email      text primary key,
  label      text,
  added_by   text,
  created_at timestamptz not null default now()
);

-- Normaliza a minúsculas siempre
create or replace function public.lower_email()
returns trigger language plpgsql as $$
begin
  new.email := lower(trim(new.email));
  return new;
end $$;

drop trigger if exists allowed_emails_lower on public.allowed_emails;
create trigger allowed_emails_lower
  before insert or update on public.allowed_emails
  for each row execute function public.lower_email();

-- Semilla: Mario y Fer
insert into public.allowed_emails (email, label, added_by) values
  ('mariog36@gmail.com', 'Mario', 'seed'),
  ('solosefc@gmail.com', 'Fer',   'seed')
on conflict (email) do nothing;

-- ---------------------------------------------------------------------
-- 2. Helpers de identidad
-- ---------------------------------------------------------------------
-- Lee el correo del JWT directamente del GUC de la petición, sin depender de
-- permisos sobre el esquema auth. Equivale a (auth.jwt() ->> 'email') pero no
-- se rompe si cambian los grants del esquema auth.
create or replace function public.current_email()
returns text language sql stable as $$
  select lower(coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
    ''))
$$;

-- security definer: se salta RLS para poder consultar la allowlist sin recursión
create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.allowed_emails a
    where a.email = public.current_email()
  )
$$;

revoke all on function public.is_member() from public;
grant execute on function public.current_email() to anon, authenticated;
grant execute on function public.is_member()    to anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Tabla de contenido del tablero
-- ---------------------------------------------------------------------
create table if not exists public.items (
  id             uuid primary key default gen_random_uuid(),
  section        text not null check (section in
                   ('acuerdo','todo','en_curso','completada','nota','largo_plazo')),
  texto          text not null check (char_length(btrim(texto)) > 0),
  responsable    text,                -- solo to-do's
  fecha_acuerdo  date,                -- solo acuerdos
  seccion_previa text,                -- de dónde vino al completarse (para reabrir)
  autor_email    text not null default public.current_email(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  completada_at  timestamptz
);

create index if not exists items_section_idx on public.items (section, created_at desc);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.section = 'completada' and coalesce(old.section,'') <> 'completada' then
    new.completada_at := now();
  elsif new.section <> 'completada' then
    new.completada_at := null;
  end if;
  return new;
end $$;

drop trigger if exists items_touch on public.items;
create trigger items_touch
  before update on public.items
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- 3b. Bitácora de avances por tarea
--     Para anotar "en qué va" sin tener que editar el texto de la tarea.
--     Tabla hija en vez de columna jsonb: dos personas pueden anotar a la
--     vez sin pisarse (con jsonb, el último update borra el del otro).
-- ---------------------------------------------------------------------
create table if not exists public.item_avances (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.items(id) on delete cascade,
  texto       text not null check (char_length(btrim(texto)) > 0),
  autor_email text not null default public.current_email(),
  created_at  timestamptz not null default now()
);

create index if not exists item_avances_item_idx
  on public.item_avances (item_id, created_at);

alter table public.item_avances enable row level security;

drop policy if exists avances_select on public.item_avances;
drop policy if exists avances_insert on public.item_avances;
drop policy if exists avances_update on public.item_avances;
drop policy if exists avances_delete on public.item_avances;

create policy avances_select on public.item_avances for select
  to authenticated using (public.is_member());
create policy avances_insert on public.item_avances for insert
  to authenticated with check (public.is_member() and autor_email = public.current_email());
create policy avances_update on public.item_avances for update
  to authenticated using (public.is_member() and autor_email = public.current_email())
  with check (public.is_member() and autor_email = public.current_email());
create policy avances_delete on public.item_avances for delete
  to authenticated using (public.is_member());

-- ---------------------------------------------------------------------
-- 4. Row Level Security — nadie fuera de la allowlist ve ni escribe nada
-- ---------------------------------------------------------------------
alter table public.items          enable row level security;
alter table public.allowed_emails enable row level security;

drop policy if exists items_select on public.items;
drop policy if exists items_insert on public.items;
drop policy if exists items_update on public.items;
drop policy if exists items_delete on public.items;

create policy items_select on public.items for select
  to authenticated using (public.is_member());
create policy items_insert on public.items for insert
  to authenticated with check (public.is_member() and autor_email = public.current_email());
create policy items_update on public.items for update
  to authenticated using (public.is_member()) with check (public.is_member());
create policy items_delete on public.items for delete
  to authenticated using (public.is_member());

drop policy if exists allowed_select on public.allowed_emails;
drop policy if exists allowed_insert on public.allowed_emails;
drop policy if exists allowed_delete on public.allowed_emails;

create policy allowed_select on public.allowed_emails for select
  to authenticated using (public.is_member());
create policy allowed_insert on public.allowed_emails for insert
  to authenticated with check (public.is_member());
-- Nadie puede borrarse a sí mismo (evita quedarse fuera del tablero)
create policy allowed_delete on public.allowed_emails for delete
  to authenticated using (public.is_member() and email <> public.current_email());

-- ---------------------------------------------------------------------
-- 5. Candado en el registro: ni siquiera se crea la cuenta si no está en la lista
--    (aunque alguien tenga el link y pida un magic link, Supabase lo rechaza)
-- ---------------------------------------------------------------------
create or replace function public.block_unlisted_signup()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.allowed_emails a where a.email = lower(new.email)
  ) then
    raise exception 'Correo no autorizado para el tablero Casita Solose';
  end if;
  return new;
end $$;

drop trigger if exists block_unlisted_signup on auth.users;
create trigger block_unlisted_signup
  before insert on auth.users
  for each row execute function public.block_unlisted_signup();

-- ---------------------------------------------------------------------
-- 6. Realtime (para que lo que agrega uno le aparezca al otro sin recargar)
-- ---------------------------------------------------------------------
do $$
begin
  begin
    alter publication supabase_realtime add table public.items;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.allowed_emails;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.item_avances;
  exception when duplicate_object then null;
  end;
end $$;

-- Listo.
