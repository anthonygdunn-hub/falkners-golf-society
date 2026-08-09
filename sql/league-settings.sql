-- ============================================================
-- The Falkners Arms Golf Society — Order of Merit rules
--
-- Run this AFTER sql/schema.sql.
-- Supabase dashboard -> SQL Editor -> paste -> Run.
--
-- Most societies don't count every single round toward the season
-- table — they count each player's best few, so one washout in the
-- rain doesn't sink somebody who's played well all year. This holds
-- that rule so the committee can change it without anyone editing code.
--
-- counting_rounds = null means every round counts, which is how the
-- leaderboard already behaved, so running this changes nothing until
-- the committee actually sets a number.
--
-- This is deliberately a table of its own rather than another column
-- on society_settings: the leaderboard is public, so the rule behind
-- it has to be public too, and society_settings holds bank details
-- that must stay members-only.
-- ============================================================

create table if not exists league_settings (
  id boolean primary key default true,
  counting_rounds int,
  updated_at timestamptz not null default now(),
  constraint league_settings_single_row check (id),
  constraint league_settings_sensible_count check (counting_rounds is null or counting_rounds > 0)
);

insert into league_settings (id) values (true) on conflict (id) do nothing;

alter table league_settings enable row level security;

drop policy if exists "Public can read league settings" on league_settings;
create policy "Public can read league settings" on league_settings
  for select using (true);

drop policy if exists "Committee can change league settings" on league_settings;
create policy "Committee can change league settings" on league_settings
  for update using (
    exists (select 1 from memberships m
            where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved')
  ) with check (
    exists (select 1 from memberships m
            where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved')
  );
