-- ============================================================
-- The Falkners Arms Golf Society — event registration intent
--
-- Run this AFTER sql/schema.sql, sql/members-and-gallery.sql, and
-- sql/attendance-and-groupings.sql. Same process as always:
-- Supabase dashboard -> SQL Editor -> paste this whole file -> Run.
--
-- What this adds:
--   - Remembers which fixture someone wanted to play in when they hit
--     "Register" on an event page as a non-member and got sent through
--     the "Request to join" form instead.
--   - Lets the committee auto-register that person for that fixture the
--     moment they approve the membership in the admin dashboard — no
--     second step for the new member, they just show up as "playing".
-- ============================================================

alter table memberships
  add column if not exists intended_event_id uuid references events(id) on delete set null;

-- Same trigger as before (see sql/members-and-gallery.sql), extended to
-- also copy the intended event through from the signup form.
create or replace function handle_new_member_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', 'New member'));

  insert into memberships (profile_id, intended_event_id)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'intended_event_id', '')::uuid
  );

  return new;
end;
$$;

-- Normally only a member can register themselves for a fixture (see
-- sql/attendance-and-groupings.sql). This adds the one exception: when
-- the committee approves a brand-new member who signed up specifically
-- to play in a fixture, the approval action registers them for it on
-- their behalf.
create policy "Committee can register members" on attendance
  for insert with check (
    exists (select 1 from memberships m where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved')
  );
