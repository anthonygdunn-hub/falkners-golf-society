-- ============================================================
-- The Falkners Arms Golf Society — the members directory
--
-- Run this AFTER the earlier sql/ migrations. Same process:
-- Supabase dashboard -> SQL Editor -> paste -> Run.
--
-- Members can normally only read their OWN membership row, so the
-- browser has no way to work out who else has been approved. Rather
-- than loosen that rule, this adds one read-only function that returns
-- the directory — and returns nothing at all unless the person asking
-- is themselves an approved member.
--
-- Done as a function rather than a new policy on memberships on
-- purpose: a policy on memberships that queries memberships is the
-- classic Postgres recursion trap. SECURITY DEFINER sidesteps it.
-- ============================================================

create or replace function member_directory()
returns table (
  id uuid,
  display_name text,
  avatar_url text,
  handicap numeric,
  bio text,
  role text,
  member_since timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select p.id, p.display_name, p.avatar_url, p.handicap, p.bio,
         m.role, m.requested_at
  from profiles p
  join memberships m on m.profile_id = p.id
  where m.status = 'approved'
    -- The gate: nothing comes back unless the caller is approved too.
    and exists (
      select 1 from memberships me
      where me.profile_id = auth.uid() and me.status = 'approved'
    )
  order by p.display_name;
$$;

-- Signed-in members may call it; the function itself decides what (if
-- anything) they get back. Anonymous visitors get an empty result.
revoke all on function member_directory() from public;
grant execute on function member_directory() to authenticated;
