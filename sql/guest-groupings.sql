-- ============================================================
-- The Falkners Arms Golf Society — guests in the tee groups
--
-- Run this AFTER sql/attendance-and-groupings.sql and
-- sql/guest-players.sql.
-- Supabase dashboard -> SQL Editor -> paste -> Run.
--
-- Attendance already allows a player added by hand as well as a
-- website member. The groups have to work the same way, or a fourball
-- with a guest in it can't be written down.
--
-- Same shape as attendance: a row names EITHER a website member
-- (profile_id) OR a player added by hand (player_id), never both.
-- ============================================================

alter table groupings alter column profile_id drop not null;

alter table groupings
  add column if not exists player_id uuid references players(id) on delete cascade;

alter table groupings drop constraint if exists groupings_one_identity;
alter table groupings add constraint groupings_one_identity
  check ((profile_id is not null) <> (player_id is not null));

create unique index if not exists groupings_event_player_uniq
  on groupings (event_id, player_id)
  where player_id is not null;
