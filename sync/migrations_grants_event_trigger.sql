-- ============================================================================
-- Permanent, role-independent fix for the grants-lockdown gap  --  2026-08-01
--
-- migrations_grants_lockdown.sql fixed `ALTER DEFAULT PRIVILEGES FOR ROLE
-- postgres`, but a second default-ACL entry for role `supabase_admin`
-- (visible in pg_default_acl) couldn't be altered the same way -- the
-- `postgres` role isn't a member of `supabase_admin` and Postgres requires
-- being the target role (or a member of it, or a superuser) to run ALTER
-- DEFAULT PRIVILEGES FOR ROLE X. RC tried running that fix himself via the
-- Supabase Dashboard's SQL Editor and got the identical `permission denied
-- to change default privileges` error -- confirming that connection is
-- ALSO not privileged enough, not something specific to the Management API.
--
-- This is a structurally better fix anyway: rather than patching each
-- role's default ACL one at a time (and needing to remember to patch a
-- THIRD role's default if one ever creates tables too), an event trigger
-- fires on every CREATE TABLE regardless of which role issued it --
-- postgres, supabase_admin, or anything else -- and immediately revokes
-- the write grants. Confirmed live: `postgres` CAN create event triggers
-- in this project despite not being a full Postgres superuser
-- (rolsuper=false) -- Supabase grants this specific capability anyway.
-- ============================================================================

create or replace function public._lockdown_new_table_grants()
returns event_trigger
language plpgsql
as $$
declare
  obj record;
begin
  for obj in select * from pg_event_trigger_ddl_commands() where command_tag = 'CREATE TABLE'
  loop
    execute format('revoke insert, update, delete, truncate on table %s from anon, authenticated', obj.object_identity);
  end loop;
end;
$$;

drop event trigger if exists lockdown_new_table_grants;
create event trigger lockdown_new_table_grants on ddl_command_end
  when tag in ('CREATE TABLE')
  execute function public._lockdown_new_table_grants();
