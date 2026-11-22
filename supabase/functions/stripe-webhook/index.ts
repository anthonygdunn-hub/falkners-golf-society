// ------------------------------------------------------------------
// Stripe tells us here when a round payment has gone through.
//
// Every call is checked against Stripe's signature (the webhook signing
// secret), so nobody else can mark a payment as paid. On a completed,
// paid checkout the golf is marked confirmed and the food marked paid
// (apply_card_payment does it once, and checks the amount matches).
//
// Secrets: STRIPE_WEBHOOK_SECRET. Deploy with "Verify JWT" OFF, since
// Stripe can't send a Supabase login; the signature is the check.
// Events to send: checkout.session.completed,
// checkout.session.async_payment_succeeded, checkout.session.expired
// ------------------------------------------------------------------

import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const enc = new TextEncoder();

async function verified(body: string, header: string, secret: string): Promise<boolean> {
  const parts = header.split(",").map(p => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`)));
  const hex = Array.from(mac, b => b.toString(16).padStart(2, "0")).join("");
  return sigs.some(s => {
    if (s.length !== hex.length) return false;
    let d = 0;
    for (let i = 0; i < s.length; i++) d |= s.charCodeAt(i) ^ hex.charCodeAt(i);
    return d === 0;
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return new Response("not configured", { status: 503 });
  const body = await req.text();
  if (!(await verified(body, req.headers.get("Stripe-Signature") ?? "", secret))) {
    return new Response("bad signature", { status: 400 });
  }
  const event = JSON.parse(body);
  const s = event?.data?.object ?? {};
  try {
    if ((event.type === "checkout.session.completed" && s.payment_status === "paid")
        || event.type === "checkout.session.async_payment_succeeded") {
      const { error } = await admin.rpc("apply_card_payment", {
        p_session: s.id, p_amount: s.amount_total, p_intent: s.payment_intent ?? null,
      });
      if (error) { console.error("apply", error.message); return new Response("error", { status: 500 }); }
    } else if (event.type === "checkout.session.expired") {
      await admin.from("card_payments").update({ status: "expired" }).eq("stripe_session_id", s.id).eq("status", "open");
    }
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 });
  }
  return new Response("ok");
});
