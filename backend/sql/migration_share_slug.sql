-- Run once in Supabase SQL Editor (safe if column already exists)
alter table public.tutorials
  add column if not exists share_slug text;

create unique index if not exists tutorials_share_slug_uidx
  on public.tutorials (share_slug)
  where share_slug is not null;

-- Public read of published tutorials (anon / learner)
drop policy if exists "tutorials_public_read_published" on public.tutorials;
create policy "tutorials_public_read_published"
  on public.tutorials for select
  using (status = 'published');

drop policy if exists "steps_public_read_published" on public.tutorial_steps;
create policy "steps_public_read_published"
  on public.tutorial_steps for select
  using (
    exists (
      select 1 from public.tutorials t
      where t.id = tutorial_id and t.status = 'published'
    )
  );
