-- ============================================================
-- Overall admin: one account the rest of the committee can't touch.
--
-- Run after sql/round-admins.sql. Safe to run twice.
--
-- Every committee member is otherwise equal, so any of them could demote
-- or remove any other. This marks one membership as the overall admin
-- (Anthony) and enforces, in the database so no screen can get round it:
--
--   * nobody but the overall admin can change or remove the overall
--     admin's membership
--   * only the overall admin can make someone committee, or take
--     committee away
--   * nobody can make themselves (or anyone) overall admin from the
--     website or app; that's done here, in the SQL editor, only
--
-- Everything else the committee does (approving members, handicaps,
-- rounds, moderators) is unchanged.
-- ============================================================

alter table memberships add column if not exists is_owner boolean not null default false;

create or replace function is_overall_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships
     where profile_id = auth.uid() and is_owner and status = 'approved'
  );
$$;
grant execute on function is_overall_admin() to authenticated;

create or replace function guard_overall_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- The SQL editor, Edge Functions and the sign-up trigger run without a
  -- signed-in user. Those are trusted, so they can do anything.
  if auth.uid() is null then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    if old.is_owner and not is_overall_admin() then
      raise exception 'The overall admin can''t be removed.';
    end if;
    if old.role = 'committee' and not is_overall_admin() then
      raise exception 'Only the overall admin can remove a committee member.';
    end if;
    return old;
  end if;

  if new.is_owner is distinct from old.is_owner then
    raise exception 'The overall admin can only be changed by the site owner.';
  end if;

  if old.is_owner and not is_overall_admin()
     and (new.role is distinct from old.role or new.status is distinct from old.status) then
    raise exception 'Nobody else can change the overall admin''s access.';
  end if;

  if (old.role = 'committee' or new.role = 'committee')
     and new.role is distinct from old.role
     and not is_overall_admin() then
    raise exception 'Only the overall admin can give or take away committee (admin) access.';
  end if;

  if old.role = 'committee' and new.status is distinct from old.status
     and not is_overall_admin() then
    raise exception 'Only the overall admin can remove a committee member.';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_overall_admin on memberships;
create trigger guard_overall_admin
  before update or delete on memberships
  for each row execute function guard_overall_admin();

-- Anthony is the overall admin.
update memberships set is_owner = true
 where profile_id = (select id from auth.users where lower(email) = 'anthonygdunn@gmail.com');
