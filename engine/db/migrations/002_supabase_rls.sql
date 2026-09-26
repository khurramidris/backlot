-- Supabase exposes every table in `public` through its auto-generated REST/Realtime API.
-- Turn on row-level security everywhere: with no write policies, nobody can change engine
-- data except through the engine (which connects as the database owner and bypasses RLS).
-- On Supabase we also allow each signed-in user to READ their own rows, so the Lovable app
-- can subscribe to live changes with Supabase Realtime if you want that.

do $$
declare t text;
begin
  foreach t in array array['projects','episodes','scenes','assets','shots','takes','cuts','jobs','usage_events','credit_accounts','schema_migrations'] loop
    execute format('alter table %I enable row level security', t);
  end loop;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'auth' and p.proname = 'uid') then
    execute $p$drop policy if exists own_read on projects$p$;
    execute $p$create policy own_read on projects for select to authenticated using (owner_id = auth.uid())$p$;
    foreach t in array array['episodes','scenes','assets','shots','takes','cuts','jobs'] loop
      execute format('drop policy if exists own_read on %I', t);
      execute format('create policy own_read on %I for select to authenticated using (exists (select 1 from projects p where p.id = project_id and p.owner_id = auth.uid()))', t);
    end loop;
    execute $p$drop policy if exists own_read on usage_events$p$;
    execute $p$create policy own_read on usage_events for select to authenticated using (owner_id = auth.uid())$p$;
    execute $p$drop policy if exists own_read on credit_accounts$p$;
    execute $p$create policy own_read on credit_accounts for select to authenticated using (owner_id = auth.uid())$p$;
  end if;
end $$;
