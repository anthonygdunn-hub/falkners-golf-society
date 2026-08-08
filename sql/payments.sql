-- ============================================================
-- The Falkners Arms Golf Society — paying for a round
--
-- Run this AFTER the earlier sql/ migrations. Same process:
-- Supabase dashboard -> SQL Editor -> paste -> Run.
--
-- How paying works:
--   1. A member registers for a fixture as normal.
--   2. They see the cost, the society's bank details and a unique
--      reference, and tap "I've paid" once they've sent it.
--   3. A committee member confirms it once it lands in the account.
--
-- Money never passes through the website, so there are no card fees
-- and nothing sensitive is stored here — only whether someone has paid.
--
-- The bank details live in the database rather than in the code,
-- because the repository is public. Only approved members can read
-- them; only the committee can change them.
-- ============================================================

-- ------------------------------------------------------------------
-- Society bank details — a single row the committee edits in admin.
-- ------------------------------------------------------------------

create table if not exists society_settings (
  id boolean primary key default true,
  account_name text,
  sort_code text,
  account_number text,
  payment_note text,
  updated_at timestamptz not null default now(),
  -- Belt and braces: this table must never hold more than one row.
  constraint society_settings_single_row check (id)
);

insert into society_settings (id) values (true) on conflict (id) do nothing;

alter table society_settings enable row level security;

-- Deliberately NOT public: bank details are for members, not the world.
drop policy if exists "Approved members can read bank details" on society_settings;
create policy "Approved members can read bank details" on society_settings
  for select using (
    exists (select 1 from memberships m where m.profile_id = auth.uid() and m.status = 'approved')
  );

drop policy if exists "Committee can update bank details" on society_settings;
create policy "Committee can update bank details" on society_settings
  for update using (
    exists (select 1 from memberships m where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved')
  ) with check (
    exists (select 1 from memberships m where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved')
  );

-- ------------------------------------------------------------------
-- Payment state lives on the registration itself.
--   unpaid    — registered, nothing sent yet
--   claimed   — the member says they've paid; awaiting a check
--   confirmed — a committee member has seen it in the account
-- ------------------------------------------------------------------

alter table attendance
  add column if not exists payment_status text not null default 'unpaid';

-- Guarded so the whole file stays safe to re-run: adding a constraint
-- that already exists is an error, unlike "add column if not exists".
do $BODY$ begin
  if not exists (select 1 from pg_constraint where conname = 'attendance_payment_status_check') then
    alter table attendance add constraint attendance_payment_status_check
      check (payment_status in ('unpaid','claimed','confirmed'));
  end if;
end $BODY$;

alter table attendance
  add column if not exists payment_reference text;

alter table attendance
  add column if not exists payment_confirmed_at timestamptz;

alter table attendance
  add column if not exists payment_confirmed_by uuid references profiles(id);

-- A member may flag their own payment, but the check constraint below
-- stops them marking it 'confirmed' — only the committee can do that.
drop policy if exists "Members can flag their own payment" on attendance;
create policy "Members can flag their own payment" on attendance
  for update using (profile_id = auth.uid())
  with check (
    profile_id = auth.uid()
    and payment_status in ('unpaid', 'claimed')
  );

drop policy if exists "Committee can settle payments" on attendance;
create policy "Committee can settle payments" on attendance
  for update using (
    exists (select 1 from memberships m where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved')
  ) with check (
    exists (select 1 from memberships m where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved')
  );

-- Who's paid for a round is committee business, so the existing public
-- read on attendance stays as-is (names only, no payment detail is
-- exposed by it) and the admin page reads payment_status as a
-- signed-in committee member.
