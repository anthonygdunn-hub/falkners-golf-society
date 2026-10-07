/* ------------------------------------------------------------------
   Motion for the public site, loaded on every page by js/nav.js.

     homepage     a live countdown to the next round, with a places bar
     leaderboard  rows slide in, the top three medals pop, points count up
     hole in one  the pot rolls up to its total and a ball drops in the cup
     everywhere   sections ease in as they scroll into view

   Purely decorative. Pages render normally without it, nothing waits
   on it, and anyone whose device asks for reduced motion gets the
   finished state straight away.
   ------------------------------------------------------------------ */
(function () {
  "use strict";
  if (window.__fgsMotion) return;
  window.__fgsMotion = true;

  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "css/motion.css?v=2026-10-07a";
  document.head.appendChild(link);

  function ready(fn) { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn); else fn(); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function db() {
    if (window.__fgsMotionClient) return window.__fgsMotionClient;
    if (typeof getClient === "function") return (window.__fgsMotionClient = getClient());
    if (window.supabase && typeof SUPABASE_URL !== "undefined") return (window.__fgsMotionClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY));
    return null;
  }

  // Run fn once el is (or comes) on screen.
  function whenVisible(el, fn) {
    if (!("IntersectionObserver" in window)) { fn(); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { io.disconnect(); fn(); } });
    }, { threshold: 0.15 });
    io.observe(el);
  }

  // Count a number up from zero. Keeps any prefix/suffix and decimals.
  function countUp(el, to, opts) {
    opts = opts || {};
    var fmt = opts.format || function (v) { return String(Math.round(v)); };
    if (reduced || !isFinite(to)) { el.textContent = fmt(to); return; }
    var dur = opts.duration || 900, start = null;
    function step(t) {
      if (start === null) start = t;
      var p = Math.min(1, (t - start) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(to * eased);
      if (p < 1) requestAnimationFrame(step); else el.textContent = fmt(to);
    }
    requestAnimationFrame(step);
  }

  // Watch a container for content a page script renders later.
  function onRendered(selector, test, fn) {
    var el = document.querySelector(selector);
    if (!el) return;
    var done = false;
    var check = function () { if (!done && test(el)) { done = true; mo.disconnect(); fn(el); } };
    var mo = new MutationObserver(check);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    check();
  }

  // ---------------- Leaderboard ----------------
  function animateLeaderboard(host) {
    var table = host.querySelector(".lb-table");
    if (!table) return;
    whenVisible(table, function () {
      table.classList.add("mo-animate");
      table.querySelectorAll(".lb-points").forEach(function (el, i) {
        var n = Number(el.getAttribute("data-count"));
        el.textContent = "0";
        setTimeout(function () { countUp(el, n, { duration: 1000 }); }, i * 45);
      });
    });
  }

  // ---------------- Next round countdown (homepage) ----------------
  async function countdown() {
    var hero = document.querySelector(".hero .hero-inner > div:first-child");
    if (!hero || document.querySelector(".mo-next")) return;
    var client = db(); if (!client) return;
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var iso = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
    var evRes = await client.from("events").select("id, name, venue, event_date, tee_time, meet_time, max_players, is_trip, hidden")
      .gte("event_date", iso).order("event_date", { ascending: true });
    var ev = (evRes.data || []).find(function (e) { return !e.is_trip && !e.hidden; });
    if (!ev) return;
    var both = await Promise.all([
      client.from("attendance").select("id, status").eq("event_id", ev.id),
      client.from("league_settings").select("max_players").maybeSingle()
    ]);
    var taken = (both[0].data || []).filter(function (a) { return a.status !== "waiting"; }).length;
    var cap = ev.max_players || (both[1].data && both[1].data.max_players) || 32;

    var p = ev.event_date.split("-");
    var t = String(ev.tee_time || ev.meet_time || "09:00").split(":");
    var target = new Date(+p[0], +p[1] - 1, +p[2], +t[0] || 9, +t[1] || 0);
    var dateText = target.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

    var a = document.createElement("a");
    a.className = "mo-next";
    a.href = "fixtures.html#event-" + ev.id;
    a.innerHTML = '<div class="mo-next-kicker">Next up · ' + esc(dateText) + (ev.tee_time ? " · first tee " + esc(String(ev.tee_time).slice(0, 5)) : "") + "</div>" +
      '<div class="mo-next-title">' + esc(ev.name) + (ev.venue ? " · " + esc(ev.venue) : "") + "</div>" +
      '<div class="mo-clock" aria-hidden="true"><div><b data-u="d">0</b><span>days</span></div><div><b data-u="h">0</b><span>hrs</span></div><div><b data-u="m">0</b><span>mins</span></div><div><b data-u="s">0</b><span>secs</span></div></div>' +
      '<div class="mo-places"><span>' + taken + " of " + cap + " places taken</span><span>" + (taken >= cap ? "Waiting list open" : Math.max(0, cap - taken) + " left →") + "</span></div>" +
      '<div class="mo-bar"><i></i></div>';
    a.setAttribute("aria-label", "Next round: " + ev.name + (ev.venue ? " at " + ev.venue : "") + ", " + dateText + ". " + taken + " of " + cap + " places taken.");
    var actions = hero.querySelector(".hero-actions");
    if (actions && actions.nextSibling) hero.insertBefore(a, actions.nextSibling); else hero.appendChild(a);

    var units = { d: a.querySelector('[data-u="d"]'), h: a.querySelector('[data-u="h"]'), m: a.querySelector('[data-u="m"]'), s: a.querySelector('[data-u="s"]') };
    function tick() {
      var ms = Math.max(0, target - new Date());
      var s = Math.floor(ms / 1000);
      units.d.textContent = Math.floor(s / 86400);
      units.h.textContent = String(Math.floor(s % 86400 / 3600)).padStart(2, "0");
      units.m.textContent = String(Math.floor(s % 3600 / 60)).padStart(2, "0");
      units.s.textContent = String(s % 60).padStart(2, "0");
    }
    tick();
    setInterval(tick, 1000);
    var bar = a.querySelector(".mo-bar i");
    var pct = Math.min(100, Math.round(taken / cap * 100)) + "%";
    if (reduced) bar.style.width = pct; else requestAnimationFrame(function () { setTimeout(function () { bar.style.width = pct; }, 250); });
  }

  // ---------------- Hole in One pot ----------------
  function potTicker() {
    var card = document.querySelector(".pot-card");
    if (!card) return;
    if (!card.querySelector(".mo-hole")) {
      var svg = document.createElement("div");
      svg.className = "mo-hole";
      svg.setAttribute("aria-hidden", "true");
      svg.innerHTML = '<svg viewBox="0 0 92 120" width="100%" height="100%">' +
        '<ellipse cx="56" cy="104" rx="26" ry="7" fill="rgba(27,58,108,.18)"/>' +
        '<ellipse cx="56" cy="104" rx="15" ry="4.5" fill="#10233F"/>' +
        '<line x1="46" y1="16" x2="46" y2="104" stroke="#57617A" stroke-width="2"/>' +
        '<path class="mo-flag" d="M47 18 L76 26 L47 34 Z" fill="#B8923C"/>' +
        '<circle class="mo-ball" cx="56" cy="98" r="5.5" fill="#fff" stroke="#C9CFDA" stroke-width="1"/>' +
        "</svg>";
      card.appendChild(svg);
    }
    onRendered("#pot-figure", function (el) { return /\d/.test(el.textContent); }, function (el) {
      var n = Number(el.textContent.replace(/[^\d.-]/g, ""));
      if (!isFinite(n)) return;
      el.classList.add("mo-rolling");
      whenVisible(el, function () {
        countUp(el, n, { duration: 1600, format: function (v) { var x = Math.round(v * 100) / 100; return "£" + x.toFixed(2).replace(/\.00$/, ""); } });
      });
    });
  }

  // ---------------- Scroll reveals ----------------
  function reveals() {
    if (reduced || !("IntersectionObserver" in window)) return;
    var els = document.querySelectorAll(".section .section-head, .section .card, .section .scorecard, .pot-card, .pot-history, .committee-card, .gallery-grid > *");
    var fold = window.innerHeight * 0.92;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add("mo-in");
        io.unobserve(e.target);
      });
    }, { threshold: 0.08, rootMargin: "0px 0px -6% 0px" });
    Array.prototype.forEach.call(els, function (el, i) {
      // Only things below the fold animate in; what you land on is already there.
      if (el.getBoundingClientRect().top < fold) return;
      el.classList.add("mo-reveal");
      el.style.transitionDelay = (i % 3) * 70 + "ms";
      io.observe(el);
    });
  }

  ready(function () {
    onRendered("#home-leaderboard", function (el) { return !!el.querySelector(".lb-table"); }, animateLeaderboard);
    onRendered("#full-leaderboard", function (el) { return !!el.querySelector(".lb-table"); }, animateLeaderboard);
    if (document.querySelector(".hero")) countdown().catch(function (e) { console.error(e); });
    potTicker();
    // A beat later, so content the page scripts render has its height.
    setTimeout(reveals, 300);
  });
})();
