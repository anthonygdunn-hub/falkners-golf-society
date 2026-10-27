-- ============================================================
-- Who can call the scoring functions. Run last. Safe to run twice.
-- Postgres lets everyone run a new function by default; this closes
-- the internal ones completely and limits the app's ones to signed-in
-- members (each also checks who's asking).
-- ============================================================

revoke execute on function recompute_hole_score(uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function score_entries_changed() from public, anon, authenticated;
revoke execute on function notify_dispute_escalated() from public, anon, authenticated;
revoke execute on function profiles_lock_handicap() from public, anon, authenticated;
revoke execute on function players_lock_handicap() from public, anon, authenticated;

revoke execute on function accept_score(uuid, uuid, integer, integer, boolean) from public, anon;
revoke execute on function submit_card(uuid, uuid) from public, anon;
revoke execute on function ask_committee(uuid, uuid, integer) from public, anon;
revoke execute on function settle_score(uuid, uuid, integer, integer, boolean) from public, anon;
revoke execute on function scoring_field(uuid) from public, anon;
revoke execute on function link_member_player(uuid) from public, anon;
revoke execute on function my_player_id() from public, anon;
grant execute on function accept_score(uuid, uuid, integer, integer, boolean) to authenticated;
grant execute on function submit_card(uuid, uuid) to authenticated;
grant execute on function ask_committee(uuid, uuid, integer) to authenticated;
grant execute on function settle_score(uuid, uuid, integer, integer, boolean) to authenticated;
grant execute on function scoring_field(uuid) to authenticated;
grant execute on function link_member_player(uuid) to authenticated;
grant execute on function my_player_id() to authenticated;
