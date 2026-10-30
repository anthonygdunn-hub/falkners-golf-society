-- ============================================================
-- What's in each player's bag.
--
-- Run after sql/private-games.sql. Safe to run twice.
--
-- One row per item: clubs (with how far the player hits them, used for
-- the club suggestion under the yardage), and their glove, shoes and
-- ball. Retired kit stays listed under Retired. Every member can see
-- every bag; only the player (or the committee) changes theirs.
-- ============================================================

create table if not exists player_equipment (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players(id) on delete cascade,
  kind text not null check (kind in ('club', 'glove', 'shoes', 'ball')),
  club text check (club is null or club ~ '^[A-Z0-9]{1,4}$'),
  distance integer check (distance is null or distance between 1 and 400),
  make text check (make is null or length(make) <= 60),
  model text check (model is null or length(model) <= 80),
  loft numeric check (loft is null or loft between 0 and 80),
  shaft text check (shaft is null or length(shaft) <= 80),
  note text check (note is null or length(note) <= 200),
  retired boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists player_equipment_player on player_equipment(player_id);

create or replace function owns_player(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from players p where p.id = pid and p.profile_id = auth.uid() and p.guest_event_id is null)
     and is_approved_member();
$$;
revoke execute on function owns_player(uuid) from public, anon;
grant execute on function owns_player(uuid) to authenticated;

alter table player_equipment enable row level security;
drop policy if exists "Members see bags" on player_equipment;
create policy "Members see bags" on player_equipment for select using (is_approved_member());
drop policy if exists "Players keep their bag" on player_equipment;
create policy "Players keep their bag" on player_equipment for all
  using (owns_player(player_id) or is_committee()) with check (owns_player(player_id) or is_committee());
