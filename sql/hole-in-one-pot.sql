-- ============================================================
-- The Falkners Arms Golf Society — the rolling hole-in-one pot
--
-- Run this AFTER sql/schema.sql.
-- Supabase dashboard -> SQL Editor -> paste -> Run.
--
-- Everyone chips in a pound a round, and the pot rolls over until
-- somebody finally holes one. So the pot isn't a single number that
-- gets overwritten — it's a running list of entries that adds up.
-- That way the history survives: you can see which round put what in,
-- and a payout is just an entry with a negative amount naming the
-- winner. Nothing is ever quietly rewritten.
-- ============================================================

create table if not exists hole_in_one_ledger (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id) on delete set null,
  -- Positive puts money in, negative pays it out to a winner.
  amount numeric not null,
  note text,
  entry_date date not null default current_date,
  created_at timestamptz not null default now()
);

create index if not exists hole_in_one_ledger_date_idx
  on hole_in_one_ledger (entry_date desc);

alter table hole_in_one_ledger enable row level security;

-- The whole point is that the pot shows live to anyone visiting.
drop policy if exists "Public can read the pot" on hole_in_one_ledger;
create policy "Public can read the pot" on hole_in_one_ledger for select using (true);

drop policy if exists "Committee can manage the pot" on hole_in_one_ledger;
create policy "Committee can manage the pot" on hole_in_one_ledger
  for all using (
    exists (select 1 from memberships m
            where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved')
  ) with check (
    exists (select 1 from memberships m
            where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved')
  );
