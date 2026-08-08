-- ============================================================
-- The Falkners Arms Golf Society — richer member profiles
--
-- Run this AFTER the earlier sql/ migrations. Same process:
-- Supabase dashboard -> SQL Editor -> paste -> Run.
--
-- Adds a playing handicap and a short bio to a member's profile,
-- alongside the display name and picture they can already set.
--
-- Both are readable by anyone (the existing "Public can read profiles"
-- policy), and editable only by the member themselves — so nobody can
-- quietly adjust someone else's handicap before a round.
-- ============================================================

alter table profiles
  add column if not exists handicap numeric(4,1);

alter table profiles
  add column if not exists bio text;
