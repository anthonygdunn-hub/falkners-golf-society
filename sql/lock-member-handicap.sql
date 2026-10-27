-- ============================================================
-- Handicaps are set by the committee only.
--
-- Members used to be able to change the handicap on their own
-- profile from My Account. This stops that at the database: a member
-- saving their profile keeps everything else they changed, but the
-- handicap stays as it was. The committee (admin page → Players)
-- can still change anyone's. Safe to run twice.
-- ============================================================

create or replace function profiles_lock_handicap()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.handicap is distinct from old.handicap and not is_committee() then
    new.handicap := old.handicap;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_lock_handicap on profiles;
create trigger profiles_lock_handicap before update on profiles
  for each row execute function profiles_lock_handicap();

-- The same for the player list: only the committee edits it already
-- (see sql/schema.sql), but make sure of it for the handicap column.
create or replace function players_lock_handicap()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.handicap is distinct from old.handicap and not is_committee() then
    new.handicap := old.handicap;
  end if;
  return new;
end;
$$;

drop trigger if exists players_lock_handicap on players;
create trigger players_lock_handicap before update on players
  for each row execute function players_lock_handicap();
