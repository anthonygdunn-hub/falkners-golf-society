// ------------------------------------------------------------------
// Starts a card / Apple Pay / Google Pay payment for a round (Stripe).
//
// Called from the website or the app by a signed-in member with
// { event_id, choice: "golf" | "golf_food" | "food", return_url }.
// The amount is never taken from the call: card_quote() works it out
// in the database as that member, and this only sends them to Stripe's
// own checkout page for exactly that. The stripe-webhook function marks
// it paid when Stripe says so.
//
// Secrets: STRIPE_SECRET_KEY. Deploy with "Verify JWT" on.
// ------------------------------------------------------------------

import { createClient } from "npm:@supabase/supabase-js@2";

const SITES = ["https://www.thefalknersarmsgolfsociety.co.uk", "https://thefalknersarmsgolfsociety.co.uk"];
const URL_ = Deno.env.get("SUPABASE_URL") ?? "";
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const CHOICE_NAMES: Record<string, string> = { golf: "golf", golf_food: "golf + food", food: "food" };

function safeReturn(raw: unknown): string {
  try {
    const u = new URL(String(raw));
    if (SITES.includes(u.origin)) { u.searchParams.delete("card"); return u.toString(); }
  } catch { /* fall through */ }
  return SITES[0] + "/fixtures.html";
}
const withParam = (url: string, value: string) => {
  const u = new URL(url); u.searchParams.set("card", value);
  // Keep the app's #/route at the end.
  return u.toString();
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const jwt = auth.replace(/^Bearer\s+/i, "");
    const { data: who } = await admin.auth.getUser(jwt);
    const user = who?.user;
    if (!user || user.is_anonymous) return reply({ error: "Sign in first." }, 401);

    const { event_id, choice, return_url } = await req.json().catch(() => ({}));
    if (!/^[0-9a-f-]{36}$/i.test(String(event_id))) return reply({ error: "Bad round." }, 400);
    if (!CHOICE_NAMES[choice]) return reply({ error: "Choose what you're paying for." }, 400);

    const key = Deno.env.get("STRIPE_SECRET_KEY");
    if (!key) return reply({ error: "Card payments aren't switched on yet. Pay by bank transfer for now." }, 503);

    // The quote, worked out as this member.
    const asUser = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false }, global: { headers: { Authorization: auth } },
    });
    const { data: quote, error: qErr } = await asUser.rpc("card_quote", { p_event: event_id });
    if (qErr) return reply({ error: qErr.message }, 400);
    if (!quote?.enabled) return reply({ error: "Card payments aren't switched on yet. Pay by bank transfer for now." }, 503);
    const opt = quote.options?.[choice];
    if (!opt) return reply({ error: "There's nothing left to pay for that." }, 400);

    const { data: row, error: insErr } = await admin.from("card_payments").insert({
      event_id, profile_id: user.id, choice, lines: opt.lines,
      base_pence: opt.base_pence, fee_pence: opt.fee_pence, total_pence: opt.total_pence,
    }).select("id").single();
    if (insErr) throw insErr;

    const back = safeReturn(return_url);
    const f = new URLSearchParams();
    f.set("mode", "payment");
    f.set("success_url", withParam(back, "done"));
    f.set("cancel_url", withParam(back, "cancel"));
    f.set("client_reference_id", row.id);
    f.set("metadata[card_payment_id]", row.id);
    f.set("payment_intent_data[metadata][card_payment_id]", row.id);
    f.set("payment_intent_data[description]", `${quote.round} – ${CHOICE_NAMES[choice]}`);
    if (user.email) f.set("customer_email", user.email);
    let i = 0;
    const add = (name: string, pence: number) => {
      f.set(`line_items[${i}][quantity]`, "1");
      f.set(`line_items[${i}][price_data][currency]`, "gbp");
      f.set(`line_items[${i}][price_data][unit_amount]`, String(pence));
      f.set(`line_items[${i}][price_data][product_data][name]`, name);
      i++;
    };
    for (const l of opt.lines) {
      const who = l.name === "You" ? "" : ` (${l.name})`;
      if (l.golf_pence > 0) add(`${quote.round} – golf${who}`, l.golf_pence);
      if (l.food_pence > 0) add(`${quote.round} – food${who}`, l.food_pence);
    }
    add("Card fee", opt.fee_pence);

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": row.id },
      body: f,
    });
    const session = await res.json();
    if (!res.ok) {
      console.error("stripe", session?.error?.message);
      await admin.from("card_payments").update({ status: "expired" }).eq("id", row.id);
      return reply({ error: "Couldn't start the card payment. Try again, or pay by bank transfer." }, 502);
    }
    if (session.amount_total !== opt.total_pence) {
      console.error("amount mismatch", session.amount_total, opt.total_pence);
      return reply({ error: "Couldn't start the card payment. Try again, or pay by bank transfer." }, 502);
    }
    await admin.from("card_payments").update({ stripe_session_id: session.id }).eq("id", row.id);
    return reply({ url: session.url });
  } catch (e) {
    console.error(e);
    return reply({ error: "Something went wrong. Try again, or pay by bank transfer." }, 500);
  }
});
