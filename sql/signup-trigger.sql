-- ============================================================
-- The Falkners Arms Golf Society — new member signup trigger
--
-- Run this AFTER sql/members-and-gallery.sql and
-- sql/event-registration-intent.sql.
-- Supabase dashboard -> SQL Editor -> paste -> Run.
--
-- WHY THIS EXISTS
-- When somebody creates an account, Supabase writes a row into
-- auth.users. That on its own doesn't make them a member — the site
-- needs a matching profile (their name) and a membership row set to
-- 'pending' so they appear in the committee's approval list.
--
-- This trigger creates both. Without it, people can sign up and then
-- never show up anywhere for the committee to approve, which is
-- exactly what happened before this was applied.
--
-- The exception handler matters: if this function ever raises, the
-- whole signup fails and the person can't create an account at all.
-- Better to log a warning and let them in — a missing membership row
-- can be backfilled, a failed signup just loses the person.
-- ============================================================

create or replace function handle_new_member_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $BODY$
begin
  insert into profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), 'New member')
  )
  on conflict (id) do nothing;

  insert into memberships (profile_id, intended_event_id)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'intended_event_id', '')::uuid
  )
  on conflict (profile_id) do nothing;

  return new;
exception when others then
  raise warning 'handle_new_member_signup failed for %: %', new.id, sqlerrm;
  return new;
end;
$BODY$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_member_signup();

-- ------------------------------------------------------------------
-- Backfill: anyone who signed up while the trigger was missing or
-- broken. Safe to run more than once.
-- ------------------------------------------------------------------
insert into profiles (id, display_name)
select u.id, coalesce(nullif(u.raw_user_meta_data ->> 'display_name', ''), 'New member')
from auth.users u
left join profiles p on p.id = u.id
where p.id is null;

insert into memberships (profile_id)
select u.id
from auth.users u
left join memberships m on m.profile_id = u.id
where m.profile_id is null;
