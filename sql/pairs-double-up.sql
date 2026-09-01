-- ============================================================
-- The Falkners Arms Golf Society - a player in two pairs
--
-- Run this AFTER sql/pairs-groupings.sql.
-- Supabase dashboard -> SQL Editor -> paste -> Run. Safe to run twice.
--
-- Why: the society regularly turns out an odd number, 21 being the
-- usual. Under the old rule one player was left out of the pairs
-- competition altogether. Now the odd player pairs with someone who is
-- already in a pair, so nobody misses out and that second player gets
-- two chances at the pairs prize.
--
-- What changes: the unique indexes stopped a player having more than
-- one row per group_type on a round. Adding group_number to the key
-- allows a second pairing while still refusing the same player twice
-- in the SAME pair, which would be nonsense. The tee draw is
-- unaffected, because its own screen only ever writes one row per
-- player.
-- ============================================================

drop index if exists groupings_event_profile_uniq;
drop index if exists groupings_event_player_uniq;

create unique index if not exists groupings_event_profile_uniq
  on groupings (event_id, profile_id, group_type, group_number)
  where profile_id is not null;

create unique index if not exists groupings_event_player_uniq
  on groupings (event_id, player_id, group_type, group_number)
  where player_id is not null;
