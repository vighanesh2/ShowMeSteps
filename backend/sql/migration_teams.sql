-- Phase 8: teams, membership, tutorial assignments
-- Run once in Supabase SQL Editor

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null unique,
  owner_id uuid not null references auth.users (id) on delete cascade,
  privacy_settings jsonb not null default '{
    "hide_learner_emails_from_members": true,
    "retain_attempts_days": 365,
    "allow_ai_coaching": true
  }'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists teams_owner_id_idx on public.teams (owner_id);

create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid references auth.users (id) on delete cascade,
  email text not null,
  role text not null default 'member'
    check (role in ('owner', 'admin', 'member')),
  status text not null default 'invited'
    check (status in ('invited', 'active', 'removed')),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, email)
);

create index if not exists team_members_team_id_idx on public.team_members (team_id);
create index if not exists team_members_user_id_idx on public.team_members (user_id);
create index if not exists team_members_email_idx on public.team_members (email);

create table if not exists public.tutorial_assignments (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  tutorial_id uuid not null references public.tutorials (id) on delete cascade,
  assignee_user_id uuid references auth.users (id) on delete cascade,
  assignee_email text not null,
  assigned_by uuid not null references auth.users (id) on delete cascade,
  status text not null default 'assigned'
    check (status in ('assigned', 'in_progress', 'completed', 'cancelled')),
  due_at timestamptz,
  notes text,
  latest_attempt_id uuid references public.tutorial_attempts (id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tutorial_assignments_team_id_idx
  on public.tutorial_assignments (team_id);
create index if not exists tutorial_assignments_assignee_idx
  on public.tutorial_assignments (assignee_user_id);
create index if not exists tutorial_assignments_tutorial_id_idx
  on public.tutorial_assignments (tutorial_id);

drop trigger if exists teams_set_updated_at on public.teams;
create trigger teams_set_updated_at
  before update on public.teams
  for each row execute function public.set_updated_at();

drop trigger if exists team_members_set_updated_at on public.team_members;
create trigger team_members_set_updated_at
  before update on public.team_members
  for each row execute function public.set_updated_at();

drop trigger if exists tutorial_assignments_set_updated_at on public.tutorial_assignments;
create trigger tutorial_assignments_set_updated_at
  before update on public.tutorial_assignments
  for each row execute function public.set_updated_at();

alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.tutorial_assignments enable row level security;

-- Members can read their teams
drop policy if exists "teams_member_select" on public.teams;
create policy "teams_member_select"
  on public.teams for select
  using (
    exists (
      select 1 from public.team_members m
      where m.team_id = id
        and m.status = 'active'
        and m.user_id = auth.uid()
    )
  );

drop policy if exists "team_members_select" on public.team_members;
create policy "team_members_select"
  on public.team_members for select
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.team_members m
      where m.team_id = team_id
        and m.user_id = auth.uid()
        and m.status = 'active'
        and m.role in ('owner', 'admin')
    )
  );

drop policy if exists "assignments_select" on public.tutorial_assignments;
create policy "assignments_select"
  on public.tutorial_assignments for select
  using (
    assignee_user_id = auth.uid()
    or exists (
      select 1 from public.team_members m
      where m.team_id = team_id
        and m.user_id = auth.uid()
        and m.status = 'active'
        and m.role in ('owner', 'admin')
    )
  );
