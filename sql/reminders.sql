-- ============================================================
-- Automatic reminders, every hour.
--
-- Run after sql/push-notifications.sql, once the push-notify Edge
-- Function has been redeployed with the reminders code. Safe to run twice.
--
-- The function itself decides what's due (entries closing in two days,
-- 6pm the day before, unpaid two days before) and sends each reminder
-- once per person.
-- ============================================================

create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job where jobname = 'falkners-reminders';
select cron.schedule('falkners-reminders', '5 * * * *', $$ select notify_push('{"type":"reminders"}'::jsonb) $$);
