// ------------------------------------------------------------------
// Committee email alerts for The Falkners Arms Golf Society.
//
// Two jobs, one function:
//
//   1. Instant alerts, fired by a database webhook, for the things that
//      actually need a person to do something — somebody asking to
//      join, somebody saying they've paid for a round, and a group on
//      the course asking the committee to settle a disputed score.
//
//   2. A once-a-day summary of the quieter stuff — who registered to
//      play and who added photos. Near a fixture you can get a dozen
//      registrations in an evening, and a dozen separate emails is how
//      people learn to ignore the alerts entirely.
//
// The Resend API key is read from the function's environment. It is
// never in the repository, and it never reaches the browser.
//
// This copy is the source of the deployed function (version 7 plus the
// disputed-score alert). Deploy it from the Supabase dashboard or CLI.
// ------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Read per call rather than once at start-up, so setting the secret
// after the function is deployed takes effect without a redeploy.
const apiKey = () => Deno.env.get("RESEND_API_KEY");
const fromAddress = () =>
  Deno.env.get("ALERTS_FROM") ??
    "Falkners Arms Golf Society <alerts@thefalknersarmsgolfsociety.co.uk>";

const SITE = "https://www.thefalknersarmsgolfsociety.co.uk";

// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically
// into every Edge Function, so there's nothing to paste for these.
const admin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);

// ---- Sending --------------------------------------------------------

// Who gets the alerts.
async function committeeEmails(): Promise<string[]> {
    const to = Deno.env.get("ALERTS_TO");
      return to ? [to] : [];
      }
async function send(subject: string, html: string) {
  const key = apiKey();
  if (!key) {
    console.error("RESEND_API_KEY is not set — nothing sent.");
    return { skipped: "no api key" };
  }

  const to = await committeeEmails();
  if (!to.length) {
    console.warn("No approved committee members with an email address — nothing sent.");
    return { skipped: "no recipients" };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: fromAddress(), to, subject, html: wrap(html) }),
  });

  const body = await res.text();
  if (!res.ok) console.error("Resend rejected the email:", res.status, body);
  return { status: res.status, recipients: to.length };
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function wrap(inner: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif; font-size:15px; line-height:1.6; color:#171F30;">
    ${inner}
    <p style="margin-top:28px; font-size:13px; color:#57617A;">
      Sent automatically by the society website.
      <a href="${SITE}/admin.html" style="color:#1B3A6C;">Open the committee dashboard</a>.
    </p>
  </div>`;
}

// ---- Instant alerts -------------------------------------------------

async function newMemberRequest(record: Record<string, unknown>) {
  const profileId = record.profile_id as string;

  const { data: profile } = await admin
    .from("profiles").select("display_name").eq("id", profileId).maybeSingle();

  let wants = "";
  if (record.intended_event_id) {
    const { data: event } = await admin
      .from("events").select("name, event_date")
      .eq("id", record.intended_event_id as string).maybeSingle();
    if (event) {
      wants = `<p>They signed up wanting to play in <strong>${esc(event.name)}</strong> (${esc(event.event_date)}).
        Approving them registers them for it automatically.</p>`;
    }
  }

  const name = profile?.display_name || "Somebody";

  return send(
    `New member request — ${name}`,
    `<h2 style="font-size:18px; margin:0 0 12px;">${esc(name)} has asked to join</h2>
     ${wants}
     <p>They can't register for rounds or see the members list until a committee member approves them.</p>
     <p><a href="${SITE}/admin.html" style="background:#B8923C; color:#10233F; padding:11px 20px;
        border-radius:3px; text-decoration:none; font-weight:600; display:inline-block;">Review the request</a></p>`,
  );
}

async function paymentClaimed(record: Record<string, unknown>) {
  const { data: profile } = await admin
    .from("profiles").select("display_name").eq("id", record.profile_id as string).maybeSingle();

  const { data: event } = await admin
    .from("events").select("name, event_date, cost")
    .eq("id", record.event_id as string).maybeSingle();

  const name = profile?.display_name || "A member";
  const cost = event?.cost != null ? `£${Number(event.cost).toFixed(2).replace(/\.00$/, "")}` : "the fee";

  return send(
    `${name} says they've paid for ${event?.name ?? "a round"}`,
    `<h2 style="font-size:18px; margin:0 0 12px;">Payment to check</h2>
     <p><strong>${esc(name)}</strong> has flagged ${esc(cost)} as paid for
        <strong>${esc(event?.name ?? "a round")}</strong>${event?.event_date ? ` (${esc(event.event_date)})` : ""}.</p>
     ${record.payment_reference ? `<p>Their bank reference: <strong>${esc(record.payment_reference)}</strong></p>` : ""}
     <p>Once you can see it in the account, confirm it under Payments so the round's list stays accurate.</p>
     <p><a href="${SITE}/admin.html" style="background:#B8923C; color:#10233F; padding:11px 20px;
        border-radius:3px; text-decoration:none; font-weight:600; display:inline-block;">Confirm the payment</a></p>`,
  );
}

