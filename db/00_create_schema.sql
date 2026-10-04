-- GCM Notified: one-time database setup in Supabase.
-- Run ONCE in Supabase Studio → SQL Editor (as the default postgres / supabase_admin user).
--
-- Creates:
--   * login role `gcm_notified` that can ONLY use the `whatsapp` schema
--   * schema `whatsapp`, owned by that role (the app creates its own tables inside it)
-- Does NOT touch any existing schema, table or Supabase component.
-- The `whatsapp` schema is not exposed through Supabase's REST API.
--
-- STEP 1: put your new password on the line marked  >>> SET PASSWORD HERE <<<
--         (e.g. from `openssl rand -hex 24`; letters and digits only).
--         Keep it in your password manager — you will paste it into Coolify yourself.
--         Do not save or commit the edited file.
-- STEP 2: run the whole script. It stops with an error if the password was not changed.

do $$
declare
  app_password text := 'PUT_PASSWORD_HERE';   -- >>> SET PASSWORD HERE <<<
begin
  if app_password = 'PUT_' || 'PASSWORD_HERE' or length(app_password) < 16 then
    raise exception 'Set a real password (16+ characters) on the "SET PASSWORD HERE" line first';
  end if;
  if exists (select 1 from pg_roles where rolname = 'gcm_notified') then
    execute format('alter role gcm_notified with login password %L', app_password);
  else
    execute format('create role gcm_notified with login password %L connection limit 10', app_password);
  end if;
end $$;

create schema if not exists whatsapp authorization gcm_notified;

-- Keep the role out of everything else
revoke all on schema public from gcm_notified;
revoke all on all tables in schema public from gcm_notified;
alter role gcm_notified set search_path = whatsapp;
alter role gcm_notified set statement_timeout = '30s';
grant connect on database postgres to gcm_notified;

-- Check: should return one row →  whatsapp | gcm_notified
select nspname as schema, pg_get_userbyid(nspowner) as owner
from pg_namespace where nspname = 'whatsapp';
