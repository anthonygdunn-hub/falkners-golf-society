-- ============================================================
-- Paying for a round by card, Apple Pay or Google Pay (Stripe).
--
-- Bank transfer stays as it is and stays free. Card is the extra
-- option: the player picks what they're paying for (golf only, golf +
-- food, or food only if they're just coming to eat), sees the price
-- with the card fee added, and pays on Stripe's own checkout page.
-- When Stripe tells us it's paid (a signed webhook), the golf is
-- marked confirmed and the food marked paid, with nobody ticking it.
--
-- No card details ever touch the website or this database. The
-- amount is always worked out here, never taken from the browser.
--
-- Card fee: Stripe charges 1.5% + 20p on standard UK cards, so the
-- player pays (amount + 20p) / (1 - 1.5%), rounded up to the penny.
--
-- Card payments only show once society_settings.card_payments is on
-- (the committee turns it on once the Stripe keys are in place).
--
-- Run after sql/payments.sql and sql/food-only.sql. Safe to run twice.
-- ============================================================

alter table society_settings add column if not exists card_payments boolean not null default false;

create table if not exists card_payments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  choice text not null check (choice in ('golf', 'golf_food', 'food')),
  -- [{"attendance_id":"…","name":"…","golf_pence":6000,"food_pence":1550}]
  lines jsonb not null,
  base_pence integer not null,
  fee_pence integer not null,
  total_pence integer not null,
  stripe_session_id text unique,
  stripe_payment_intent text,
  status text not null default 'open' check (status in ('open', 'paid', 'expired')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists card_payments_event_idx on card_payments (event_id);
alter table card_payments enable row level security;
drop policy if exists "See own card payments" on card_payments;
create policy "See own card payments" on card_payments for select to authenticated
  using (profile_id = auth.uid() or is_committee());
-- No insert/update policies: only the payment functions write here.

-- Stripe's webhook runs as the service role (no signed-in user), so
-- the attendance guard lets that through as well as the committee.
create or replace function attendance_before_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if can_manage_round(old.event_id)
     or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role' then
    return new;
  end if;
  if new.status is distinct from old.status
     or new.event_id is distinct from old.event_id
     or new.guest_of is distinct from old.guest_of
     or new.player_id is distinct from old.player_id
     or new.food_paid is distinct from old.food_paid
     or new.food_paid_at is distinct from old.food_paid_at
     or new.food_paid_by is distinct from old.food_paid_by then
    raise exception 'Only the committee can change that.';
  end if;
  return new;
end;
$$;

-- What the signed-in member owes for a round, for each choice, covering
-- themselves and any guests with a place. Used to show the prices and
-- by the checkout function to set the amount.
create or replace function card_quote(p_event uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  ev events; menu event_menus;
  golf integer; food integer;
  lines jsonb := '[]'::jsonb; r record;
  res jsonb := '{}'::jsonb; ch text; base integer; fee integer; sel jsonb;
  my_status text;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  select * into ev from events where id = p_event;
  if ev.id is null then raise exception 'That round no longer exists.'; end if;
  select * into menu from event_menus where event_id = p_event;
  golf := round(coalesce(ev.cost, 0) * 100);
  food := round(coalesce(menu.price, 0) * 100);

  select a.status into my_status from attendance a
   where a.event_id = p_event and a.profile_id = me and a.status in ('playing', 'food') limit 1;

  for r in
    select a.id, a.status, a.payment_status, a.food_paid,
           coalesce(p.name, pr.display_name, 'You') as name,
           (a.profile_id = me) as is_me,
           coalesce(mc.not_eating, false) as not_eating
      from attendance a
      left join players p on p.id = coalesce(a.player_id, (select id from players where profile_id = a.profile_id limit 1))
      left join profiles pr on pr.id = a.profile_id
      left join meal_choices mc on mc.event_id = p_event and mc.player_id = p.id
     where a.event_id = p_event
       and (a.profile_id = me or a.guest_of = me)
       and a.status in ('playing', 'food')
     order by (a.profile_id = me) desc, a.created_at
  loop
    lines := lines || jsonb_build_object(
      'attendance_id', r.id, 'name', case when r.is_me then 'You' else r.name end,
      'golf_due', r.status = 'playing' and r.payment_status <> 'confirmed' and golf > 0,
      'food_due', food > 0 and not r.food_paid and not r.not_eating);
  end loop;

  foreach ch in array array['golf', 'golf_food', 'food'] loop
    sel := '[]'::jsonb; base := 0;
    for r in select value as x from jsonb_array_elements(lines) loop
      declare g integer := 0; f integer := 0; l jsonb := r.x;
      begin
        if ch in ('golf', 'golf_food') and (l ->> 'golf_due')::boolean then g := golf; end if;
        if ch in ('golf_food', 'food') and (l ->> 'food_due')::boolean then f := food; end if;
        if g + f > 0 then
          sel := sel || jsonb_build_object('attendance_id', l ->> 'attendance_id', 'name', l ->> 'name', 'golf_pence', g, 'food_pence', f);
          base := base + g + f;
        end if;
      end;
    end loop;
    if base > 0 then
      fee := ceil((base + 20) / 0.985) - base;
      res := res || jsonb_build_object(ch, jsonb_build_object('lines', sel, 'base_pence', base, 'fee_pence', fee, 'total_pence', base + fee));
    end if;
  end loop;

  -- Golf + food is only offered if it's different from golf alone, and
  -- golfers aren't offered food alone (they pay golf first).
  if res ? 'golf_food' and res ? 'golf' and (res -> 'golf_food' ->> 'base_pence') = (res -> 'golf' ->> 'base_pence') then
    res := res - 'golf_food';
  end if;
  if not res ? 'golf' then res := res - 'golf_food'; end if;
  if my_status = 'playing' and res ? 'golf' then res := res - 'food'; end if;
  if my_status = 'food' then res := res - 'golf' - 'golf_food'; end if;

  return jsonb_build_object(
    'round', ev.name, 'golf_each_pence', golf, 'food_each_pence', food,
    'enabled', coalesce((select card_payments from society_settings limit 1), false),
    'options', res);
end $$;
revoke execute on function card_quote(uuid) from public, anon;
grant execute on function card_quote(uuid) to authenticated;

-- Called only by the Stripe webhook (service role) once Stripe says a
-- checkout is paid. Marks the golf confirmed and the food paid for each
-- line, once. Returns false if it was already applied or doesn't match.
create or replace function apply_card_payment(p_session text, p_amount integer, p_intent text)
returns boolean language plpgsql security definer set search_path = public as $$
declare cp card_payments; l jsonb;
begin
  select * into cp from card_payments where stripe_session_id = p_session for update;
  if cp.id is null or cp.status = 'paid' then return false; end if;
  if p_amount is distinct from cp.total_pence then
    raise exception 'Amount % does not match % for %', p_amount, cp.total_pence, p_session;
  end if;
  for l in select * from jsonb_array_elements(cp.lines) loop
    if (l ->> 'golf_pence')::integer > 0 then
      update attendance set payment_status = 'confirmed', payment_reference = 'Card',
             payment_confirmed_at = now(), payment_confirmed_by = null
       where id = (l ->> 'attendance_id')::uuid;
    end if;
    if (l ->> 'food_pence')::integer > 0 then
      update attendance set food_paid = true, food_paid_at = now(), food_paid_by = null
       where id = (l ->> 'attendance_id')::uuid;
    end if;
  end loop;
  update card_payments set status = 'paid', paid_at = now(), stripe_payment_intent = p_intent where id = cp.id;
  return true;
end $$;
revoke execute on function apply_card_payment(text, integer, text) from public, anon, authenticated;
grant execute on function apply_card_payment(text, integer, text) to service_role;
