// ------------------------------------------------------------------
// Emails a friend their invite to a member's private game: a link to
// the app and a one-off 6-digit code.
//
// Called from the app by the game's organiser with { invite_id }. The
// caller's login is checked, the invite must be theirs (or they're on
// the committee), and the email only ever goes to the address on the
// invite with the society's own wording - nothing in the call is used
// as content.
//
// RESEND_API_KEY (and optionally ALERTS_FROM) are the same secrets the
// member-alerts function already uses. Deploy with "Verify JWT" on.
// ------------------------------------------------------------------

import { createClient } from "npm:@supabase/supabase-js@2";

const SITE = "https://www.thefalknersarmsgolfsociety.co.uk";
const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (v: unknown) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: who } = await admin.auth.getUser(jwt);
    const user = who?.user;
    if (!user || user.is_anonymous) return reply({ error: "Sign in first." }, 401);

    const { invite_id } = await req.json().catch(() => ({}));
    if (!/^[0-9a-f-]{36}$/i.test(String(invite_id))) return reply({ error: "Bad invite." }, 400);
    const { data: inv } = await admin.from("guest_invites").select("id, token, code, email, created_by, expires_at, used_at, player_id, event_id").eq("id", invite_id).maybeSingle();
    if (!inv) return reply({ error: "That invite doesn't exist." }, 404);
    if (inv.created_by !== user.id) {
      const { data: m } = await admin.from("memberships").select("role, status").eq("profile_id", user.id).maybeSingle();
      if (!(m?.status === "approved" && m?.role === "committee")) return reply({ error: "That isn't your invite." }, 403);
    }
    if (!inv.email) return reply({ error: "No email on this invite." }, 400);
    if (new Date(inv.expires_at) < new Date()) return reply({ error: "That invite has expired." }, 400);

    const [{ data: ev }, { data: pl }, { data: org }] = await Promise.all([
      admin.from("events").select("name, venue, event_date").eq("id", inv.event_id).maybeSingle(),
      admin.from("players").select("name").eq("id", inv.player_id).maybeSingle(),
      admin.from("profiles").select("display_name").eq("id", inv.created_by).maybeSingle(),
    ]);
    const link = `${SITE}/app/#/join/${inv.token}`;
    const day = ev?.event_date ? new Date(ev.event_date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }) : "";
    const organiser = org?.display_name ?? "A member";
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#17233b">
        <div style="background:#0f2240;color:#fff;padding:18px 22px;border-bottom:3px solid #b8923c">
          <div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#d9be7c">The Falkners Arms Golf Society</div>
          <div style="font-size:22px;font-weight:bold;margin-top:4px">You're invited to score</div>
        </div>
        <div style="padding:22px;background:#fff;border:1px solid #e1e6ee;border-top:0">
          <p>Hi ${esc(pl?.name ?? "")},</p>
          <p>${esc(organiser)} has added you to <b>${esc(ev?.name ?? "a private game")}</b>${ev?.venue ? ` at ${esc(ev.venue)}` : ""}${day ? ` on ${esc(day)}` : ""}. You can keep your own score on your phone, no account needed.</p>
          <p style="margin:22px 0;text-align:center"><a href="${link}" style="background:#b8923c;color:#0f2240;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px;display:inline-block">Open the scorecard</a></p>
          <p>Then enter this email address and your code:</p>
          <p style="font-size:30px;letter-spacing:.3em;font-weight:bold;text-align:center;margin:10px 0 20px">${esc(inv.code)}</p>
          <p style="font-size:13px;color:#57617a">The code works for this game only, until the end of the day it's played. Your email address is deleted after the game.</p>
        </div>
      </div>`;

    const key = Deno.env.get("RESEND_API_KEY");
    if (!key) return reply({ error: "Email isn't set up." }, 500);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: Deno.env.get("ALERTS_FROM") ?? "Falkners Arms Golf Society <alerts@thefalknersarmsgolfsociety.co.uk>",
        to: [inv.email],
        subject: `${organiser} has invited you to ${ev?.name ?? "a game"}`,
        html,
        text: `${organiser} has added you to ${ev?.name ?? "a private game"}${ev?.venue ? " at " + ev.venue : ""}${day ? " on " + day : ""}.\n\nOpen: ${link}\nYour code: ${inv.code}\n\nThe code works for this game only, until the end of the day it's played.`,
      }),
    });
    if (!res.ok) { console.error("Resend", res.status, await res.text()); return reply({ error: "The email didn't send. Share the code instead." }, 502); }
    return reply({ sent: true });
  } catch (err) {
    console.error(err);
    return reply({ error: "Something went wrong." }, 500);
  }
});
