// ------------------------------------------------------------------
// Phone notifications for the scoring app.
//
// Called by the database (sql/push-notifications.sql) with just
// { type, event_id, player_id?, hole? }, and every hour with
// { type: "reminders" } (sql/reminders.sql). Nothing in the call is trusted:
// this checks the round really is live / finished, or the score really
// is disputed, writes down that it has told people (so a repeat call
// does nothing), then sends to the phones of the players concerned.
//
// Signing keys: made here the first time the function runs and kept in
// the push_config table, which only this function (service role) can
// read. The app asks for the public half with push_public_key().
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
// ------------------------------------------------------------------

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const admin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);

const SITE = "https://www.thefalknersarmsgolfsociety.co.uk";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

// Everyone down to play the round, as account ids.
async function roundProfiles(eventId: string): Promise<string[]> {
  const { data: att } = await admin.from("attendance").select("profile_id, player_id").eq("event_id", eventId).eq("status", "playing");
  const ids = new Set<string>();
  const playerIds: string[] = [];
  (att ?? []).forEach((a) => { if (a.profile_id) ids.add(a.profile_id); else if (a.player_id) playerIds.push(a.player_id); });
  if (playerIds.length) {
    const { data: pl } = await admin.from("players").select("profile_id").in("id", playerIds);
    (pl ?? []).forEach((p) => p.profile_id && ids.add(p.profile_id));
  }
  return [...ids];
}

// The tee group a player is in, as account ids, plus whoever entered the score.
async function groupProfiles(eventId: string, playerId: string, hole: number): Promise<string[]> {
  const ids = new Set<string>();
  const { data: me } = await admin.from("players").select("profile_id").eq("id", playerId).maybeSingle();
  if (me?.profile_id) ids.add(me.profile_id);
  const { data: g } = await admin.from("groupings").select("group_number, profile_id, player_id").eq("event_id", eventId).eq("group_type", "fours");
  const mine = (g ?? []).find((x) => x.player_id === playerId || (me?.profile_id && x.profile_id === me.profile_id));
  if (mine) {
    const same = (g ?? []).filter((x) => x.group_number === mine.group_number);
    same.forEach((x) => x.profile_id && ids.add(x.profile_id));
    const pids = same.filter((x) => !x.profile_id && x.player_id).map((x) => x.player_id);
    if (pids.length) {
      const { data: pl } = await admin.from("players").select("profile_id").in("id", pids);
      (pl ?? []).forEach((p) => p.profile_id && ids.add(p.profile_id));
    }
  }
  const { data: entries } = await admin.from("score_entries").select("entered_by").eq("event_id", eventId).eq("player_id", playerId).eq("hole", hole);
  (entries ?? []).forEach((e) => e.entered_by && ids.add(e.entered_by));
  return [...ids];
}

async function send(profileIds: string[], message: { title: string; body: string; url: string; tag: string }) {
  if (!profileIds.length) return { sent: 0 };
  const { data: subs } = await admin.from("push_subscriptions").select("endpoint, p256dh, auth").in("profile_id", profileIds);
  let sent = 0;
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(message), { TTL: 3600 });
      sent++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      // Gone for good (app removed, permission withdrawn): forget it.
      if (code === 404 || code === 410) await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      else console.error("Push failed", code, String(err));
    }
  }));
  return { sent, phones: subs?.length ?? 0 };
}

// ---------- scheduled reminders ----------
// The database calls { type: "reminders" } every hour (pg_cron). Each
// reminder goes once per person, whichever hour it first qualifies.

function london(d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false })
    .formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}
