/* Trip payments - the Ryder Cup and anything else with a per-head cost.

   Two views from one file:
     - My Account  shows the signed-in member their own balance only
     - Admin       shows the committee the full breakdown

   Privacy is enforced in the database, not here. event_payments has row
   level security: a member can only read the row whose player record is
   linked to their login, while the committee can read them all. So a
   member calling this from the console still sees only their own figure.

   The cost per head comes from events.cost, so changing the price in the
   admin fixture form updates every balance automatically. */

(function () {
    "use strict";

   function money(n) {
         const v = Number(n) || 0;
         return "\u00a3" + v.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
   }

   function escapeHtml(s) {
         if (s == null) return "";
         return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
   }

   function addCell(playerId, eventId) { const key = playerId + "|" + eventId; return '<td style="white-space:nowrap;"><input type="number" min="0" step="1" placeholder="0" aria-label="Amount paid" data-amt="' + key + '" style="width:80px; padding:4px 6px;"> <button type="button" class="btn btn-outline" data-add="' + key + '" style="padding:4px 10px;">Add</button></td>'; } // One line describing where a person stands.
   function statusFor(paid, cost) {
         if (!cost) return { label: "Paid " + money(paid), tone: "" };
         if (paid <= 0) return { label: "Nothing paid yet - " + money(cost) + " due", tone: "err" };
         if (paid >= cost) return { label: "Paid in full", tone: "ok" };
         return { label: money(paid) + " paid - " + money(cost - paid) + " remaining", tone: "" };
   }

   // ---- My Account: the member's own balance --------------------------
   async function renderMine(client, session) {
         const host = document.getElementById("my-trip-payments");
         if (!host || !session) return;

      const { data: rows, error } = await client
           .from("payment_entries")
           .select("amount, paid_on, note, events(name, event_date, cost)");

      if (error) { host.innerHTML = ""; return; }
         if (!rows || !rows.length) { host.innerHTML = ""; return; }

      const byTrip = {}; rows .forEach(r => { const k = r.events.name; if (!byTrip[k]) byTrip[k] = { events: r.events, amount_paid: 0, history: [] }; byTrip[k].amount_paid += Number(r.amount) || 0; byTrip[k].history.push(r); }); const cards = Object.values(byTrip)
            
           .sort((a, b) => (a.events.event_date || "").localeCompare(b.events.event_date || ""))
           .map(r => {
                     const cost = Number(r.events.cost) || 0;
                     const paid = Number(r.amount_paid) || 0; const hist = (r.history || []).length > 1 ? '<br><span class="small" style="opacity:.7;">' + r.history.length + ' payments' + '</span>' : '';
                     const s = statusFor(paid, cost);
                     return '<li class="fixture-item"><div style="padding:14px 16px;"><strong>' +
                                 escapeHtml(r.events.name) + '</strong><br><span class="small">' +
                                 escapeHtml(s.label) + (cost ? " of " + money(cost) : "") + "</span></div></li>";
           }).join("");

      host.innerHTML = cards
           ? '<div class="scorecard" style="margin-top:24px;"><div class="scorecard-head"><h3>My trip payments</h3></div>' +
                '<ul class="fixture-list" style="margin:0;">' + cards + "</ul></div>"
              : "";
   }

   // ---- Admin: the full breakdown for the committee --------------------
   async function renderAdmin(client) {
         const host = document.getElementById("trip-payment-breakdown");
         if (!host) return;

      const { data: events } = await client
           .from("events").select("id, name, event_date, cost")
           .not("cost", "is", null).gt("cost", 0).order("event_date");

      if (!events || !events.length) {
              host.innerHTML = '<div class="empty-state">No fixtures with a cost set.</div>';
              return;
      }

      const { data: payments, error } = await client
           .from("payment_entries").select("event_id, player_id, amount, paid_on, note, players(name)");

      if (error) {
              host.innerHTML = '<div class="empty-state">Could not load payments just now.</div>';
              return;
      }

      const { data: att } = await client.from("attendance").select("event_id, player_id, profile_id");
         const { data: plyrs } = await client.from("players").select("id, name, profile_id");

      const withPayments = events.filter(ev => (payments || []).some(p => p.event_id === ev.id)); if (!withPayments.length) { host.innerHTML = ''; return; } const blocks = withPayments.map(ev => {
              const cost = Number(ev.cost) || 0;
              const grouped = {}; (payments || []).filter(p => p.event_id === ev.id).forEach(p => { const k = p.player_id; if (!grouped[k]) grouped[k] = { player_id: k, players: p.players, amount_paid: 0, entries: [] }; grouped[k].amount_paid += Number(p.amount) || 0; grouped[k].entries.push(p); }); const mine = Object.values(grouped);
              const paidTotal = mine.reduce((s, p) => s + (Number(p.amount_paid) || 0), 0);
              const inFull = mine.filter(p => Number(p.amount_paid) >= cost).length;
              const partial = mine.filter(p => Number(p.amount_paid) > 0 && Number(p.amount_paid) < cost).length;

                                      // Anyone registered to play but with no payment row at all.
                                      const paidIds = new Set(mine.map(p => p.player_id));
              const owing = (att || []).filter(a => a.event_id === ev.id).map(a => {
                        let pl = a.player_id ? (plyrs || []).find(p => p.id === a.player_id) : null;
                        if (!pl && a.profile_id) pl = (plyrs || []).find(p => p.profile_id === a.profile_id);
                        return pl;
              }).filter(pl => pl && !paidIds.has(pl.id));

                                      const rows = mine
                .sort((a, b) => Number(b.amount_paid) - Number(a.amount_paid) ||
                            String(a.players?.name).localeCompare(String(b.players?.name)))
                .map(p => {
                            const paid = Number(p.amount_paid) || 0;
                            const s = statusFor(paid, cost);
                            return "<tr><td>" + escapeHtml(p.players?.name || "Unknown") + "</td>" +
                                          '<td class="num">' + money(paid) + "</td>" +
                                          '<td class="num">' + (cost > paid ? money(cost - paid) : "&ndash;") + "</td>" +
                                          "<td>" + escapeHtml(s.label) + "</td>" + addCell(p.player_id, ev.id) + "</tr>";
                }).join("");

                                      const owingRows = owing.map(pl =>
                                                "<tr><td>" + escapeHtml(pl.name) + '</td><td class="num">' + money(0) + "</td>" +
                                                '<td class="num">' + money(cost) + "</td><td>Registered, nothing paid</td>" + addCell(pl.id, ev.id) + "</tr>").join("");

                                      return '<div class="scorecard" style="margin-top:24px;">' +
                                                '<div class="scorecard-head"><h3>' + escapeHtml(ev.name) + "</h3>" +
                                                '<span class="meta">' + money(cost) + " per player</span></div>" +
                                                '<div style="padding:16px;">' +
                                                '<p class="small" style="margin-top:0;">' +
                                                "Collected " + money(paidTotal) + " &middot; " + inFull + " paid in full &middot; " +
                                                partial + " on deposit &middot; " + owing.length + " yet to pay" +
                                                "</p>" +
                                                '<div style="overflow-x:auto;"><table class="score-table"><thead><tr><th>Player</th>' +
                                                '<th class="num">Paid</th><th class="num">Owing</th><th>Status</th><th>Add payment</th></tr></thead>' +
                                                "<tbody>" + rows + owingRows + "</tbody></table></div></div></div>";
      }).join("");

      host.innerHTML = blocks; if (!host.dataset.wired) { host.dataset.wired = "1"; host.addEventListener("click", async (e) => { const btn = e.target.closest("[data-add]"); if (!btn) return; const key = btn.getAttribute("data-add"); const parts = key.split("|"); const box = host.querySelector('[data-amt="' + key + '"]'); const amount = Number(box && box.value); if (!amount || amount <= 0) { if (box) box.focus(); return; } btn.disabled = true; btn.textContent = "Saving"; const s = await client.auth.getSession(); const uid = s && s.data && s.data.session ? s.data.session.user.id : null; const res = await client.from("payment_entries").insert({ event_id: parts[1], player_id: parts[0], amount: amount, recorded_by: uid }); if (res.error) { btn.disabled = false; btn.textContent = "Add"; alert("Could not save that payment: " + res.error.message); return; } await renderAdmin(client); }); }
   }

   async function start() {
         if (!window.supabase || typeof SUPABASE_URL === "undefined") return;
         const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
         const { data: { session } } = await client.auth.getSession();
         if (!session) return;
         await renderMine(client, session);
         await renderAdmin(client);
   }

   if (document.readyState === "loading") {
         document.addEventListener("DOMContentLoaded", start);
   } else {
         start();
   }
})();
