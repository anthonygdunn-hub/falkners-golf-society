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

   // One line describing where a person stands.
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
           .from("event_payments")
           .select("amount_paid, events(name, event_date, cost)");

      if (error) { host.innerHTML = ""; return; }
         if (!rows || !rows.length) { host.innerHTML = ""; return; }

      const cards = rows
           .filter(r => r.events)
           .sort((a, b) => (a.events.event_date || "").localeCompare(b.events.event_date || ""))
           .map(r => {
                     const cost = Number(r.events.cost) || 0;
                     const paid = Number(r.amount_paid) || 0;
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
           .from("event_payments").select("event_id, player_id, amount_paid, players(name)");

      if (error) {
              host.innerHTML = '<div class="empty-state">Could not load payments just now.</div>';
              return;
      }

      const { data: att } = await client.from("attendance").select("event_id, player_id, profile_id");
         const { data: plyrs } = await client.from("players").select("id, name, profile_id");

      const withPayments = events.filter(ev => (payments || []).some(p => p.event_id === ev.id)); if (!withPayments.length) { host.innerHTML = ''; return; } const blocks = withPayments.map(ev => {
              const cost = Number(ev.cost) || 0;
              const mine = (payments || []).filter(p => p.event_id === ev.id);
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
                                          "<td>" + escapeHtml(s.label) + "</td></tr>";
                }).join("");

                                      const owingRows = owing.map(pl =>
                                                "<tr><td>" + escapeHtml(pl.name) + '</td><td class="num">' + money(0) + "</td>" +
                                                '<td class="num">' + money(cost) + "</td><td>Registered, nothing paid</td></tr>").join("");

                                      return '<div class="scorecard" style="margin-top:24px;">' +
                                                '<div class="scorecard-head"><h3>' + escapeHtml(ev.name) + "</h3>" +
                                                '<span class="meta">' + money(cost) + " per player</span></div>" +
                                                '<div style="padding:16px;">' +
                                                '<p class="small" style="margin-top:0;">' +
                                                "Collected " + money(paidTotal) + " &middot; " + inFull + " paid in full &middot; " +
                                                partial + " on deposit &middot; " + owing.length + " yet to pay" +
                                                "</p>" +
                                                '<div style="overflow-x:auto;"><table class="score-table"><thead><tr><th>Player</th>' +
                                                '<th class="num">Paid</th><th class="num">Owing</th><th>Status</th></tr></thead>' +
                                                "<tbody>" + rows + owingRows + "</tbody></table></div></div></div>";
      }).join("");

      host.innerHTML = blocks;
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
