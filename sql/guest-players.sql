-- ============================================================
-- The Falkners Arms Golf Society — guest players on a fixture
--
-- Run this AFTER sql/attendance-and-groupings.sql.
-- Supabase dashboard -> SQL Editor -> paste -> Run.
--
-- WHY THIS EXISTS
-- Plenty of people play a round without ever creating a website
-- account — a mate brought along for the day, a member who'd rather
-- ring you than sign up. Until now the playing list could only hold
-- website members, because attendance rows pointed at a profile.
--
-- This lets a committee member add anyone to a round by name. Those
-- names come from the existing `players` table, which is already what
-- results and the leaderboard are built on — so a guest who plays
-- well can be scored without any extra work.
--
-- An attendance row now names EITHER a website member (profile_id)
-- OR a player added by hand (player_id), never both and never neither.
-- ============================================================

-- A guest has no profile, so profile_id has to be allowed to be empty.
alter table attendance alter column profile_id drop not null;

alter table attendance
  add column if not exists player_id uuid references players(id) on delete cascade;

-- Deliberately no "added_by" column. A second foreign key from
-- attendance to profiles would make PostgREST's automatic joins
-- ambiguous, and a row already says who it is: player_id means the
-- committee added them, profile_id means they registered themselves.

alter table attendance drop constraint if exists attendance_one_identity;
alter table attendance add constraint attendance_one_identity
  check ((profile_id is not null) <> (player_id is not null));

-- Stops the same guest being added to the same round twice. The
-- existing unique (event_id, profile_id) still covers members —
-- Postgres treats NULLs as distinct, so guest rows don't collide.
create unique index if not exists attendance_event_player_uniq
  on attendance (event_id, player_id)
  where player_id is not null;

-- ------------------------------------------------------------------
-- The committee can add or remove anyone on any round. Members keep
-- their existing ability to register and un-register themselves only.
-- ------------------------------------------------------------------
drop policy if exists "Committee can manage attendance" on attendance;
create policy "Committee can manage attendance" on attendance
  for all using (
    exists (
      select 1 from memberships m
      where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved'
    )
  ) with check (
    exists (
      select 1 from memberships m
      where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved'
    )
  );
