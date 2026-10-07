-- HSL Director Hub — Supabase schema
-- Run this once in your Supabase project's SQL Editor (Dashboard → SQL Editor → New query).

create extension if not exists pgcrypto;

-- ---------- Tables ----------

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  role text not null default 'viewer' check (role in ('owner','editor','viewer')),
  created_at timestamptz not null default now()
);

create table if not exists updates (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  author_id uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists links (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  url text not null,
  category text not null default 'Other',
  author_id uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists tools (
  id text primary key,
  label text not null,
  group_name text not null,
  done boolean not null default false,
  updated_at timestamptz not null default now()
);

-- ---------- Seed the resource checklist ----------

insert into tools (id, label, group_name, done) values
  ('semester-planner', 'Semester Planner / Calendar', 'Build', false),
  ('budget-guidance', 'Budget Guidance', 'Build', false),
  ('journey-tracker', 'Student Journey Tracker / Check-In Opportunities', 'Build', false),
  ('content-catalog', 'HSL Content Catalog', 'Build', false),
  ('define-outcomes', 'Outcomes', 'Define', false),
  ('define-expectations', 'Student Expectations', 'Define', false),
  ('define-values', 'Values', 'Define', false)
on conflict (id) do nothing;

-- ---------- Auto-create a profile row whenever someone signs up / is invited ----------

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, display_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    'viewer'
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------- Row Level Security ----------

alter table profiles enable row level security;
alter table updates enable row level security;
alter table links enable row level security;
alter table tools enable row level security;

-- profiles: any signed-in person can read everyone's name/role (needed to show
-- "posted by" and to render the Team Access page); role changes only happen
-- through the invite-user / set-role serverless functions (service role key),
-- never directly from the browser, so there is no client-facing update policy.
create policy "profiles_select_authenticated" on profiles
  for select using (auth.role() = 'authenticated');

-- updates: everyone signed in can read; only owner/editor can post; a post can
-- be deleted by its author or by an owner.
create policy "updates_select_authenticated" on updates
  for select using (auth.role() = 'authenticated');
create policy "updates_insert_editors" on updates
  for insert with check (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role in ('owner','editor'))
  );
create policy "updates_delete_own_or_owner" on updates
  for delete using (
    author_id = auth.uid()
    or exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'owner')
  );

-- links: same pattern as updates.
create policy "links_select_authenticated" on links
  for select using (auth.role() = 'authenticated');
create policy "links_insert_editors" on links
  for insert with check (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role in ('owner','editor'))
  );
create policy "links_delete_own_or_owner" on links
  for delete using (
    author_id = auth.uid()
    or exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'owner')
  );

-- tools: everyone signed in can read the checklist; only owner/editor can toggle it.
create policy "tools_select_authenticated" on tools
  for select using (auth.role() = 'authenticated');
create policy "tools_update_editors" on tools
  for update using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role in ('owner','editor'))
  ) with check (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role in ('owner','editor'))
  );

-- ---------- Realtime (so updates/links/checklist refresh live for everyone) ----------

alter publication supabase_realtime add table updates;
alter publication supabase_realtime add table links;
alter publication supabase_realtime add table tools;

-- ---------- Make yourself the first owner ----------
-- After you sign in once (see README step 5), run this with your own email:
-- update profiles set role = 'owner' where email = 'camden.harper@churchofthehighlands.com';
