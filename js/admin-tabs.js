/* Tabs for the committee admin page. The page had grown to fourteen
   cards in one long scroll, so finding anything meant hunting. This
   groups them into four tabs in the order the work actually happens.

   Deliberately done by moving the existing cards in the browser rather
   than rewriting admin.html: every card keeps its id and its wiring,
   and if this script ever fails to load you simply get the old long
   page back. Nothing here writes to the database. */

(function () {
    "use strict";
    if (window.__fgsAdminTabs) return;
    window.__fgsAdminTabs = true;
    var STORE_KEY = "fgs-admin-tab";
    var TABS = [
      { id: "requests", label: "Requests", headings: ["Pending member requests"] }, { id: "results", label: "Results", headings: ["Enter results", "Round prizes", "Order of Merit"] },
      { id: "fixtures", label: "Fixtures", headings: ["Edit a fixture", "Add a fixture", "Who's playing", "Tee groups", "Pairs"] },
      { id: "ryder", label: "Ryder Cup", headings: ["Ryder Cup 2027"] }, { id: "money", label: "Money", headings: ["Payments", "Hole in one pot"] },
      { id: "people", label: "People", headings: ["Add a player", "Link member accounts to players", "Photos awaiting approval"] }
        ];

   function cardForHeading(text) {
         var heads = Array.prototype.slice.call(document.querySelectorAll(".admin-shell h3"));
         for (var i = 0; i < heads.length; i++) {
                 if (heads[i].textContent.trim().toLowerCase() === text.toLowerCase()) var scoped = heads[i].closest("#trip-payment-breakdown"); return scoped || heads[i].closest(".card, .scorecard");
         }
         return null;
   }

   function pendingCount(card) {
         if (!card) return 0;
         return card.querySelectorAll("[data-approve], [data-photo-approve]").length;
   }

   function build() {
         var shell = document.querySelector(".admin-shell");
         var dashboard = document.getElementById("dashboard");
         if (!shell || !dashboard) return false;
         if (document.getElementById("admin-tabbar")) return true;

      var found = 0;
         TABS.forEach(function (t) {
                 t.cards = t.headings.map(cardForHeading).filter(Boolean);
                 found += t.cards.length;
         });
         if (found < 4) return false;

      var bar = document.createElement("div");
         bar.id = "admin-tabbar";
         bar.className = "fixtures-actions";
         bar.style.cssText = "flex-wrap:wrap; gap:8px; margin:0 0 20px 0;";

      var panels = document.createElement("div");
         panels.id = "admin-tab-panels";

      TABS.forEach(function (t) {
              t.panel = document.createElement("div");
              t.panel.id = "admin-panel-" + t.id;
              t.cards.forEach(function (card) { t.panel.appendChild(card); });
              panels.appendChild(t.panel);
              t.button = document.createElement("button");
              t.button.type = "button";
              t.button.setAttribute("data-tab", t.id);
              bar.appendChild(t.button);
      });

      var anchor = document.querySelector(".admin-shell .card, .admin-shell .scorecard") || dashboard.firstChild;
         if (anchor && anchor.parentNode) {
                 anchor.parentNode.insertBefore(bar, anchor);
                 anchor.parentNode.insertBefore(panels, anchor);
         } else {
                 dashboard.appendChild(bar);
                 dashboard.appendChild(panels);
         }

      function show(id) {
              TABS.forEach(function (t) {
                        var on = t.id === id;
                        t.panel.style.display = on ? "" : "none";
                        t.button.className = on ? "btn btn-brass" : "btn btn-outline";
                        t.button.setAttribute("aria-pressed", on ? "true" : "false");
              });
              try { localStorage.setItem(STORE_KEY, id); } catch (e) {}
      }

      function relabel() {
              TABS.forEach(function (t) {
                        var waiting = t.cards.reduce(function (n, c) { return n + pendingCount(c); }, 0);
                        t.button.textContent = waiting ? t.label + " (" + waiting + ")" : t.label;
              });
      }

      relabel();

      bar.addEventListener("click", function (e) {
              var btn = e.target.closest("[data-tab]");
              if (!btn) return;
              show(btn.getAttribute("data-tab"));
              window.scrollTo({ top: 0, behavior: "smooth" });
      });

      var saved = null;
         try { saved = localStorage.getItem(STORE_KEY); } catch (e) {}
         var valid = false;
         TABS.forEach(function (t) { if (t.id === saved) valid = true; });
         show(valid ? saved : "results");

      var ticks = 0;
         var timer = setInterval(function () { var missing = false; TABS.forEach(function (t) { t.headings.forEach(function (h) { var c = cardForHeading(h); if (c && !t.panel.contains(c)) missing = true; }); }); if (missing) { TABS.forEach(function (t) { t.cards = []; t.headings.forEach(function (h) { var c = cardForHeading(h); if (c) { t.panel.appendChild(c); t.cards.push(c); } }); }); TABS.forEach(function (t) { if (t.button.getAttribute("aria-pressed") !== "true") t.panel.style.display = "none"; }); } relabel(); if (++ticks > 20) clearInterval(timer); }, 1000);
         return true;
   }

   function start() {
         if (build()) return;
         var tries = 0;
         var timer = setInterval(function () { if (build() || ++tries > 40) clearInterval(timer); }, 500);
   }

   if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", start); } else { start(); }
})();
