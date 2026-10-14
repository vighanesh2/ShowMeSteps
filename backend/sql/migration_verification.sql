-- Phase 6: completion criteria + learner attempts
-- Run once in Supabase SQL Editor

alter table public.tutorials
  add column if not exists completion_criteria jsonb not null default '{}'::jsonb;

create table if not exists public.tutorial_attempts (
  id uuid primary key default gen_random_uuid(),
  tutorial_id uuid not null references public.tutorials (id) on delete cascade,
  learner_key text not null,
  learner_label text,
  status text not null default 'in_progress'
    check (status in (
      'in_progress',
      'passed',
      'failed',
      'needs_retry',
      'pending_review'
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
create index if not exists tutorial_attempts_learner_key_idx
  on public.tutorial_attempts (learner_key);
create index if not exists tutorial_attempts_status_idx
  on public.tutorial_attempts (status);

drop trigger if exists tutorial_attempts_set_updated_at on public.tutorial_attempts;
create trigger tutorial_attempts_set_updated_at
  before update on public.tutorial_attempts
  for each row execute function public.set_updated_at();

alter table public.tutorial_attempts enable row level security;

-- Owners can read/update attempts for their tutorials
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

-- Service role used by API bypasses RLS; anon inserts go through backend service role.
