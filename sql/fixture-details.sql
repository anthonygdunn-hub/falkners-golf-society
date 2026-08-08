-- ============================================================
-- The Falkners Arms Golf Society — extra fixture details
--
-- Run this AFTER the earlier sql/ migrations. Same process:
-- Supabase dashboard -> SQL Editor -> paste -> Run.
--
-- What this adds, so the committee can put the full picture of a
-- round on the site instead of just a name and a date:
--   - cost    : what it costs to play, shown to members before they register
--   - website : the course's own website, linked from the fixture
--
-- (address, notes and format already exist from sql/schema.sql.)
-- ============================================================

alter table events
  add column if not exists cost numeric(10,2);

alter table events
  add column if not exists website text;
