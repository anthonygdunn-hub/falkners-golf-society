-- ============================================================
-- Phone notifications from the scoring app.
--
-- Run after sql/round-extras.sql. Safe to run twice. Needs the
-- push-notify Edge Function (supabase/functions/push-notify) deployed,
-- with the VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY secrets set.
--
-- Three things send a notification to the players on a round:
--   * the committee publishes the round (scoring's open)
--   * the round is finished (results are in)
--   * a score in your group becomes disputed
-- The database only says "this happened"; the function checks it really
-- did and works out who to tell, so a call can't be faked or repeated.
-- ============================================================

create table if not exists push_subscriptions (
  endpoint text primary key,
  profile_id uuid not null references profiles(id) on delete cascade default auth.uid(),
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
alter table push_subscriptions enable row level security;
drop policy if exists "Own subscriptions" on push_subscriptions;
create policy "Own subscriptions" on push_subscriptions for select using (profile_id = auth.uid());
drop policy if exists "Remove own subscriptions" on push_subscriptions;
create policy "Remove own subscriptions" on push_subscriptions for delete using (profile_id = auth.uid());

-- Saving goes through here so a phone that changes hands (or accounts)
-- moves to whoever's signed in now.
create or replace function save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_agent text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not is_approved_member() then raise exception 'Sign in first.'; end if;
  if p_endpoint !~ '^https://' then raise exception 'That is not a push address.'; end if;
  insert into push_subscriptions (endpoint, profile_id, p256dh, auth, user_agent)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth, left(p_agent, 200))
  on conflict (endpoint) do update set profile_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent;
end;
$$;
revoke execute on function save_push_subscription(text, text, text, text) from public, anon;
grant execute on function save_push_subscription(text, text, text, text) to authenticated;

-- Which notifications have gone, so the same one never goes twice.
create table if not exists push_sent (
  key text primary key,
  sent_at timestamptz not null default now()
);
alter table push_sent enable row level security;
-- No policies: only the Edge Function (service role) touches it.

create or replace function notify_push(p_body jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://drwfedhhpuhgiqmqtwgi.supabase.co/functions/v1/push-notify',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer sb_publishable_9BqjPM1TnF1b1gy0YTWGiA_iw9yxpUw'),
    body := p_body);
exception when others then
  raise warning 'Push not sent: %', sqlerrm;
end;
$$;
revoke execute on function notify_push(jsonb) from public, anon, authenticated;

create or replace function event_scoring_push()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'live' and (tg_op = 'INSERT' or old.status is distinct from 'live') then
    perform notify_push(jsonb_build_object('type', 'published', 'event_id', new.event_id));
  elsif new.status = 'final' and (tg_op = 'INSERT' or old.status is distinct from 'final') then
    perform notify_push(jsonb_build_object('type', 'final', 'event_id', new.event_id));
  end if;
  return new;
end;
$$;
revoke execute on function event_scoring_push() from public, anon, authenticated;
drop trigger if exists event_scoring_push on event_scoring;
create trigger event_scoring_push after insert or update of status on event_scoring
  for each row execute function event_scoring_push();

create or replace function hole_scores_push()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.disputed, false) and (tg_op = 'INSERT' or not coalesce(old.disputed, false)) then
    perform notify_push(jsonb_build_object('type', 'dispute', 'event_id', new.event_id, 'player_id', new.player_id, 'hole', new.hole));
  end if;
  return new;
end;
$$;
revoke execute on function hole_scores_push() from public, anon, authenticated;
drop trigger if exists hole_scores_push on hole_scores;
create trigger hole_scores_push after insert or update of disputed on hole_scores
  for each row execute function hole_scores_push();
