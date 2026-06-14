alter table public.crm_state enable row level security;
alter table public.crm_state force row level security;

revoke all on table public.crm_state from public, anon, authenticated;
grant select, insert, update on table public.crm_state to service_role;

revoke all on function public.replace_crm_state(text, bigint, jsonb)
from public, anon, authenticated;
grant execute on function public.replace_crm_state(text, bigint, jsonb) to service_role;

do $$
begin
  if not exists (
    select 1
    from pg_class
    where oid = 'public.crm_state'::regclass
      and relrowsecurity
      and relforcerowsecurity
  ) then
    raise exception 'RLS is not fully enabled for public.crm_state';
  end if;

  if has_table_privilege('anon', 'public.crm_state', 'select')
    or has_table_privilege('authenticated', 'public.crm_state', 'select')
    or has_table_privilege('anon', 'public.crm_state', 'insert')
    or has_table_privilege('authenticated', 'public.crm_state', 'insert')
    or has_table_privilege('anon', 'public.crm_state', 'update')
    or has_table_privilege('authenticated', 'public.crm_state', 'update')
    or has_table_privilege('anon', 'public.crm_state', 'delete')
    or has_table_privilege('authenticated', 'public.crm_state', 'delete')
  then
    raise exception 'Public Supabase roles still have access to public.crm_state';
  end if;
end;
$$;
