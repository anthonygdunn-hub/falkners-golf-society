-- ============================================================
-- The Falkners Arms Golf Society - the on-the-day competitions
--
-- Run this AFTER sql/round-prizes.sql.
-- Supabase dashboard -> SQL Editor -> paste -> Run. Safe to run twice.
--
-- A round can run any of six side competitions: longest drive,
-- nearest the pin, and nearest the pin in two, each on either nine.
-- Not every round runs all of them, and the hole they are played on
-- changes with the course, so both belong to the round rather than
-- being fixed in the site.
--
-- The hole number does both jobs. A number means the competition runs
-- that round and says where it is played; blank means it is not on.
-- That is why there is no separate on-off column: a competition can
-- never be switched on without a hole, and switching one off is just
-- clearing the box.
--
-- Holes sit on events because the committee sets them when setting up
-- the fixture, and the fixtures page shows them before the round is
-- played. Winners sit on event_prizes with the rest of the prizes,
-- because they are filled in afterwards.
-- ============================================================

alter table events
  add column if not exists ld_front_hole int,
  add column if not exists ld_back_hole int,
  add column if not exists ntp_front_hole int,
  add column if not exists ntp_back_hole int,
  add column if not exists ntp2_front_hole int,
  add column if not exists ntp2_back_hole int;

-- A golf hole is 1 to 18. Null stays allowed and means not running.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'events_competition_holes_valid'
  ) then
    alter table events add constraint events_competition_holes_valid check (
      (ld_front_hole   is null or ld_front_hole   between 1 and 18) and
      (ld_back_hole    is null or ld_back_hole    between 1 and 18) and
      (ntp_front_hole  is null or ntp_front_hole  between 1 and 18) and
      (ntp_back_hole   is null or ntp_back_hole   between 1 and 18) and
      (ntp2_front_hole is null or ntp2_front_hole between 1 and 18) and
      (ntp2_back_hole  is null or ntp2_back_hole  between 1 and 18)
    );
  end if;
end $$;

-- Longest drive and nearest the pin already had a winner column each.
-- Nearest the pin in two is new, so it needs its own pair. Free text
-- like the others, because a prize often goes to a guest.
alter table event_prizes
  add column if not exists nearest_pin2_front text,
  add column if not exists nearest_pin2_back text;
