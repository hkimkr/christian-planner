-- 은혜의 하루: 항목별 동기화와 최신 수정 우선(LWW) 정책
-- 기존 public.planner_data는 마이그레이션용 백업으로 그대로 둡니다.

create table if not exists public.planner_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null,
  entity_id text not null,
  payload jsonb,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  client_id text not null,
  server_received_at timestamptz not null default now(),
  primary key (user_id, entity_type, entity_id)
);

create index if not exists planner_records_user_updated_idx
  on public.planner_records (user_id, updated_at desc);

alter table public.planner_records enable row level security;

grant select, insert, update on public.planner_records
  to authenticated;

drop policy if exists "planner_records_select_own" on public.planner_records;
create policy "planner_records_select_own"
  on public.planner_records
  for select
  using (auth.uid() = user_id);

drop policy if exists "planner_records_insert_own" on public.planner_records;
create policy "planner_records_insert_own"
  on public.planner_records
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "planner_records_update_own" on public.planner_records;
create policy "planner_records_update_own"
  on public.planner_records
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.upsert_planner_records(p_records jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  insert into public.planner_records (
    user_id,
    entity_type,
    entity_id,
    payload,
    updated_at,
    deleted_at,
    client_id,
    server_received_at
  )
  select
    auth.uid(),
    item.entity_type,
    item.entity_id,
    item.payload,
    item.updated_at,
    item.deleted_at,
    item.client_id,
    now()
  from jsonb_to_recordset(coalesce(p_records, '[]'::jsonb)) as item(
    entity_type text,
    entity_id text,
    payload jsonb,
    updated_at timestamptz,
    deleted_at timestamptz,
    client_id text
  )
  where item.entity_type is not null
    and item.entity_id is not null
    and item.updated_at is not null
    and item.client_id is not null
  on conflict (user_id, entity_type, entity_id)
  do update set
    payload = excluded.payload,
    updated_at = excluded.updated_at,
    deleted_at = excluded.deleted_at,
    client_id = excluded.client_id,
    server_received_at = now()
  where
    excluded.updated_at > planner_records.updated_at
    or (
      excluded.updated_at = planner_records.updated_at
      and excluded.client_id > planner_records.client_id
    );
end;
$$;

grant execute on function public.upsert_planner_records(jsonb)
  to authenticated;

alter table public.planner_records replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'planner_records'
  ) then
    alter publication supabase_realtime add table public.planner_records;
  end if;
end
$$;
