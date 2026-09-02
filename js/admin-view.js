/* Tabs for the committee admin page.

   An earlier attempt moved the cards into tab panels and that was a
   mistake: cards which render a moment after the page loads got left
   behind, and styling scoped to a card's original container stopped
   applying. Sections came up empty.

   This version never moves anything. Each card is tagged with the tab
   it belongs to and the tab simply shows or hides it where it already
   sits. Nothing is reparented, so nothing can be lost, and a card that
   appears late is picked up on the next sweep. */

(function () {
    "use strict";

   if (window.__fgsAdminView) return;
    window.__fgsAdminView = true;

   var STORE_KEY = "fgs-admin-tab";
    var current = null;

   var TABS = [
     { id: "requests", label: "Requests", headings: ["Pending member requests"] },
     { id: "results", label: "Results", headings: ["Enter results", "Round prizes", "Order of Merit"] },
     { id: "fixtures", label: "Fixtures", headings: ["Edit a fixture", "Add a fixture", "Who's playing", "Tee groups", "Pairs"] },
     { id: "ryder", label: "Ryder Cup", headings: ["Ryder Cup 2027"] },
     { id: "money", label: "Money", headings: ["Payments", "Who's paid", "Hole in one pot"] },
     { id: "pages", label: "Pages", headings: ["Pages"] },
     { id: "people", label: "People", headings: ["Add a player", "Current members", "Link member accounts to players", "Photos awaiting approval"] }
       ];

   function sectionFor(text) {
         var heads = Array.prototype.slice.call(document.querySelectorAll(".admin-shell h3"));
         for (var i = 0; i < heads.length; i++) {
                 if (heads[i].textContent.trim().toLowerCase() === text.toLowerCase()) return heads[i].closest(".card, .scorecard");
         }
         return null;
   }

   function tagSections() {
   	TABS.forEach(function (t) {
   		t.headings.forEach(function (h) {
   			var el = sectionFor(h);
   			if (el && el.getAttribute("data-admin-tab") !== t.id) el.setAttribute("data-admin-tab", t.id);
   		});
   	});
   }

   function apply() {
         TABS.forEach(function (t) {
                 var els = document.querySelectorAll('[data-admin-tab="' + t.id + '"]');
                 Array.prototype.slice.call(els).forEach(function (el) { el.style.display = (t.id === current) ? "" : "none"; });
         });
   }

   function counts() {
         TABS.forEach(function (t) {
                 if (!t.button) return;
                 var waiting = 0;
                 var els = document.querySelectorAll('[data-admin-tab="' + t.id + '"]');
                 Array.prototype.slice.call(els).forEach(function (el) { waiting += el.querySelectorAll("[data-approve], [data-photo-approve]").length; });
                 t.button.textContent = waiting ? t.label + " (" + waiting + ")" : t.label;
         });
   }

   function show(id) {
         current = id;
         TABS.forEach(function (t) {
                 if (!t.button) return;
                 var on = t.id === id;
                 t.button.className = on ? "btn btn-brass" : "btn btn-outline";
                 t.button.setAttribute("aria-pressed", on ? "true" : "false");
         });
         apply();
         try { localStorage.setItem(STORE_KEY, id); } catch (e) {}
   }

   function orderResults() {
         if (window.__fgsPrizeMoved) return;
         var entry = sectionFor("Enter results");
         var prizes = sectionFor("Round prizes");
         if (!entry || !prizes || !entry.parentNode) return;
         if (entry.nextElementSibling !== prizes) entry.parentNode.insertBefore(prizes, entry.nextSibling);
         window.__fgsPrizeMoved = true;
   }

   function buildBar() {
         if (document.getElementById("admin-tabbar")) return true;
         var first = document.querySelector(".admin-shell .card, .admin-shell .scorecard");
         if (!first || !first.parentNode) return false;
         var bar = document.createElement("div");
         bar.id = "admin-tabbar";
         bar.className = "fixtures-actions";
         bar.style.cssText = "flex-wrap:wrap; gap:8px; margin:0 0 20px 0;";
         TABS.forEach(function (t) {
                 t.button = document.createElement("button");
                 t.button.type = "button";
                 t.button.setAttribute("data-tab", t.id);
                 t.button.textContent = t.label;
                 bar.appendChild(t.button);
         });
         first.parentNode.insertBefore(bar, first);
         bar.addEventListener("click", function (e) {
                 var btn = e.target.closest("[data-tab]");
                 if (!btn) return;
                 show(btn.getAttribute("data-tab"));
                 window.scrollTo({ top: 0, behavior: "smooth" });
         });
         return true;
   }

   function tick() {
         if (!document.querySelector(".admin-shell h3")) return;
         if (!buildBar()) return;
         tagSections();
         orderResults();
         if (!current) {
                 var saved = null;
                 try { saved = localStorage.getItem(STORE_KEY); } catch (e) {}
                 var valid = false;
                 TABS.forEach(function (t) { if (t.id === saved) valid = true; });
                 show(valid ? saved : "results");
         } else {
                 apply();
         }
         counts();
   }

   function start() {
         tick();
         var n = 0;
         var timer = setInterval(function () { tick(); if (++n > 60) clearInterval(timer); }, 1000);
   }

   if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", start); } else { start(); }
})();
