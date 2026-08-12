-- Links a scoring roster row (players) to the website account (profiles)
-- that person signed up with, once the committee has matched them.
--
-- A player row can exist with no profile_id (a guest, or someone who
-- hasn't signed up yet) or with one (a member whose account is linked).
-- Safe to run twice.

alter table players
  add column if not exists profile_id uuid references profiles(id) on delete set null;

create unique index if not exists players_profile_id_key
  on players(profile_id)
  where profile_id is not null;
