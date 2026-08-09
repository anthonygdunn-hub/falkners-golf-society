-- ============================================================
-- The Falkners Arms Golf Society — the prizes for each round
--
-- Run this AFTER sql/schema.sql.
-- Supabase dashboard -> SQL Editor -> paste -> Run.
--
-- Every round has its own little honours board: longest drive and
-- nearest the pin on each nine, the top three overall, and the winning
-- pair. The committee types these in after the round and they appear
-- on the results page under that round's scorecard.
--
-- Names are stored as plain text rather than as links to the players
-- table, because a prize often goes to a guest, and the winning pair
-- is two names in one box. Free text keeps that honest and simple.
-- ============================================================

create table if not exists event_prizes (
  event_id uuid primary key references events(id) on delete cascade,
  longest_drive_front text,
  longest_drive_back text,
  nearest_pin_front text,
  nearest_pin_back text,
  first_place text,
  second_place text,
  third_place text,
  winning_pair text,
  updated_at timestamptz not null default now()
);

alter table event_prizes enable row level security;

-- Prizes are the fun part — everybody gets to see them.
drop policy if exists "Public can read prizes" on event_prizes;
create policy "Public can read prizes" on event_prizes for select using (true);

drop policy if exists "Committee can manage prizes" on event_prizes;
create policy "Committee can manage prizes" on event_prizes
  for all using (
    exists (select 1 from memberships m
            where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved')
  ) with check (
    exists (select 1 from memberships m
            where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved')
  );
