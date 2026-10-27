-- ============================================================
-- Handicap reviews after each round.
--
-- Run after sql/ryder-cup.sql. Safe to run twice.
--
-- When a round is finished the app works out, for every card, the
-- WHS score differential and a suggested new index (best 8 of the last
-- 20, with the official table for fewer), plus the society's cuts for
-- the winners. The committee checks each one and approves it; approving
-- writes the row here and sets the player's index on the player list.
-- The differentials saved here are what the next round's calculation
-- uses. Committee only.
-- ============================================================

create table if not exists handicap_reviews (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  old_index numeric,
  differential numeric,
  whs_index numeric,
  cut numeric not null default 0,
  new_index numeric,
  note text,
  approved_by uuid references profiles(id) on delete set null default auth.uid(),
  approved_at timestamptz not null default now(),
  unique (event_id, player_id)
);
create index if not exists handicap_reviews_player on handicap_reviews(player_id, approved_at);

alter table handicap_reviews enable row level security;
drop policy if exists "Members read reviews" on handicap_reviews;
create policy "Members read reviews" on handicap_reviews for select using (is_approved_member());
drop policy if exists "Committee writes reviews" on handicap_reviews;
create policy "Committee writes reviews" on handicap_reviews for all using (is_committee()) with check (is_committee());
