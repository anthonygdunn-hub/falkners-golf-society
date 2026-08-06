-- ============================================================
-- The Falkners Arms Golf Society — fixture attendance & groupings
--
-- Run this AFTER sql/schema.sql and sql/members-and-gallery.sql.
-- Same process: Supabase dashboard -> SQL Editor -> paste -> Run.
--
-- What this adds:
--   - Members can register ("I'm playing") for a specific fixture
--   - Everyone can see who's registered for a round
--   - Committee can arrange registered players into groups the
--     night before, by dragging them between group columns
-- ============================================================

create table if not exists attendance (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references events(id) on delete cascade,
    profile_id uuid not null references profiles(id) on delete cascade,
    created_at timestamptz not null default now(),
    unique (event_id, profile_id)
  );

create table if not exists groupings (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references events(id) on delete cascade,
    profile_id uuid not null references profiles(id) on delete cascade,
    group_number int not null,
    position int not null default 0,
    unique (event_id, profile_id)
  );

alter table attendance enable row level security;
alter table groupings enable row level security;

-- Attendance: everyone can see who's playing. Only an approved member
-- can register themselves — never on someone else's behalf.
create policy "Public can read attendance" on attendance for select using (true);

create policy "Approved members can register themselves" on attendance
  for insert with check (
      profile_id = auth.uid()
      and exists (select 1 from memberships m where m.profile_id = auth.uid() and m.status = 'approved')
    );

create policy "Members can un-register themselves" on attendance
  for delete using (profile_id = auth.uid());

-- Groupings: everyone can see the groups once posted. Only committee
-- can create or rearrange them.
create policy "Public can read groupings" on groupings for select using (true);

create policy "Committee can manage groupings" on groupings
  for all using (
      exists (select 1 from memberships m where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved')
    ) with check (
      exists (select 1 from memberships m where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved')
    );
