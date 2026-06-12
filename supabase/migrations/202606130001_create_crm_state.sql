create table if not exists public.crm_state (
  id text primary key,
  data jsonb not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.crm_state enable row level security;

revoke all on table public.crm_state from anon, authenticated;
grant select, insert, update on table public.crm_state to service_role;

create or replace function public.replace_crm_state(
  state_id text,
  expected_version bigint,
  next_data jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_version bigint;
begin
  update public.crm_state
  set
    data = next_data,
    version = version + 1,
    updated_at = now()
  where id = state_id
    and version = expected_version
  returning version into new_version;

  return new_version;
end;
$$;

revoke all on function public.replace_crm_state(text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.replace_crm_state(text, bigint, jsonb) to service_role;