// A group on the course couldn't agree a score and asked the committee.
async function disputeEscalated(record: Record<string, unknown>) {
  const eventId = record.event_id as string;
  const playerId = record.player_id as string;
  const hole = record.hole as number;

  const [{ data: event }, { data: player }, { data: entries }] = await Promise.all([
    admin.from("events").select("name, venue").eq("id", eventId).maybeSingle(),
    admin.from("players").select("name").eq("id", playerId).maybeSingle(),
    admin.from("score_entries").select("strokes, picked_up, entered_by")
      .eq("event_id", eventId).eq("player_id", playerId).eq("hole", hole),
  ]);

  const enteredBy = [...new Set((entries ?? []).map((e) => e.entered_by as string))];
  const { data: people } = enteredBy.length
    ? await admin.from("profiles").select("id, display_name").in("id", enteredBy)
    : { data: [] };
  const nameOf = new Map((people ?? []).map((p) => [String(p.id), String(p.display_name)]));

  const list = (entries ?? []).map((e) =>
    `<li>${esc(nameOf.get(String(e.entered_by)) ?? "Someone")} put <strong>${e.picked_up ? "a pick-up" : esc(e.strokes)}</strong></li>`
  ).join("");

  const who = player?.name ?? "A player";
  const round = event?.name ?? "the round";

  return send(
    `Disputed score — ${who}, hole ${hole}, ${round}`,
    `<h2 style="font-size:18px; margin:0 0 12px;">A group needs the committee</h2>
     <p>They couldn't agree <strong>${esc(who)}</strong>'s score on <strong>hole ${esc(hole)}</strong>
        at ${esc(event?.venue ?? "")} (${esc(round)}).</p>
     <ul style="margin:0 0 12px; padding-left:20px;">${list}</ul>
     <p>The card can't be submitted until it's settled. Open the round in the app, go to Setup → Disputes, and choose the score.</p>
     <p><a href="${SITE}/app/#/round/${esc(eventId)}" style="background:#B8923C; color:#10233F; padding:11px 20px;
        border-radius:3px; text-decoration:none; font-weight:600; display:inline-block;">Settle it in the app</a></p>`,
  );
}

// ---- The daily summary ----------------------------------------------

async function dailyDigest() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [{ data: signups }, { data: photos }] = await Promise.all([
    admin.from("attendance").select("event_id, profile_id, player_id").gte("created_at", since),
    admin.from("photos").select("event_id, uploader_id").gte("created_at", since),
  ]);

  const registrations = signups ?? [];
  const uploads = photos ?? [];

  // Nothing happened? Then nothing gets sent. A daily email that says
  // "no activity" is the fastest way to train people to ignore it.
  if (!registrations.length && !uploads.length) {
    return { skipped: "nothing to report" };
  }

  const eventIds = [...new Set([
    ...registrations.map((r) => r.event_id),
    ...uploads.map((p) => p.event_id),
  ].filter(Boolean))] as string[];

  const { data: events } = eventIds.length
    ? await admin.from("events").select("id, name").in("id", eventIds)
    : { data: [] };
  const eventName = new Map<string, string>(
    (events ?? []).map((e) => [String(e.id), String(e.name)]),
  );

  const byEvent = new Map<string, number>();
  registrations.forEach((r) => {
    const key = eventName.get(String(r.event_id)) ?? "a round";
    byEvent.set(key, (byEvent.get(key) ?? 0) + 1);
  });

  const parts: string[] = [];

  if (registrations.length) {
    parts.push(
      `<h3 style="font-size:15px; margin:20px 0 6px;">Registrations (${registrations.length})</h3>
       <ul style="margin:0; padding-left:20px;">
         ${[...byEvent.entries()].map(([name, count]) =>
           `<li>${esc(name)} — ${count} more player${count === 1 ? "" : "s"}</li>`).join("")}
       </ul>`,
    );
  }

  if (uploads.length) {
    parts.push(
      `<h3 style="font-size:15px; margin:20px 0 6px;">Photos (${uploads.length})</h3>
       <p style="margin:0;">${uploads.length} new photo${uploads.length === 1 ? "" : "s"}
          added to <a href="${SITE}/gallery.html" style="color:#1B3A6C;">the gallery</a>.</p>`,
    );
  }

  return send(
    `Society activity — ${registrations.length} registration${registrations.length === 1 ? "" : "s"}, ${uploads.length} photo${uploads.length === 1 ? "" : "s"}`,
    `<h2 style="font-size:18px; margin:0 0 4px;">The last 24 hours</h2>
     <p style="margin:0; color:#57617A;">Nothing here needs action — it's just so you know what's going on.</p>
     ${parts.join("")}`,
  );
}

// ---- Entry point ----------------------------------------------------

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("mode") === "digest") {
      return json(await dailyDigest());
    }

    const payload = await req.json();
    const { type, table, record, old_record } = payload ?? {};

    if (table === "memberships" && type === "INSERT" && record?.status === "pending") {
      return json(await newMemberRequest(record));
    }

    if (
      table === "attendance" && type === "UPDATE" &&
      record?.payment_status === "claimed" && old_record?.payment_status !== "claimed"
    ) {
      return json(await paymentClaimed(record));
    }

    if (
      table === "hole_scores" && type === "UPDATE" &&
      record?.escalated === true && old_record?.escalated !== true
    ) {
      return json(await disputeEscalated(record));
    }

    // Anything else is a change we deliberately don't email about.
    return json({ ignored: `${type} on ${table}` });
  } catch (err) {
    console.error(err);
    // Always 200: a webhook that errors gets retried, and a retry storm
    // over a formatting bug would be worse than a missed alert.
    return json({ error: String(err) });
  }
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
