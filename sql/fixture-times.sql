-- ============================================================
-- The Falkners Arms Golf Society — meet and tee times
--
-- Run this AFTER the earlier sql/ migrations. Same process:
-- Supabase dashboard -> SQL Editor -> paste -> Run.
--
-- What this adds to a fixture:
--   - meet_time : when to turn up (bacon rolls, range, putting green)
--   - tee_time  : when the first group actually goes off
--
-- Stored as proper times rather than free text so they always display
-- consistently, and so they can be sorted or reported on later.
-- ============================================================

alter table events
  add column if not exists meet_time time;

alter table events
  add column if not exists tee_time time;
