-- ============================================================
-- attendance_payments is read-only, and the alert triggers have a
-- fixed search path. Run after sql/registration-limits-and-guests.sql.
-- Safe to run twice.
--
-- The view runs with its owner's rights on purpose (the attendance
-- table hides payment columns from members, and the view shows each
-- member only their own rows). Writing through it skipped the
-- attendance rules, so it's select-only. Members flag a payment with
-- claim_round_payment(); the committee confirms on the admin page.
-- ============================================================

revoke insert, update, delete, truncate, references, trigger on attendance_payments from anon, authenticated, public;
grant select on attendance_payments to anon, authenticated;

alter function notify_new_member_request() set search_path = public;
alter function notify_payment_claimed() set search_path = public;
revoke execute on function notify_new_member_request() from public, anon, authenticated;
revoke execute on function notify_payment_claimed() from public, anon, authenticated;
