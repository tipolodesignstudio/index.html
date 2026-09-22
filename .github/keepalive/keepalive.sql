-- Run this once in the Supabase dashboard: SQL Editor -> New query -> Run.
-- It is idempotent, so re-running it is harmless.

create table if not exists public.keepalive (
  id        smallint    primary key,
  last_seen timestamptz not null default now(),
  constraint keepalive_singleton check (id = 1)
);

insert into public.keepalive (id, last_seen)
values (1, now())
on conflict (id) do nothing;

alter table public.keepalive enable row level security;

-- The workflow sends the project's anon / publishable key, so it acts as the
-- `anon` role. These policies grant that role exactly enough access to touch
-- the single heartbeat row, and nothing else in the database.
drop policy if exists "keepalive read"   on public.keepalive;
drop policy if exists "keepalive update" on public.keepalive;

create policy "keepalive read"
  on public.keepalive
  for select
  to anon, authenticated
  using (id = 1);

create policy "keepalive update"
  on public.keepalive
  for update
  to anon, authenticated
  using (id = 1)
  with check (id = 1);
