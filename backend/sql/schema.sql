-- ShowMeSteps schema for Supabase (PostgreSQL + Auth + Storage)
-- Run in Supabase SQL Editor (Dashboard → SQL → New query)

-- Extensions
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Tutorials
-- ---------------------------------------------------------------------------
create table if not exists public.tutorials (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  description text,
  status text not null default 'draft'
    check (status in ('draft', 'published', 'archived')),
  share_slug text,
  completion_criteria jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tutorials_owner_id_idx on public.tutorials (owner_id);
create index if not exists tutorials_status_idx on public.tutorials (status);
create unique index if not exists tutorials_share_slug_uidx
  on public.tutorials (share_slug)
  where share_slug is not null;

-- ---------------------------------------------------------------------------
-- Tutorial steps
-- ---------------------------------------------------------------------------
create table if not exists public.tutorial_steps (
  id uuid primary key default gen_random_uuid(),
  tutorial_id uuid not null references public.tutorials (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  description text,
  order_index integer not null default 0 check (order_index >= 0),
  screenshot_path text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tutorial_steps_tutorial_id_idx
  on public.tutorial_steps (tutorial_id);

-- ---------------------------------------------------------------------------
-- Media assets (screenshots + recording payloads)
-- ---------------------------------------------------------------------------
create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  tutorial_id uuid not null references public.tutorials (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  media_type text not null check (media_type in ('screenshot', 'recording')),
  bucket text not null,
  file_path text not null,
  file_name text not null,
  content_type text not null,
  size_bytes bigint,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists media_assets_tutorial_id_idx
  on public.media_assets (tutorial_id);
create index if not exists media_assets_owner_id_idx
  on public.media_assets (owner_id);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tutorials_set_updated_at on public.tutorials;
create trigger tutorials_set_updated_at
  before update on public.tutorials
  for each row execute function public.set_updated_at();

drop trigger if exists tutorial_steps_set_updated_at on public.tutorial_steps;
create trigger tutorial_steps_set_updated_at
  before update on public.tutorial_steps
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.tutorials enable row level security;
alter table public.tutorial_steps enable row level security;
alter table public.media_assets enable row level security;

-- Tutorials: owners manage their own
drop policy if exists "tutorials_select_own" on public.tutorials;
create policy "tutorials_select_own"
  on public.tutorials for select
  using (auth.uid() = owner_id);

drop policy if exists "tutorials_public_read_published" on public.tutorials;
create policy "tutorials_public_read_published"
  on public.tutorials for select
  using (status = 'published');

drop policy if exists "tutorials_insert_own" on public.tutorials;
create policy "tutorials_insert_own"
  on public.tutorials for insert
  with check (auth.uid() = owner_id);

drop policy if exists "tutorials_update_own" on public.tutorials;
create policy "tutorials_update_own"
  on public.tutorials for update
  using (auth.uid() = owner_id);

drop policy if exists "tutorials_delete_own" on public.tutorials;
create policy "tutorials_delete_own"
  on public.tutorials for delete
  using (auth.uid() = owner_id);

-- Steps: via parent tutorial ownership
drop policy if exists "steps_select_own" on public.tutorial_steps;
create policy "steps_select_own"
  on public.tutorial_steps for select
  using (
    exists (
      select 1 from public.tutorials t
      where t.id = tutorial_id and t.owner_id = auth.uid()
    )
  );

drop policy if exists "steps_public_read_published" on public.tutorial_steps;
create policy "steps_public_read_published"
  on public.tutorial_steps for select
  using (
    exists (
      select 1 from public.tutorials t
      where t.id = tutorial_id and t.status = 'published'
    )
  );

drop policy if exists "steps_insert_own" on public.tutorial_steps;
create policy "steps_insert_own"
  on public.tutorial_steps for insert
  with check (
    exists (
      select 1 from public.tutorials t
      where t.id = tutorial_id and t.owner_id = auth.uid()
    )
  );

drop policy if exists "steps_update_own" on public.tutorial_steps;
create policy "steps_update_own"
  on public.tutorial_steps for update
  using (
    exists (
      select 1 from public.tutorials t
      where t.id = tutorial_id and t.owner_id = auth.uid()
    )
  );

drop policy if exists "steps_delete_own" on public.tutorial_steps;
create policy "steps_delete_own"
  on public.tutorial_steps for delete
  using (
    exists (
      select 1 from public.tutorials t
      where t.id = tutorial_id and t.owner_id = auth.uid()
    )
  );

-- Media assets
drop policy if exists "media_select_own" on public.media_assets;
create policy "media_select_own"
  on public.media_assets for select
  using (auth.uid() = owner_id);

drop policy if exists "media_insert_own" on public.media_assets;
create policy "media_insert_own"
  on public.media_assets for insert
  with check (auth.uid() = owner_id);

drop policy if exists "media_delete_own" on public.media_assets;
create policy "media_delete_own"
  on public.media_assets for delete
  using (auth.uid() = owner_id);

-- ---------------------------------------------------------------------------
-- Storage buckets
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'screenshots',
    'screenshots',
    true,
    10485760,
    array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
  ),
  (
    'recordings',
    'recordings',
    false,
    52428800,
    array[
      'application/json',
      'text/plain',
      'video/webm',
      'video/mp4',
      'application/octet-stream'
    ]
  )
on conflict (id) do nothing;

-- Storage policies: path prefix = auth.uid()/...
drop policy if exists "screenshots_select" on storage.objects;
create policy "screenshots_select"
  on storage.objects for select
  using (bucket_id = 'screenshots');

drop policy if exists "screenshots_insert_own" on storage.objects;
create policy "screenshots_insert_own"
  on storage.objects for insert
  with check (
    bucket_id = 'screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "screenshots_delete_own" on storage.objects;
create policy "screenshots_delete_own"
  on storage.objects for delete
  using (
    bucket_id = 'screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "recordings_select_own" on storage.objects;
create policy "recordings_select_own"
  on storage.objects for select
  using (
    bucket_id = 'recordings'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "recordings_insert_own" on storage.objects;
create policy "recordings_insert_own"
  on storage.objects for insert
  with check (
    bucket_id = 'recordings'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "recordings_delete_own" on storage.objects;
create policy "recordings_delete_own"
  on storage.objects for delete
  using (
    bucket_id = 'recordings'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- Learner attempts / verification
-- ---------------------------------------------------------------------------
create table if not exists public.tutorial_attempts (
  id uuid primary key default gen_random_uuid(),
  tutorial_id uuid not null references public.tutorials (id) on delete cascade,
  learner_key text not null,
  learner_label text,
  status text not null default 'in_progress'
    check (status in (
      'in_progress', 'passed', 'failed', 'needs_retry', 'pending_review'
    )),
  steps_completed integer not null default 0,
  steps_total integer not null default 0,
  completed_step_indexes jsonb not null default '[]'::jsonb,
  verification_method text,
  verification_result jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  evidence_file_path text,
  reviewer_notes text,
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tutorial_attempts_tutorial_id_idx
  on public.tutorial_attempts (tutorial_id);

alter table public.tutorial_attempts enable row level security;

drop policy if exists "attempts_owner_select" on public.tutorial_attempts;
create policy "attempts_owner_select"
  on public.tutorial_attempts for select
  using (
    exists (
      select 1 from public.tutorials t
      where t.id = tutorial_id and t.owner_id = auth.uid()
    )
  );

drop policy if exists "attempts_owner_update" on public.tutorial_attempts;
create policy "attempts_owner_update"
  on public.tutorial_attempts for update
  using (
    exists (
      select 1 from public.tutorials t
      where t.id = tutorial_id and t.owner_id = auth.uid()
    )
  );
