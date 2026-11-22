// ------------------------------------------------------------------
// Pay for a round by card, Apple Pay or Google Pay (Stripe Checkout).
// Shared by the website (fixtures) and the app (round page).
//
//   renderCardPay(client, container, eventId, { returnUrl })
//
// Asks the database what this member owes (card_quote): golf only,
// golf + food, or food only, each with the card fee added. They pick
// one and go to Stripe's checkout page; when they come back with
// ?card=done the payment is confirmed by Stripe's webhook a moment
// later (cardPayReturn handles the message and the refresh).
//
// Nothing shows unless the committee has switched card payments on.
// ------------------------------------------------------------------
(function () {
  const LABEL = { golf: "Golf only", golf_food: "Golf + food", food: "Food only" };
  const ORDER = ["golf", "golf_food", "food"];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = p => "£" + (p / 100).toFixed(2);

  function describe(key, opt, q) {
    const people = opt.lines.length;
    const golf = opt.lines.filter(l => l.golf_pence > 0).length;
    const food = opt.lines.filter(l => l.food_pence > 0).length;
    const bits = [];
    if (golf) bits.push(`golf ${money(q.golf_each_pence)}${golf > 1 ? " × " + golf : ""}`);
    if (food) bits.push(`food ${money(q.food_each_pence)}${food > 1 ? " × " + food : ""}`);
    const who = people > 1 ? ` for you and ${people - 1} ${people === 2 ? "guest" : "guests"}` : "";
    return bits.join(" + ") + who;
  }

  async function renderCardPay(client, container, eventId, opts) {
    opts = opts || {};
    if (!container) return;
    const { data: q, error } = opts.quote ? { data: opts.quote, error: null } : await client.rpc("card_quote", { p_event: eventId });
    if (error || !q || !q.enabled || !q.options) return;
    const keys = ORDER.filter(k => q.options[k]);
    if (!keys.length) return;
    const pick = keys[0];
    const id = "cp-" + eventId.slice(0, 8);

    const box = document.createElement("div");
    box.className = "card-pay";
    box.innerHTML = `
      <div class="card-pay-head">
        <strong>Pay by card</strong>
        <span class="card-pay-wallets">Apple Pay · Google Pay · card</span>
      </div>
      ${keys.length > 1 ? `<div class="card-pay-opts" role="radiogroup" aria-label="What are you paying for?">
        ${keys.map(k => `<label class="card-pay-opt">
            <input type="radio" name="${id}" value="${k}"${k === pick ? " checked" : ""}>
            <span class="card-pay-opt-text"><span class="card-pay-opt-name">${LABEL[k]}</span>
              <span class="card-pay-opt-sub">${esc(describe(k, q.options[k], q))}</span></span>
            <span class="card-pay-opt-price">${money(q.options[k].total_pence)}</span>
          </label>`).join("")}
      </div>` : `<p class="card-pay-one">${LABEL[pick]}: ${esc(describe(pick, q.options[pick], q))}</p>`}
      <p class="card-pay-fee" data-cp-fee></p>
      <button class="btn btn-brass card-pay-go" type="button" data-cp-go></button>
      <div class="card-pay-msg" data-cp-msg></div>`;
    container.appendChild(box);

    const go = box.querySelector("[data-cp-go]");
    const fee = box.querySelector("[data-cp-fee]");
    const msg = box.querySelector("[data-cp-msg]");
    const current = () => (box.querySelector("input[type=radio]:checked") || {}).value || pick;
    const sync = () => {
      const o = q.options[current()];
      go.textContent = `Pay ${money(o.total_pence)}`;
      fee.textContent = `Includes a ${money(o.fee_pence)} card fee. Bank transfer is free.`;
    };
    box.querySelectorAll("input[type=radio]").forEach(r => r.addEventListener("change", sync));
    sync();

    go.addEventListener("click", async () => {
      go.disabled = true; msg.textContent = "Opening secure checkout…"; msg.className = "card-pay-msg";
      let url = null, err = null;
      try {
        const res = await client.functions.invoke("card-checkout", {
          body: { event_id: eventId, choice: current(), return_url: opts.returnUrl || location.href },
        });
        url = res.data && res.data.url;
        if (!url) {
          err = (res.data && res.data.error) || null;
          if (!err && res.error && res.error.context && typeof res.error.context.json === "function") {
            err = (await res.error.context.json().catch(() => ({}))).error;
          }
        }
      } catch (e) { err = null; }
      if (url) { location.href = url; return; }
      msg.textContent = err || "Couldn't open the card payment. Try again, or pay by bank transfer.";
      msg.className = "card-pay-msg is-err";
      go.disabled = false;
    });
  }

  // Coming back from Stripe: tell them what happened, tidy the address,
  // and give the webhook a few seconds before refreshing what's shown.
  function cardPayReturn(onRefresh) {
    let state = null;
    try {
      const u = new URL(location.href);
      state = u.searchParams.get("card");
      if (!state) return null;
      u.searchParams.delete("card");
      history.replaceState(null, "", u.pathname + u.search + u.hash);
    } catch (e) { return null; }
    if (state === "done" && typeof onRefresh === "function") {
      [2500, 6000, 12000].forEach(ms => setTimeout(onRefresh, ms));
    }
    return state === "done"
      ? { ok: true, text: "Thanks, your card payment went through. It'll show as paid in a few seconds." }
      : { ok: false, text: "Card payment cancelled. Nothing was taken." };
  }

  window.renderCardPay = renderCardPay;
  window.cardPayReturn = cardPayReturn;
})();
