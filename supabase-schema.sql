create table if not exists public.planner_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  store jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.planner_data enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'planner_data' and policyname = 'Users read own data'
  ) then
    create policy "Users read own data"
      on public.planner_data for select
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'planner_data' and policyname = 'Users insert own data'
  ) then
    create policy "Users insert own data"
      on public.planner_data for insert
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'planner_data' and policyname = 'Users update own data'
  ) then
    create policy "Users update own data"
      on public.planner_data for update
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'planner_data'
  ) then
    alter publication supabase_realtime add table public.planner_data;
  end if;
end
$$;