function addDays(iso: string, n: number) {
  const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
const niceDate = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

async function sendEach(profiles: string[], keyFor: (p: string) => string, message: { title: string; body: string; url: string; tag: string }) {
  const fresh: string[] = [];
  for (const p of profiles) if (await firstTime(keyFor(p))) fresh.push(p);
  return fresh.length ? await send(fresh, message) : { sent: 0 };
}

async function forecast(lat: number, lng: number, date: string, hour: number) {
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=temperature_2m,precipitation_probability,wind_speed_10m&wind_speed_unit=mph&timezone=Europe%2FLondon&start_date=${date}&end_date=${date}`);
    if (!res.ok) return "";
    const h = (await res.json()).hourly;
    const i = h.time.findIndex((t: string) => Number(t.slice(11, 13)) === hour);
    if (i < 0) return "";
    const slice = (a: number[]) => a.slice(i, i + 5);
    return ` Forecast: ${Math.round(h.temperature_2m[i])}°C, ${Math.max(...slice(h.precipitation_probability))}% chance of rain, wind ${Math.round(Math.max(...slice(h.wind_speed_10m)))} mph.`;
  } catch (_) { return ""; }
}

async function reminders() {
  const now = london();
  const done: Record<string, unknown> = {};
  const { data: ls } = await admin.from("league_settings").select("close_days").maybeSingle();
  const closeDays = ls?.close_days ?? 7;
  const { data: events } = await admin.from("events").select("id, name, venue, event_date, tee_time, cost, hidden").eq("hidden", false).gte("event_date", now.date).lte("event_date", addDays(now.date, closeDays + 3));
  const { data: approved } = await admin.from("memberships").select("profile_id").eq("status", "approved");
  const members = (approved ?? []).map((m) => m.profile_id);
  for (const ev of events ?? []) {
    const url = `${SITE}/app/#/round/${ev.id}`;
    // 1. Entries close in two days: members who haven't entered.
    const closes = addDays(ev.event_date, -closeDays);
    if (now.hour >= 10 && now.date === addDays(closes, -2)) {
      const entered = new Set(await roundProfiles(ev.id));
      done[`close:${ev.name}`] = await sendEach(members.filter((p) => !entered.has(p)), (p) => `remind-close:${ev.id}:${p}`, {
        title: `Entries for ${ev.name} close soon`, body: `${ev.venue ?? "The round"} on ${niceDate(ev.event_date)}. Entries close ${niceDate(closes)} — register on the website.`,
        url: `${SITE}/fixtures.html`, tag: `close-${ev.id}`,
      });
    }
    // 2. Two days before: anyone on the round who hasn't paid.
    if (now.hour >= 10 && now.date === addDays(ev.event_date, -2) && Number(ev.cost) > 0) {
      const { data: unpaid } = await admin.from("attendance").select("profile_id").eq("event_id", ev.id).eq("status", "playing").eq("payment_status", "unpaid");
      const ids = (unpaid ?? []).map((a) => a.profile_id).filter(Boolean) as string[];
      done[`unpaid:${ev.name}`] = await sendEach(ids, (p) => `remind-unpaid:${ev.id}:${p}`, {
        title: `${ev.name}: payment due`, body: `You're down to play on ${niceDate(ev.event_date)} but we haven't got your £${Number(ev.cost).toFixed(2).replace(/\.00$/, "")} yet. Tap to see how to pay.`,
        url: `${SITE}/fixtures.html`, tag: `unpaid-${ev.id}`,
      });
    }
    // 3. 6pm the day before: your group, tee time and the forecast.
    if (now.hour >= 18 && now.date === addDays(ev.event_date, -1)) {
      const players = await roundProfiles(ev.id);
      const { data: g } = await admin.from("groupings").select("group_number, profile_id, player_id").eq("event_id", ev.id).eq("group_type", "fours");
      const { data: pl } = await admin.from("players").select("id, profile_id");
      const groupOf = new Map<string, number>();
      (g ?? []).forEach((x) => { const prof = x.profile_id ?? (pl ?? []).find((p) => p.id === x.player_id)?.profile_id; if (prof) groupOf.set(prof, x.group_number); });
      const { data: setup } = await admin.from("event_scoring").select("tee_id, tee_interval").eq("event_id", ev.id).maybeSingle();
      let where = "";
      if (setup?.tee_id) {
        const { data: tee } = await admin.from("course_tees").select("courses(lat, lng)").eq("id", setup.tee_id).maybeSingle();
        const c = (tee as { courses?: { lat: number | null; lng: number | null } } | null)?.courses;
        if (c?.lat != null && c?.lng != null) where = await forecast(c.lat, c.lng, ev.event_date, Number(String(ev.tee_time ?? "10").slice(0, 2)));
      }
      const teeTime = (n?: number) => {
        if (!ev.tee_time) return "";
        if (n == null || !setup?.tee_interval) return n === 1 || n == null ? ev.tee_time.slice(0, 5) : "";
        const [h, m] = ev.tee_time.split(":").map(Number); const mins = h * 60 + m + (n - 1) * setup.tee_interval;
        return `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
      };
      let sent = 0;
      for (const p of players) {
        if (!(await firstTime(`remind-daybefore:${ev.id}:${p}`))) continue;
        const n = groupOf.get(p);
        const t = teeTime(n);
        const r = await send([p], {
          title: `Tomorrow: ${ev.name}`,
          body: `${ev.venue ?? ""}${n ? ` · Group ${n}` : ""}${t ? ` · tee time ${t}` : ev.tee_time ? ` · first tee ${ev.tee_time.slice(0, 5)}` : ""}.${where}`,
          url, tag: `daybefore-${ev.id}`,
        });
        sent += r.sent ?? 0;
      }
      done[`daybefore:${ev.name}`] = { sent };
    }
  }
  return { at: now, done };
}

// Write down that this one's gone. False if it already had.
async function firstTime(key: string): Promise<boolean> {
  const { error } = await admin.from("push_sent").insert({ key });
  return !error;
}

async function keys(): Promise<{ public_key: string; private_key: string }> {
  const { data } = await admin.from("push_config").select("public_key, private_key").eq("id", true).maybeSingle();
  if (data) return data;
  const k = webpush.generateVAPIDKeys();
  // If two calls race, the first one in wins and both use it.
  await admin.from("push_config").insert({ id: true, public_key: k.publicKey, private_key: k.privateKey });
  const { data: again } = await admin.from("push_config").select("public_key, private_key").eq("id", true).single();
  return again!;
}

Deno.serve(async (req) => {
  try {
    const k = await keys();
    webpush.setVapidDetails("mailto:" + (Deno.env.get("ALERTS_TO") ?? "committee@thefalknersarmsgolfsociety.co.uk"), k.public_key, k.private_key);

    const { type, event_id, player_id, hole } = await req.json().catch(() => ({}));
    if (type === "init") return json({ ready: true });
    if (type === "reminders") return json(await reminders());
    if (!UUID.test(String(event_id))) return json({ ignored: "bad event" });

    const { data: ev } = await admin.from("events").select("name, venue").eq("id", event_id).maybeSingle();
    const { data: setup } = await admin.from("event_scoring").select("status").eq("event_id", event_id).maybeSingle();
    if (!ev || !setup) return json({ ignored: "no round" });
    const roundUrl = `${SITE}/app/#/round/${event_id}`;

    if (type === "published") {
      if (setup.status !== "live") return json({ ignored: "not live" });
      if (!(await firstTime(`published:${event_id}`))) return json({ ignored: "already sent" });
      return json(await send(await roundProfiles(event_id), {
        title: `${ev.name} is live`, body: `Scoring's open${ev.venue ? " at " + ev.venue : ""}. Tap to start your card.`,
        url: roundUrl + "/start", tag: `published-${event_id}`,
      }));
    }

    if (type === "final") {
      if (setup.status !== "final") return json({ ignored: "not final" });
      if (!(await firstTime(`final:${event_id}`))) return json({ ignored: "already sent" });
      return json(await send(await roundProfiles(event_id), {
        title: `${ev.name}: results are in`, body: "Tap to see the final leaderboard.",
        url: roundUrl, tag: `final-${event_id}`,
      }));
    }

    if (type === "dispute") {
      const h = Number(hole);
      if (!UUID.test(String(player_id)) || !(h >= 1 && h <= 18)) return json({ ignored: "bad score" });
      const { data: hs } = await admin.from("hole_scores").select("disputed, updated_at").eq("event_id", event_id).eq("player_id", player_id).eq("hole", h).maybeSingle();
      if (!hs?.disputed) return json({ ignored: "not disputed" });
      if (!(await firstTime(`dispute:${event_id}:${player_id}:${h}:${hs.updated_at}`))) return json({ ignored: "already sent" });
      const { data: p } = await admin.from("players").select("name").eq("id", player_id).maybeSingle();
      return json(await send(await groupProfiles(event_id, player_id, h), {
        title: `Disputed score — hole ${h}`, body: `Two phones disagree on ${p?.name ?? "a player"}'s ${h}. Agree it before the card goes in.`,
        url: roundUrl, tag: `dispute-${event_id}-${player_id}-${h}`,
      }));
    }

    return json({ ignored: String(type) });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) });
  }
});
