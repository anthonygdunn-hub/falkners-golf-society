/* Committee Overview: the first tab on the admin page.

   One screen that answers "what's happening and what needs doing":
   the next round (sign-ups, payments, side comps), a to-do list built
   from the live data, the last round's results, the standings and the
   season so far.

   Every to-do item and shortcut opens the tab where the job is done,
   picks the right round in that section's fixture list and scrolls to
   it with a brief highlight, so you land exactly where the work is.

   Almost everything is clickable. A round (a bar on the chart, a row
   in the season table, a round name) opens a side panel with all of
   that round; a player's name opens their season; the payment meter,
   the unpaid list and the money boxes open the list of who has and
   hasn't paid. Two quick jobs can be done right in a panel, because
   they're the ones done most: confirming a payment, and giving a
   waiting-list player a place. Everything else has a button that
   jumps to the right tab.

   It reuses the page's signed-in Supabase client (`client`, from
   admin.js). */

(function () {
  "use strict";

  var root = null;
  var loading = false;
  var M = null;            // the latest model, for the panels
  var panelState = null;   // what the side panel is showing, so it survives a refresh

  // ---------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) {
    var v = Number(n) || 0;
    return "£" + v.toLocaleString("en-GB", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function todayIso() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function parseDate(iso) { var p = String(iso).split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(iso, n) {
    var d = parseDate(iso); d.setDate(d.getDate() + n);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
  function niceDate(iso, withYear) {
    return parseDate(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: withYear ? "numeric" : undefined });
  }
  function hhmm(t) { return t ? String(t).slice(0, 5) : null; }
  function roundLabel(ev) { return ev.name + (ev.venue ? " · " + ev.venue : ""); }

  // ---------------------------------------------------------------
  // Jumping to where the work is done
  // ---------------------------------------------------------------
  function goTo(t) {
    if (window.fgsAdminShow && t.tab) window.fgsAdminShow(t.tab);
    var target = null;
    if (t.select) {
      var sel = document.getElementById(t.select);
      if (sel && t.event && Array.prototype.some.call(sel.options, function (o) { return o.value === t.event; })) {
        if (sel.value !== t.event) {
          sel.value = t.event;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      target = sel;
    }
    if (t.el) target = document.getElementById(t.el) || target;
    if (t.heading && window.fgsAdminSection) target = window.fgsAdminSection(t.heading) || target;
    var block = target && target.closest ? (target.closest(".card, .scorecard") || target) : null;
    if (!block) { window.scrollTo({ top: 0, behavior: "instant" }); return; }

    /* Land on the fixture picker for that section when there is one (it
       sits right above the list being worked on, e.g. "Who's paid"),
       otherwise on the top of the section. An instant jump rather than
       a smooth one: smooth scrolling is skipped or cut short by some
       browsers, and lists loading above can shift the page mid-scroll,
       so it jumps again once those have settled. */
    var anchor = (t.select && target && target.closest && target.closest(".form-field")) || block;
    var jump = function () {
      var top = anchor.getBoundingClientRect().top + window.scrollY - 110;
      window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
    };
    setTimeout(function () {
      jump();
      block.classList.remove("ov-flash");
      void block.offsetWidth;
      block.classList.add("ov-flash");
      if (t.names && t.names.length) highlightNames(t.names);
    }, 150);
    setTimeout(jump, 900);
  }

  // After a jump to the playing list, mark the names the to-do was about.
  function highlightNames(names) {
    var tries = 0;
    var want = names.map(function (n) { return n.toLowerCase(); });
    var timer = setInterval(function () {
      var rows = document.querySelectorAll("#playing-list > div, #payment-list > div");
      var hit = 0;
      rows.forEach(function (row) {
        var label = (row.querySelector("span") || row).textContent.toLowerCase();
        if (want.some(function (w) { return label.indexOf(w) === 0; })) { row.classList.add("ov-mark"); hit++; }
      });
      if (hit || ++tries > 20) clearInterval(timer);
    }, 250);
  }

  // ---------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------
  async function load() {
    var q = await Promise.all([
      client.from("events").select("*").order("event_date", { ascending: true }),
      client.from("attendance_payments").select("id, event_id, profile_id, player_id, payment_status, status, guest_of, created_at"),
      client.from("profiles").select("id, display_name"),
      client.from("players").select("id, name, profile_id, handicap"),
      client.from("results").select("event_id, player_id, points, gross_score"),
      client.from("event_prizes").select("*"),
      client.from("memberships").select("profile_id", { count: "exact", head: true }).eq("status", "pending"),
      client.from("photos").select("id", { count: "exact", head: true }).eq("status", "pending"),
      client.from("hole_in_one_ledger").select("amount"),
      client.from("league_settings").select("*").maybeSingle(),
      client.from("groupings").select("event_id, group_type, group_number, profile_id, player_id")
    ]);
    var failed = q.filter(function (r) { return r.error; });
    if (failed.length) throw new Error(failed[0].error.message);
    return {
      events: q[0].data || [], attendance: q[1].data || [], profiles: q[2].data || [], players: q[3].data || [],
      results: q[4].data || [], prizes: q[5].data || [], pendingMembers: q[6].count || 0, pendingPhotos: q[7].count || 0,
      pot: (q[8].data || []).reduce(function (s, r) { return s + Number(r.amount || 0); }, 0),
      settings: q[9].data || {}, groupings: q[10].data || []
    };
  }

  function model(d) {
    var today = todayIso();
    var profName = new Map(d.profiles.map(function (p) { return [p.id, p.display_name || "Member"]; }));
    var playerById = new Map(d.players.map(function (p) { return [p.id, p]; }));
    var playerByLower = new Map(d.players.map(function (p) { return [p.name.trim().toLowerCase(), p.name]; }));
    var cap = function (ev) { return ev.max_players || d.settings.max_players || 32; };
    var closeDays = d.settings.close_days == null ? 7 : d.settings.close_days;

    var nameOf = function (r) {
      if (r.profile_id) return profName.get(r.profile_id) || "Member";
      var pl = playerById.get(r.player_id); return pl ? pl.name : "Player";
    };

    var rounds = d.events.filter(function (e) { return !e.is_trip && !e.hidden; });
    var trips = d.events.filter(function (e) { return e.is_trip; });
    var resultsByEvent = new Map();
    d.results.forEach(function (r) {
      if (!resultsByEvent.has(r.event_id)) resultsByEvent.set(r.event_id, []);
      resultsByEvent.get(r.event_id).push(r);
    });
    var prizeByEvent = new Map(d.prizes.map(function (p) { return [p.event_id, p]; }));

    var perEvent = new Map();
    d.events.forEach(function (ev) {
      var rows = d.attendance.filter(function (a) { return a.event_id === ev.id; });
      var playing = rows.filter(function (a) { return a.status !== "waiting"; });
      var waiting = rows.filter(function (a) { return a.status === "waiting"; })
        .sort(function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)); });

      // The same person on the list twice, e.g. once registered online
      // and once added by the committee under their player name.
      var seenKey = new Map(), seenName = new Map(), dups = new Set();
      playing.forEach(function (r) {
        var pl = r.player_id ? playerById.get(r.player_id) : null;
        var key = r.profile_id || (pl && pl.profile_id) || ("p:" + r.player_id);
        var nm = nameOf(r).trim().toLowerCase();
        if (seenKey.has(key) || seenName.has(nm)) dups.add(nameOf(r));
        seenKey.set(key, true); seenName.set(nm, true);
      });

      // A guest whose member has since pulled out.
      var hosts = new Set(rows.filter(function (r) { return r.profile_id; }).map(function (r) { return r.profile_id; }));
      var orphans = rows.filter(function (r) { return r.guest_of && !hosts.has(r.guest_of); });

      var count = function (s) { return playing.filter(function (r) { return (r.payment_status || "unpaid") === s; }).length; };
      perEvent.set(ev.id, {
        rows: rows, playing: playing, waiting: waiting, dups: Array.from(dups), orphans: orphans,
        confirmed: count("confirmed"), claimed: count("claimed"), unpaid: count("unpaid"),
        results: resultsByEvent.get(ev.id) || [], prize: prizeByEvent.get(ev.id) || null,
        fours: d.groupings.some(function (g) { return g.event_id === ev.id && g.group_type === "fours"; }),
        cap: cap(ev), closes: addDays(ev.event_date, -closeDays)
      });
    });

    var upcoming = rounds.filter(function (e) { return e.event_date >= today; });
    var played = rounds.filter(function (e) { return e.event_date < today; });
    var next = upcoming[0] || null;
    var last = played.slice().reverse().find(function (e) { return (perEvent.get(e.id).results || []).length; }) || null;

    return {
      d: d, today: today, rounds: rounds, trips: trips, upcoming: upcoming, played: played,
      next: next, last: last, perEvent: perEvent, nameOf: nameOf, profName: profName,
      playerById: playerById, playerByLower: playerByLower
    };
  }

  // ---------------------------------------------------------------
  // The to-do list
  // ---------------------------------------------------------------
  function todos(m) {
    var list = [];
    var add = function (level, tag, html, target, action) { list.push({ level: level, tag: tag, html: html, target: target, action: action }); };

    if (m.d.pendingMembers) add("warn", "Requests", "<b>" + m.d.pendingMembers + "</b> membership " + (m.d.pendingMembers === 1 ? "request" : "requests") + " to approve", { tab: "requests", heading: "Pending member requests" }, "Review");
    if (m.d.pendingPhotos) add("warn", "Photos", "<b>" + m.d.pendingPhotos + "</b> " + (m.d.pendingPhotos === 1 ? "photo" : "photos") + " waiting for approval", { tab: "people", heading: "Photos awaiting approval" }, "Review");

    m.rounds.forEach(function (ev) {
      var s = m.perEvent.get(ev.id);
      var isPast = ev.event_date < m.today;
      var label = "<b>" + esc(ev.name) + ":</b> ";
      var days = daysBetween(m.today, ev.event_date);

      if (isPast) {
        if (!s.results.length && s.playing.length) {
          add("bad", "Results", label + "results not entered yet", { tab: "results", select: "event-select", event: ev.id }, "Enter");
        } else if (s.results.length && (!s.prize || !s.prize.first_place)) {
          add("warn", "Prizes", label + "prize winners not recorded", { tab: "results", select: "prize-event-select", event: ev.id }, "Record");
        }
        var owed = s.playing.length - s.confirmed;
        if (s.playing.length && owed > 0) {
          var none = s.confirmed === 0 && s.claimed === 0;
          add(none ? "bad" : "warn", "Money", label + (none
            ? s.playing.length + " played, no payments recorded"
            : owed + " of " + s.playing.length + " not confirmed as paid"), { tab: "money", select: "pay-event-select", event: ev.id }, "Record");
        }
        return;
      }

      if (s.claimed) add("warn", "Money", label + "<b>" + s.claimed + "</b> " + (s.claimed === 1 ? "says they've" : "say they've") + " paid, waiting to be confirmed", { tab: "money", select: "pay-event-select", event: ev.id }, "Confirm");
      if (s.waiting.length) add("warn", ev.name, label + "<b>" + s.waiting.length + "</b> on the waiting list (" + s.playing.length + "/" + s.cap + " places taken)", { tab: "fixtures", select: "playing-event-select", event: ev.id, names: s.waiting.map(m.nameOf) }, "Decide");
      if (s.dups.length) add("warn", ev.name, label + s.dups.map(function (n) { return "<b>" + esc(n) + "</b>"; }).join(", ") + " on the list twice", { tab: "fixtures", select: "playing-event-select", event: ev.id, names: s.dups }, "Fix");
      s.orphans.forEach(function (g) {
        add("warn", ev.name, label + "guest <b>" + esc(m.nameOf(g)) + "</b> is still on, but " + esc(m.profName.get(g.guest_of) || "their member") + " has pulled out", { tab: "fixtures", select: "playing-event-select", event: ev.id, names: [m.nameOf(g)] }, "Decide");
      });

      var missing = [];
      if (ev.cost == null) missing.push("cost");
      if (!ev.tee_time) missing.push("tee time");
      if (window.competitionsOn && !window.competitionsOn(ev).length) missing.push("side-comp holes");
      if (missing.length && days <= 42) add("warn", ev.name, label + esc(ev.venue || "") + ", " + niceDate(ev.event_date) + ": no " + missing.join(", ") + " set yet", { tab: "fixtures", select: "edit-event-select", event: ev.id }, "Set up");

      if (days <= 10 && s.playing.length && !s.fours) add("warn", ev.name, label + "tee groups not drawn yet", { tab: "fixtures", select: "group-event-select", event: ev.id }, "Draw");
      if (days <= 14 && s.unpaid && ev.cost) add("info", ev.name, label + s.unpaid + " still to pay", { tab: "money", select: "pay-event-select", event: ev.id }, "View");
    });

    m.trips.forEach(function (ev) {
      var s = m.perEvent.get(ev.id);
      if (s && s.claimed) add("warn", "Trip", "<b>" + esc(ev.name) + ":</b> <b>" + s.claimed + "</b> say they've paid, waiting to be confirmed", { tab: "ryder", el: "trip-payment-breakdown" }, "Confirm");
    });

    var order = { bad: 0, warn: 1, info: 2 };
    return list.sort(function (a, b) { return order[a.level] - order[b.level]; });
  }

  // ---------------------------------------------------------------
  // Standings
  // ---------------------------------------------------------------
  function orderOfMerit(m, uptoEventIds) {
    var counting = Number(m.d.settings.counting_rounds) || null;
    var by = new Map();
    m.d.results.forEach(function (r) {
      if (uptoEventIds && !uptoEventIds.has(r.event_id)) return;
      var pl = m.playerById.get(r.player_id); var name = pl ? pl.name : "Unknown";
      if (!by.has(name)) by.set(name, []);
      by.get(name).push(Number(r.points) || 0);
    });
    var rows = [];
    by.forEach(function (scores, name) {
      var used = counting && counting < scores.length ? scores.slice().sort(function (a, b) { return b - a; }).slice(0, counting) : scores;
      rows.push({ name: name, rounds: scores.length, points: used.reduce(function (s, v) { return s + v; }, 0) });
    });
    rows.sort(function (a, b) { return b.points - a.points || a.name.localeCompare(b.name); });
    return rows;
  }

  function positions(rows, key) {
    var out = [];
    rows.forEach(function (r, i) {
      var first = i; while (first > 0 && rows[first - 1][key] === r[key]) first--;
      var tied = (i > 0 && rows[i - 1][key] === r[key]) || (i < rows.length - 1 && rows[i + 1][key] === r[key]);
      out.push((tied ? "T" : "") + (first + 1));
    });
    return out;
  }

  function sideComps(m) {
    var comps = (window.ROUND_COMPETITIONS || []);
    var tally = new Map();
    var canonical = function (raw) {
      var n = String(raw || "").trim(); if (!n) return null;
      return m.playerByLower.get(n.toLowerCase()) || n;
    };
    m.d.prizes.forEach(function (p) {
      comps.forEach(function (c) {
        var who = canonical(p[c.winner]); if (!who) return;
        if (!tally.has(who)) tally.set(who, { name: who, ld: 0, ntp: 0 });
        if (c.id.indexOf("ld") === 0) tally.get(who).ld++; else tally.get(who).ntp++;
      });
    });
    var rows = Array.from(tally.values()).map(function (r) { r.total = r.ld + r.ntp; return r; });
    rows.sort(function (a, b) { return b.total - a.total || a.name.localeCompare(b.name); });
    return rows;
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------
  function linkBtn(label, target, cls) {
    return '<button type="button" class="ov-link ' + (cls || "") + '" data-go=\'' + esc(JSON.stringify(target)) + '\'>' + esc(label) + "</button>";
  }

  function renderNext(m) {
    var ev = m.next;
    if (!ev) return '<section class="ov-card"><div class="ov-head"><h4>Next round</h4></div><p class="small">No rounds scheduled. Add the next one under Fixtures.</p>' + linkBtn("Add a fixture →", { tab: "fixtures", heading: "Add a fixture" }) + "</section>";
    var s = m.perEvent.get(ev.id);
    var days = daysBetween(m.today, ev.event_date);
    var closed = m.today > s.closes;
    var expected = ev.cost ? s.playing.length * Number(ev.cost) : null;
    var received = ev.cost ? s.confirmed * Number(ev.cost) : null;
    var pct = function (n, of) { return of ? Math.min(100, Math.round(n / of * 100)) : 0; };
    var comps = window.competitionsOn ? window.competitionsOn(ev) : [];
    var unpaidNames = s.playing.filter(function (r) { return (r.payment_status || "unpaid") === "unpaid"; }).map(m.nameOf).sort();

    return '<section class="ov-card" aria-labelledby="ov-next-h">' +
      '<div class="ov-head"><h4 id="ov-next-h">Next round</h4>' + linkBtn("Edit fixture →", { tab: "fixtures", select: "edit-event-select", event: ev.id }) + "</div>" +
      '<div class="ov-round-top"><div><button type="button" class="ov-round-name ov-plain" data-round="' + ev.id + '">' + esc(roundLabel(ev)) + '</button><div class="small">' + esc(parseDate(ev.event_date).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })) + "</div></div>" +
      '<div class="ov-countdown"><b>' + (days === 0 ? "Today" : days) + "</b>" + (days === 0 ? "" : '<span class="small">' + (days === 1 ? "day" : "days") + " to go</span>") + "</div></div>" +
      '<dl class="ov-meta">' +
        "<div><dt>Meet</dt><dd>" + (hhmm(ev.meet_time) || "Not set") + "</dd></div>" +
        "<div><dt>First tee</dt><dd>" + (hhmm(ev.tee_time) || "Not set") + "</dd></div>" +
        "<div><dt>Cost</dt><dd>" + (ev.cost != null ? money(ev.cost) : "Not set") + "</dd></div>" +
        "<div><dt>Sign-ups</dt><dd>" + (closed ? "Closed " + niceDate(s.closes) : "Close " + niceDate(s.closes)) + "</dd></div>" +
        "<div><dt>Draw</dt><dd>" + (s.fours ? "Tee groups set" : "Not drawn") + "</dd></div>" +
      "</dl>" +
      '<div class="ov-meter-row"><div class="ov-meter-label"><button type="button" class="ov-plain ov-underline" data-round="' + ev.id + '">Registered</button><span><b>' + s.playing.length + "</b> / " + s.cap + " places</span></div>" +
        '<div class="ov-meter"><span class="ov-fill-navy" style="width:' + pct(s.playing.length, s.cap) + '%"></span></div>' +
        '<div class="ov-legend"><span>' + Math.max(0, s.cap - s.playing.length) + " places left" + (s.waiting.length ? " · " + s.waiting.length + " waiting" : "") + (s.dups.length ? " · " + s.dups.length + " possible duplicate" + (s.dups.length > 1 ? "s" : "") : "") + "</span></div></div>" +
      (ev.cost ? '<div class="ov-meter-row"><div class="ov-meter-label"><span>Payments</span><span>' + money(received) + " of " + money(expected) + " confirmed</span></div>" +
        '<div class="ov-meter ov-meter-click">' +
          '<button type="button" class="ov-fill-ok" style="width:' + pct(s.confirmed, s.playing.length) + '%" data-pay="' + ev.id + '" data-filter="confirmed" aria-label="' + s.confirmed + ' confirmed"></button>' +
          '<button type="button" class="ov-fill-warn" style="width:' + pct(s.claimed, s.playing.length) + '%" data-pay="' + ev.id + '" data-filter="claimed" aria-label="' + s.claimed + ' say they have paid"></button>' +
          '<button type="button" class="ov-fill-rest" style="flex:1" data-pay="' + ev.id + '" data-filter="unpaid" aria-label="' + s.unpaid + ' unpaid"></button></div>' +
        '<div class="ov-legend">' +
          '<button type="button" class="ov-plain ov-legend-btn" data-pay="' + ev.id + '" data-filter="confirmed"><i class="ov-dot ov-fill-ok"></i>' + s.confirmed + ' confirmed</button>' +
          '<button type="button" class="ov-plain ov-legend-btn" data-pay="' + ev.id + '" data-filter="claimed"><i class="ov-dot ov-fill-warn"></i>' + s.claimed + ' say they\'ve paid</button>' +
          '<button type="button" class="ov-plain ov-legend-btn" data-pay="' + ev.id + '" data-filter="unpaid"><i class="ov-dot ov-fill-track"></i>' + s.unpaid + " unpaid</button></div></div>" : "") +
      (comps.length ? '<div class="small" style="margin-bottom:6px;">Side competitions</div><div class="ov-comps">' + comps.map(function (c) { return '<span class="ov-comp">' + esc(c.label + " " + c.nine.replace("front 9", "F9").replace("back 9", "B9")) + " <b>H" + window.competitionHole(ev, c) + "</b></span>"; }).join("") + "</div>" : '<p class="small">No side competitions set for this round.</p>') +
      '<div class="ov-btns">' +
        (unpaidNames.length && ev.cost ? '<button type="button" class="btn btn-brass btn-small" data-copy-reminder>Copy payment reminder</button>' : "") +
        linkBtn("Confirm payments", { tab: "money", select: "pay-event-select", event: ev.id }, "btn btn-outline btn-small") +
        linkBtn("Who's playing", { tab: "fixtures", select: "playing-event-select", event: ev.id }, "btn btn-outline btn-small") +
      '</div><div class="ov-copied small" aria-live="polite"></div>' +
      (unpaidNames.length ? '<details class="ov-players"><summary>' + unpaidNames.length + " unpaid</summary><div class=\"ov-chips\">" + unpaidNames.map(function (n) { return '<button type="button" class="ov-chip' + (s.dups.indexOf(n) > -1 ? " ov-chip-dup" : "") + '" data-player="' + esc(n) + '">' + esc(n) + "</button>"; }).join("") + "</div></details>" : "") +
      "</section>";
  }

  function reminderText(m) {
    var ev = m.next; if (!ev) return "";
    var s = m.perEvent.get(ev.id);
    var seen = new Set();
    var names = s.playing.filter(function (r) { return (r.payment_status || "unpaid") === "unpaid"; }).map(m.nameOf)
      .filter(function (n) { if (seen.has(n)) return false; seen.add(n); return true; }).sort();
    return roundLabel(ev) + " · " + niceDate(ev.event_date) + "\n" +
      [hhmm(ev.meet_time) ? "Meet " + hhmm(ev.meet_time) : null, hhmm(ev.tee_time) ? "first tee " + hhmm(ev.tee_time) : null].filter(Boolean).join(", ") +
      (ev.cost ? ". " + money(ev.cost) + " per player." : "") + "\n\nStill to pay:\n" + names.join(", ") +
      "\n\nBank details and your reference are on the fixtures page at thefalknersarmsgolfsociety.co.uk. Tap \"I've paid\" once it's sent.";
  }

  function renderTodos(m) {
    var items = todos(m);
    var body = items.length
      ? '<ul class="ov-actions">' + items.map(function (it) {
          return '<li><span class="ov-pill ov-p-' + it.level + '">' + esc(it.tag) + '</span><span class="ov-t">' + it.html + "</span>" + linkBtn(it.action + " →", it.target, "ov-go") + "</li>";
        }).join("") + "</ul>"
      : '<p class="small">Nothing waiting. Everything is up to date.</p>';
    return '<section class="ov-card" aria-labelledby="ov-todo-h"><div class="ov-head"><h4 id="ov-todo-h">Needs doing</h4><span class="small">' + items.length + " item" + (items.length === 1 ? "" : "s") + "</span></div>" + body + "</section>";
  }

  function renderLast(m) {
    var ev = m.last;
    if (!ev) return '<section class="ov-card"><div class="ov-head"><h4>Last round</h4></div><p class="small">No results logged yet this season.</p></section>';
    var s = m.perEvent.get(ev.id);
    var sorted = s.results.slice().sort(function (a, b) { return (Number(b.points) || 0) - (Number(a.points) || 0); });
    var nm = function (r) { var p = m.playerById.get(r.player_id); return p ? p.name : "Player"; };
    var p = s.prize || {};
    var place = function (key, fallback) { return p[key] || (fallback ? nm(fallback) : "—"); };
    var ptsFor = function (name) { var r = sorted.find(function (x) { return nm(x) === name; }); return r ? r.points + " pts" : ""; };
    var podium = [["1st", place("first_place", sorted[0])], ["2nd", place("second_place", sorted[1])], ["3rd", place("third_place", sorted[2])]];
    var comps = window.competitionsOn ? window.competitionsOn(ev) : [];
    var prizeCells = (p.winning_pair ? "<div><span>Winning pair</span>" + esc(p.winning_pair) + "</div>" : "") +
      comps.map(function (c) { return "<div><span>" + esc(c.title) + "</span>" + esc(p[c.winner] || "Not recorded") + "</div>"; }).join("");

    var history = m.played.slice().reverse().filter(function (e) { return m.perEvent.get(e.id).results.length; }).map(function (e) {
      var pr = m.perEvent.get(e.id).prize || {};
      var winners = (window.ROUND_COMPETITIONS || []).map(function (c) { return pr[c.winner]; }).filter(Boolean);
      return '<tr class="ov-row-link" data-round="' + e.id + '" tabindex="0"><td>' + esc(e.name.replace("Round ", "R")) + "</td><td>" + esc(pr.first_place || "—") + "</td><td>" + esc(pr.winning_pair || "—") + "</td><td>" + (winners.length ? esc(winners.join(", ")) : "None recorded") + "</td></tr>";
    }).join("");

    return '<section class="ov-card" aria-labelledby="ov-last-h"><div class="ov-head"><h4 id="ov-last-h">Last round · <button type="button" class="ov-plain ov-underline" data-round="' + ev.id + '">' + esc(ev.name) + "</button></h4>" + linkBtn("Edit results →", { tab: "results", select: "event-select", event: ev.id }) + "</div>" +
      '<div class="small" style="margin-bottom:10px;">' + esc((ev.venue || "Venue TBC") + " · " + niceDate(ev.event_date) + " · " + s.results.length + " played") + "</div>" +
      '<div class="ov-podium">' + podium.map(function (x) { return '<div><div class="ov-place">' + x[0] + '</div><button type="button" class="ov-who ov-plain" data-player="' + esc(x[1]) + '">' + esc(x[1]) + '</button><div class="ov-pts">' + esc(ptsFor(x[1])) + "</div></div>"; }).join("") + "</div>" +
      (prizeCells ? '<div class="ov-prizes">' + prizeCells + "</div>" : "") +
      (!s.prize ? '<p class="small">' + linkBtn("Record this round's prizes →", { tab: "results", select: "prize-event-select", event: ev.id }) + "</p>" : "") +
      '<details class="ov-rounds"><summary>Every round this season</summary><div class="ov-tbl"><table><thead><tr><th>Round</th><th>Winner</th><th>Pair</th><th>Side comps</th></tr></thead><tbody>' + history + "</tbody></table></div></details>" +
      "</section>";
  }

  function renderStandings(m) {
    var now = orderOfMerit(m);
    var beforeIds = null;
    if (m.last) {
      beforeIds = new Set(m.played.filter(function (e) { return e.event_date < m.last.event_date; }).map(function (e) { return e.id; }));
    }
    var before = beforeIds ? orderOfMerit(m, beforeIds) : [];
    var prevPos = new Map(); before.forEach(function (r, i) { prevPos.set(r.name, i); });
    var pos = positions(now, "points");
    var top = now.slice(0, 10);
    var oom = top.map(function (r, i) {
      var was = prevPos.has(r.name) ? prevPos.get(r.name) : null;
      var mv = was == null ? '<span class="ov-mv ov-up">new</span>' : was > i ? '<span class="ov-mv ov-up">▲' + (was - i) + "</span>" : was < i ? '<span class="ov-mv ov-down">▼' + (i - was) + "</span>" : '<span class="ov-mv ov-same">–</span>';
      return '<tr class="ov-row-link" data-player="' + esc(r.name) + '" tabindex="0"><td class="ov-pos">' + pos[i] + "</td><td>" + (before.length ? mv : "") + "</td><td>" + esc(r.name) + '</td><td class="ov-num">' + r.rounds + '</td><td class="ov-num">' + r.points + "</td></tr>";
    }).join("");

    var side = sideComps(m);
    var spos = positions(side, "total");
    var sideRows = side.slice(0, 12).map(function (r, i) {
      return '<tr class="ov-row-link" data-player="' + esc(r.name) + '" tabindex="0"><td class="ov-pos">' + spos[i] + "</td><td>" + esc(r.name) + '</td><td class="ov-num">' + r.ld + '</td><td class="ov-num">' + r.ntp + '</td><td class="ov-num"><b>' + r.total + "</b></td></tr>";
    }).join("");

    var counting = Number(m.d.settings.counting_rounds) || null;
    return '<section class="ov-card" aria-labelledby="ov-lb-h"><div class="ov-head"><h4 id="ov-lb-h">Standings</h4><a class="ov-link" href="leaderboard.html" target="_blank" rel="noopener">Public leaderboard →</a></div>' +
      '<div class="ov-subtabs" role="group" aria-label="Which table"><button type="button" class="btn btn-brass btn-small" data-ov-lb="oom" aria-pressed="true">Order of Merit</button><button type="button" class="btn btn-outline btn-small" data-ov-lb="side" aria-pressed="false">Side comps</button></div>' +
      '<div data-ov-panel="oom" class="ov-tbl"><table><thead><tr><th>Pos</th><th></th><th>Player</th><th class="ov-num">Rds</th><th class="ov-num">Pts</th></tr></thead><tbody>' + (oom || '<tr><td colspan="5">No results yet.</td></tr>') + "</tbody></table>" +
        '<p class="small" style="margin-top:8px;">' + (counting ? "Best " + counting + " rounds count. " : "Every round counts. ") + (before.length && m.last ? "Movement compares with the table before " + esc(m.last.name) + "." : "") + "</p></div>" +
      '<div data-ov-panel="side" class="ov-tbl" hidden><table><thead><tr><th>Pos</th><th>Player</th><th class="ov-num">LD</th><th class="ov-num">NTP</th><th class="ov-num">Total</th></tr></thead><tbody>' + (sideRows || '<tr><td colspan="5">No side competition winners recorded yet.</td></tr>') + "</tbody></table>" +
        '<p class="small" style="margin-top:8px;">Longest drive and nearest the pin wins only, kept apart from Order of Merit points.</p></div>' +
      "</section>";
  }

  function renderSeason(m) {
    var bars = m.rounds.map(function (ev) {
      var s = m.perEvent.get(ev.id);
      var playedRound = ev.event_date < m.today;
      var n = playedRound ? (s.results.length || s.playing.length) : s.playing.length;
      return { ev: ev, n: n, future: !playedRound };
    });
    var max = Math.max.apply(null, bars.map(function (b) { return b.n; }).concat([s32(m)]));
    var playedBars = bars.filter(function (b) { return !b.future && b.n; });
    var avg = playedBars.length ? playedBars.reduce(function (s, b) { return s + b.n; }, 0) / playedBars.length : 0;

    var moneyCells = m.played.filter(function (ev) { return ev.cost && m.perEvent.get(ev.id).playing.length; }).slice(-3).map(function (ev) {
      var s = m.perEvent.get(ev.id);
      return '<button type="button" class="ov-money-box" data-pay="' + ev.id + '" data-filter="all"><b>' + money(s.confirmed * Number(ev.cost)) + "</b><span>" + esc(ev.name) + " received · " + s.confirmed + " of " + s.playing.length + "</span></button>";
    });
    moneyCells.push('<button type="button" class="ov-money-box" data-go=\'' + esc(JSON.stringify({ tab: "money", heading: "Hole in one pot" })) + '\'><b>' + money(m.d.pot) + "</b><span>Hole in One pot</span></button>");

    var playedCount = m.played.length;
    return '<section class="ov-card" aria-labelledby="ov-season-h"><div class="ov-head"><h4 id="ov-season-h">Season so far</h4><span class="small">' + playedCount + " of " + m.rounds.length + " rounds played</span></div>" +
      '<div class="small">Players per round</div>' +
      '<div class="ov-bars" style="grid-template-columns:repeat(' + Math.max(1, bars.length) + ',1fr)">' +
        (avg ? '<div class="ov-avg" style="bottom:' + (avg / max * 100) + '%"><span>avg ' + Math.round(avg) + "</span></div>" : "") +
        bars.map(function (b) {
          return '<button type="button" class="ov-bar" data-round="' + b.ev.id + '" aria-label="' + esc(b.ev.name + ": " + b.n + (b.future ? " registered" : " played") + ". Open the round") + '">' +
            '<span class="ov-tip" role="presentation">' + barTip(m, b) + "</span>" +
            "<em>" + b.n + '</em><i class="' + (b.future ? "ov-future" : "") + '" style="height:' + (max ? b.n / max * 100 : 0) + '%"></i></button>';
        }).join("") +
      "</div>" +
      '<div class="ov-bar-labels" style="grid-template-columns:repeat(' + Math.max(1, bars.length) + ',1fr)">' + bars.map(function (b) { return "<span>" + esc(b.ev.name.replace("Round ", "R")) + "</span>"; }).join("") + "</div>" +
      '<p class="small" style="margin-top:6px;">Striped bars are sign-ups for rounds not played yet. Click a bar to open that round.</p>' +
      '<div class="ov-money">' + moneyCells.join("") + "</div>" +
      "</section>";
  }
  function s32(m) { return m.d.settings.max_players || 32; }

  // ---------------------------------------------------------------
  // Hover details for a bar on the season chart
  // ---------------------------------------------------------------
  function barTip(m, b) {
    var s = m.perEvent.get(b.ev.id);
    var lines = ["<b>" + esc(b.ev.name) + "</b>", esc((b.ev.venue || "Venue TBC") + " · " + niceDate(b.ev.event_date))];
    if (!b.future) {
      var pts = s.results.map(function (r) { return Number(r.points) || 0; });
      var avg = pts.length ? Math.round(pts.reduce(function (a, v) { return a + v; }, 0) / pts.length) : null;
      lines.push(b.n + " played" + (avg != null ? " · avg " + avg + " pts" : ""));
      if (s.prize && s.prize.first_place) lines.push("Winner: " + esc(s.prize.first_place));
    } else {
      lines.push(s.playing.length + " of " + s.cap + " places taken" + (s.waiting.length ? " · " + s.waiting.length + " waiting" : ""));
      if (b.ev.cost) lines.push(s.confirmed + " paid · " + s.claimed + " say they've paid · " + s.unpaid + " unpaid");
    }
    lines.push('<span class="ov-tip-cta">Click to open</span>');
    return lines.join("<br>");
  }

  // ---------------------------------------------------------------
  // Side panel: a round, a player, or a round's payments
  // ---------------------------------------------------------------
  var drawer = null, lastFocus = null;

  function ensureDrawer() {
    if (drawer) return drawer;
    drawer = document.createElement("div");
    drawer.className = "ov-drawer-wrap";
    drawer.hidden = true;
    drawer.innerHTML = '<div class="ov-scrim" data-close></div>' +
      '<aside class="ov-drawer" role="dialog" aria-modal="true" aria-labelledby="ov-drawer-title" tabindex="-1">' +
      '<div class="ov-drawer-head"><div class="ov-drawer-kicker small" id="ov-drawer-kicker"></div><h3 id="ov-drawer-title"></h3>' +
      '<button type="button" class="ov-close" data-close aria-label="Close">×</button></div>' +
      '<div class="ov-drawer-body" id="ov-drawer-body"></div></aside>';
    document.body.appendChild(drawer);
    drawer.addEventListener("click", onClick);
    drawer.addEventListener("keydown", onKey);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && drawer && !drawer.hidden) closePanel(); });
    return drawer;
  }

  function openPanel(state) {
    if (!M) return;
    ensureDrawer();
    if (drawer.hidden) lastFocus = document.activeElement;
    panelState = state;
    var out = state.type === "round" ? roundPanel(state.id)
      : state.type === "player" ? playerPanel(state.id)
      : payPanel(state.id, state.filter || "all");
    if (!out) { closePanel(); return; }
    drawer.querySelector("#ov-drawer-kicker").textContent = out.kicker || "";
    drawer.querySelector("#ov-drawer-title").textContent = out.title;
    var body = drawer.querySelector("#ov-drawer-body");
    var keepScroll = !drawer.hidden && state.keepScroll ? body.scrollTop : 0;
    body.innerHTML = out.html;
    body.scrollTop = keepScroll;
    var wasHidden = drawer.hidden;
    drawer.hidden = false;
    document.documentElement.classList.add("ov-no-scroll");
    if (wasHidden) drawer.querySelector(".ov-drawer").focus();
  }

  function closePanel() {
    if (!drawer) return;
    drawer.hidden = true;
    panelState = null;
    document.documentElement.classList.remove("ov-no-scroll");
    if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) {}
  }

  // Everything in a panel that should lead somewhere carries one of the
  // same data attributes as the dashboard itself, so one handler serves both.
  function onClick(e) {
    var t = e.target.closest("[data-close],[data-round],[data-player],[data-pay],[data-go],[data-act],[data-filter-tab],[data-copy-list]");
    if (!t) return;
    if (t.hasAttribute("data-close")) { closePanel(); return; }
    if (t.hasAttribute("data-act")) { quickAction(t); return; }
    if (t.hasAttribute("data-copy-list")) { copyText(t.getAttribute("data-copy-list"), t); return; }
    if (t.hasAttribute("data-go")) {
      if (drawer && drawer.contains(t)) closePanel();
      try { goTo(JSON.parse(t.getAttribute("data-go"))); } catch (err) { console.error(err); }
      return;
    }
    if (t.hasAttribute("data-filter-tab")) { openPanel({ type: "pay", id: panelState.id, filter: t.getAttribute("data-filter-tab") }); return; }
    if (t.hasAttribute("data-pay")) { openPanel({ type: "pay", id: t.getAttribute("data-pay"), filter: t.getAttribute("data-filter") || "all" }); return; }
    if (t.hasAttribute("data-round")) { openPanel({ type: "round", id: t.getAttribute("data-round") }); return; }
    if (t.hasAttribute("data-player")) { openPanel({ type: "player", id: t.getAttribute("data-player") }); return; }
  }
  function onKey(e) {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("tr[data-round],tr[data-player]")) { e.preventDefault(); onClick(e); }
    if (e.key === "Tab" && drawer && !drawer.hidden && drawer.contains(e.target)) {
      var f = drawer.querySelectorAll("button, [href], input, [tabindex]:not([tabindex='-1'])");
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  function copyText(text, btn) {
    var done = function () { var old = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = old; }, 1600); };
    var fallback = function () { var ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); done(); } catch (e) {} ta.remove(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }

  // Confirm / undo a payment, or give a waiting-list player a place.
  async function quickAction(btn) {
    var act = btn.getAttribute("data-act"), id = btn.getAttribute("data-id");
    btn.disabled = true;
    var patch = act === "confirm" ? { payment_status: "confirmed", payment_confirmed_at: new Date().toISOString() }
      : act === "unconfirm" ? { payment_status: "unpaid", payment_confirmed_at: null }
      : act === "place" ? { status: "playing" } : null;
    if (!patch) return;
    var res = await client.from("attendance").update(patch).eq("id", id);
    if (res.error) {
      btn.disabled = false;
      var msg = drawer.querySelector("[data-panel-msg]");
      if (msg) msg.innerHTML = '<p class="status-msg err">Couldn\'t save that: ' + esc(res.error.message) + "</p>";
      return;
    }
    panelState.keepScroll = true;
    await refreshOverview();
  }

  // ---- shared bits -------------------------------------------------
  function personRows(m, ev) {
    var s = m.perEvent.get(ev.id);
    return s.rows.map(function (r) {
      return { r: r, name: m.nameOf(r), host: r.guest_of ? (m.profName.get(r.guest_of) || "a member") : null };
    });
  }
  function payChip(st) {
    st = st || "unpaid";
    return st === "confirmed" ? '<span class="pay-status is-confirmed">Paid</span>'
      : st === "claimed" ? '<span class="pay-status is-claimed">Says paid</span>'
      : '<span class="pay-status">Unpaid</span>';
  }
  function payButton(r) {
    var st = r.payment_status || "unpaid";
    return st === "confirmed"
      ? '<button type="button" class="ov-mini" data-act="unconfirm" data-id="' + r.id + '">Undo</button>'
      : '<button type="button" class="ov-mini ov-mini-go" data-act="confirm" data-id="' + r.id + '">Confirm</button>';
  }
  function jumpBtn(label, target) {
    return '<button type="button" class="btn btn-outline btn-small" data-go=\'' + esc(JSON.stringify(target)) + '\'>' + esc(label) + "</button>";
  }
  function section(title, html) { return '<section class="ov-p-sec"><h5>' + title + "</h5>" + html + "</section>"; }

  // ---- a round ------------------------------------------------------
  function roundPanel(id) {
    var m = M, ev = m.d.events.find(function (e) { return e.id === id; });
    if (!ev) return null;
    var s = m.perEvent.get(id);
    var played = ev.event_date < m.today;
    var idx = m.rounds.indexOf(ev);
    var prev = idx > 0 ? m.rounds[idx - 1] : null, next = idx > -1 && idx < m.rounds.length - 1 ? m.rounds[idx + 1] : null;
    var html = '<div class="ov-p-nav">' +
      (prev ? '<button type="button" class="ov-plain ov-underline" data-round="' + prev.id + '">← ' + esc(prev.name) + "</button>" : "<span></span>") +
      (next ? '<button type="button" class="ov-plain ov-underline" data-round="' + next.id + '">' + esc(next.name) + " →</button>" : "<span></span>") + "</div>";
    html += '<div data-panel-msg></div>';

    html += '<dl class="ov-meta">' +
      "<div><dt>Date</dt><dd>" + esc(niceDate(ev.event_date, true)) + "</dd></div>" +
      "<div><dt>Venue</dt><dd>" + esc(ev.venue || "TBC") + "</dd></div>" +
      "<div><dt>Meet / tee</dt><dd>" + (hhmm(ev.meet_time) || "–") + " / " + (hhmm(ev.tee_time) || "–") + "</dd></div>" +
      "<div><dt>Cost</dt><dd>" + (ev.cost != null ? money(ev.cost) : "Not set") + "</dd></div>" +
      (played ? "" : "<div><dt>Sign-ups</dt><dd>" + (m.today > s.closes ? "Closed " : "Close ") + esc(niceDate(s.closes)) + "</dd></div>") +
      "</dl>";

    if (played) {
      var res = s.results.slice().sort(function (a, b) { return (Number(b.points) || 0) - (Number(a.points) || 0); });
      var rows = res.map(function (r) { var pl = m.playerById.get(r.player_id); return { name: pl ? pl.name : "Player", points: Number(r.points) || 0, gross: r.gross_score }; });
      var pos = positions(rows, "points");
      var avg = rows.length ? Math.round(rows.reduce(function (a, r) { return a + r.points; }, 0) / rows.length) : 0;
      html += section("Results · " + rows.length + " played" + (rows.length ? " · avg " + avg + " pts" : ""),
        rows.length ? '<div class="ov-tbl"><table><thead><tr><th>Pos</th><th>Player</th><th class="ov-num">Gross</th><th class="ov-num">Pts</th></tr></thead><tbody>' +
          rows.map(function (r, i) { return '<tr class="ov-row-link" data-player="' + esc(r.name) + '" tabindex="0"><td class="ov-pos">' + pos[i] + "</td><td>" + esc(r.name) + '</td><td class="ov-num">' + (r.gross != null ? esc(r.gross) : "–") + '</td><td class="ov-num"><b>' + r.points + "</b></td></tr>"; }).join("") +
          "</tbody></table></div>" : '<p class="small">No results entered yet.</p>');
      var p = s.prize || {};
      var comps = (window.ROUND_COMPETITIONS || []).filter(function (c) { return p[c.winner] || (window.competitionHole && window.competitionHole(ev, c)); });
      var prizeList = [["1st", p.first_place], ["2nd", p.second_place], ["3rd", p.third_place], ["Winning pair", p.winning_pair]]
        .concat(comps.map(function (c) { var h = window.competitionHole ? window.competitionHole(ev, c) : null; return [c.title + (h ? " (H" + h + ")" : ""), p[c.winner]]; }));
      html += section("Prizes", s.prize ? '<dl class="ov-prize-list">' + prizeList.map(function (x) {
        var names = x[1] ? String(x[1]).split(/\s*&\s*/).map(function (n) { return '<button type="button" class="ov-plain ov-underline" data-player="' + esc(n) + '">' + esc(n) + "</button>"; }).join(" &amp; ") : '<span class="small">Not recorded</span>';
        return "<div><dt>" + esc(x[0]) + "</dt><dd>" + names + "</dd></div>";
      }).join("") + "</dl>" : '<p class="small">Prizes not recorded yet.</p>');
    } else {
      var people = personRows(m, ev);
      var playing = people.filter(function (x) { return x.r.status !== "waiting"; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      var waiting = people.filter(function (x) { return x.r.status === "waiting"; });
      var line = function (x) {
        return '<li><span class="ov-p-name"><button type="button" class="ov-plain ov-underline" data-player="' + esc(x.name) + '">' + esc(x.name) + "</button>" +
          (x.host ? ' <span class="small">guest of ' + esc(x.host) + "</span>" : "") + "</span>" +
          (x.r.status === "waiting" ? '<button type="button" class="ov-mini ov-mini-go" data-act="place" data-id="' + x.r.id + '">Give a place</button>'
            : (ev.cost ? payChip(x.r.payment_status) + payButton(x.r) : "")) + "</li>";
      };
      html += section("Playing · " + playing.length + " of " + s.cap + (s.dups.length ? ' · <span class="ov-warn-text">' + s.dups.length + " on twice</span>" : ""),
        playing.length ? '<ul class="ov-p-list">' + playing.map(line).join("") + "</ul>" : '<p class="small">Nobody registered yet.</p>');
      if (waiting.length) html += section("Waiting list · in order", '<ul class="ov-p-list">' + waiting.map(line).join("") + "</ul>");
      var compsOn = window.competitionsOn ? window.competitionsOn(ev) : [];
      html += section("Side competitions", compsOn.length ? '<div class="ov-comps">' + compsOn.map(function (c) { return '<span class="ov-comp">' + esc(c.title) + " <b>H" + window.competitionHole(ev, c) + "</b></span>"; }).join("") + "</div>" : '<p class="small">None set yet.</p>');
      var groups = new Map();
      m.d.groupings.filter(function (g) { return g.event_id === id && g.group_type === "fours"; }).forEach(function (g) {
        var nm = g.profile_id ? (m.profName.get(g.profile_id) || "Member") : ((m.playerById.get(g.player_id) || {}).name || "Player");
        if (!groups.has(g.group_number)) groups.set(g.group_number, []);
        groups.get(g.group_number).push(nm);
      });
      html += section("Tee groups", groups.size ? '<div class="ov-groups">' + Array.from(groups.entries()).sort(function (a, b) { return a[0] - b[0]; }).map(function (g) {
        return '<div class="ov-group"><span>Group ' + g[0] + "</span>" + g[1].sort().map(function (n) { return '<button type="button" class="ov-plain" data-player="' + esc(n) + '">' + esc(n) + "</button>"; }).join("") + "</div>";
      }).join("") + "</div>" : '<p class="small">Not drawn yet.</p>');
    }

    if (ev.cost && s.playing.length) {
      html += section("Money", '<div class="ov-money">' +
        '<button type="button" class="ov-money-box" data-pay="' + id + '" data-filter="confirmed"><b>' + money(s.confirmed * ev.cost) + "</b><span>" + s.confirmed + " confirmed</span></button>" +
        '<button type="button" class="ov-money-box" data-pay="' + id + '" data-filter="claimed"><b>' + s.claimed + "</b><span>say they've paid</span></button>" +
        '<button type="button" class="ov-money-box" data-pay="' + id + '" data-filter="unpaid"><b>' + money(s.unpaid * ev.cost) + "</b><span>" + s.unpaid + " unpaid</span></button></div>");
    }

    html += '<div class="ov-btns ov-p-actions">' + (played
      ? jumpBtn("Edit results", { tab: "results", select: "event-select", event: id }) + jumpBtn("Round prizes", { tab: "results", select: "prize-event-select", event: id }) + jumpBtn("Who's paid", { tab: "money", select: "pay-event-select", event: id })
      : jumpBtn("Edit fixture", { tab: "fixtures", select: "edit-event-select", event: id }) + jumpBtn("Who's playing", { tab: "fixtures", select: "playing-event-select", event: id }) + jumpBtn("Tee groups", { tab: "fixtures", select: "group-event-select", event: id }) + jumpBtn("Pairs", { tab: "fixtures", select: "pair-event-select", event: id })) +
      '<a class="btn btn-outline btn-small" href="fixtures.html#event-' + id + '" target="_blank" rel="noopener">Public page ↗</a></div>';

    return { kicker: played ? "Played round" : "Upcoming round", title: ev.name + (ev.venue ? " · " + ev.venue : ""), html: html };
  }

  // ---- a player -----------------------------------------------------
  function playerPanel(name) {
    var m = M, lower = String(name).trim().toLowerCase();
    var players = m.d.players.filter(function (p) { return p.name.trim().toLowerCase() === lower; });
    var playerIds = new Set(players.map(function (p) { return p.id; }));
    var profileIds = new Set(players.map(function (p) { return p.profile_id; }).filter(Boolean));
    m.d.profiles.forEach(function (p) { if ((p.display_name || "").trim().toLowerCase() === lower) profileIds.add(p.id); });
    if (!playerIds.size && !profileIds.size) return { kicker: "Player", title: name, html: '<p class="small">Not in the player list. The name may have been typed differently in the prizes.</p>' };

    var handicap = (players.find(function (p) { return p.handicap != null; }) || {}).handicap;
    var oom = orderOfMerit(m), opos = positions(oom, "points");
    var oi = oom.findIndex(function (r) { return r.name.trim().toLowerCase() === lower; });
    var side = sideComps(m).find(function (r) { return r.name.trim().toLowerCase() === lower; });

    var html = '<div class="ov-p-stats">' +
      "<div><b>" + (oi > -1 ? opos[oi] : "–") + "</b><span>Order of Merit</span></div>" +
      "<div><b>" + (oi > -1 ? oom[oi].points : 0) + "</b><span>points</span></div>" +
      "<div><b>" + (oi > -1 ? oom[oi].rounds : 0) + "</b><span>rounds played</span></div>" +
      "<div><b>" + (side ? side.total : 0) + "</b><span>side comp wins</span></div>" +
      (handicap != null ? "<div><b>" + esc(handicap) + "</b><span>handicap</span></div>" : "") + "</div>";

    // Points in every round of the season, as a little bar strip.
    var per = m.rounds.map(function (ev) {
      var r = m.perEvent.get(ev.id).results.find(function (x) { return playerIds.has(x.player_id); });
      return { ev: ev, pts: r ? Number(r.points) || 0 : null };
    });
    var maxPts = Math.max.apply(null, per.map(function (x) { return x.pts || 0; }).concat([1]));
    html += section("Points by round", '<div class="ov-strip">' + per.map(function (x) {
      var future = x.ev.event_date >= m.today;
      return '<button type="button" class="ov-strip-bar" data-round="' + x.ev.id + '" title="' + esc(x.ev.name + ": " + (x.pts != null ? x.pts + " pts" : future ? "not played yet" : "didn't play")) + '">' +
        "<em>" + (x.pts != null ? x.pts : "") + '</em><i class="' + (x.pts == null ? "ov-strip-none" : "") + '" style="height:' + (x.pts != null ? Math.max(4, x.pts / maxPts * 100) : 4) + '%"></i><span>' + esc(x.ev.name.replace("Round ", "R")) + "</span></button>";
    }).join("") + "</div>");

    // Prizes won.
    var won = [];
    m.d.prizes.forEach(function (p) {
      var ev = m.d.events.find(function (e) { return e.id === p.event_id; }); if (!ev) return;
      var check = function (val, label) {
        if (!val) return;
        var names = String(val).split(/\s*&\s*/).map(function (n) { return n.trim().toLowerCase(); });
        if (names.indexOf(lower) > -1) won.push({ ev: ev, label: label });
      };
      check(p.first_place, "1st"); check(p.second_place, "2nd"); check(p.third_place, "3rd"); check(p.winning_pair, "Winning pair");
      (window.ROUND_COMPETITIONS || []).forEach(function (c) { check(p[c.winner], c.title); });
    });
    won.sort(function (a, b) { return a.ev.event_date.localeCompare(b.ev.event_date); });
    html += section("Prizes won · " + won.length, won.length ? '<ul class="ov-p-list">' + won.map(function (w) {
      return '<li><span class="ov-p-name">' + esc(w.label) + '</span><button type="button" class="ov-plain ov-underline" data-round="' + w.ev.id + '">' + esc(w.ev.name) + "</button></li>";
    }).join("") + "</ul>" : '<p class="small">None yet.</p>');

    // Rounds they're down for and what they owe.
    var rows = m.d.attendance.filter(function (a) { return playerIds.has(a.player_id) || profileIds.has(a.profile_id); });
    var guestRows = m.d.attendance.filter(function (a) { return a.guest_of && profileIds.has(a.guest_of); });
    var entries = rows.map(function (a) { return { a: a, ev: m.d.events.find(function (e) { return e.id === a.event_id; }), guest: null }; })
      .concat(guestRows.map(function (a) { return { a: a, ev: m.d.events.find(function (e) { return e.id === a.event_id; }), guest: m.nameOf(a) }; }))
      .filter(function (x) { return x.ev; }).sort(function (a, b) { return b.ev.event_date.localeCompare(a.ev.event_date); });
    html += '<div data-panel-msg></div>';
    html += section("Sign-ups and payments", entries.length ? '<ul class="ov-p-list">' + entries.map(function (x) {
      return '<li><span class="ov-p-name"><button type="button" class="ov-plain ov-underline" data-round="' + x.ev.id + '">' + esc(x.ev.name) + "</button>" +
        (x.guest ? ' <span class="small">guest: ' + esc(x.guest) + "</span>" : "") + (x.a.status === "waiting" ? ' <span class="pay-status is-claimed">Waiting</span>' : "") + "</span>" +
        (x.ev.cost && x.a.status !== "waiting" ? payChip(x.a.payment_status) + payButton(x.a) : "") + "</li>";
    }).join("") + "</ul>" : '<p class="small">No sign-ups on record.</p>');

    return { kicker: "Player", title: players[0] ? players[0].name : name, html: html };
  }

  // ---- a round's payments ---------------------------------------------
  function payPanel(id, filter) {
    var m = M, ev = m.d.events.find(function (e) { return e.id === id; });
    if (!ev) return null;
    var s = m.perEvent.get(id);
    var people = personRows(m, ev).filter(function (x) { return x.r.status !== "waiting"; });
    var counts = { all: people.length, unpaid: 0, claimed: 0, confirmed: 0 };
    people.forEach(function (x) { counts[x.r.payment_status || "unpaid"]++; });
    var shown = people.filter(function (x) { return filter === "all" || (x.r.payment_status || "unpaid") === filter; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
    var labels = { all: "Everyone", unpaid: "Unpaid", claimed: "Say they've paid", confirmed: "Confirmed" };

    var html = '<div class="ov-filter">' + ["all", "unpaid", "claimed", "confirmed"].map(function (f) {
      return '<button type="button" class="btn btn-small ' + (f === filter ? "btn-brass" : "btn-outline") + '" data-filter-tab="' + f + '" aria-pressed="' + (f === filter) + '">' + labels[f] + " (" + counts[f] + ")</button>";
    }).join("") + "</div>";
    if (ev.cost) html += '<p class="small">' + money(s.confirmed * ev.cost) + " of " + money(people.length * ev.cost) + " confirmed · " + money(ev.cost) + " each.</p>";
    html += '<div data-panel-msg></div>';
    html += shown.length ? '<ul class="ov-p-list">' + shown.map(function (x) {
      return '<li><span class="ov-p-name"><button type="button" class="ov-plain ov-underline" data-player="' + esc(x.name) + '">' + esc(x.name) + "</button>" +
        (x.host ? ' <span class="small">guest of ' + esc(x.host) + ", who pays</span>" : "") + "</span>" + payChip(x.r.payment_status) + payButton(x.r) + "</li>";
    }).join("") + "</ul>" : '<p class="small">Nobody in this list.</p>';

    var unpaidNames = people.filter(function (x) { return (x.r.payment_status || "unpaid") === "unpaid"; }).map(function (x) { return x.host ? x.host + " (for " + x.name + ")" : x.name; });
    html += '<div class="ov-btns ov-p-actions">' +
      (unpaidNames.length ? '<button type="button" class="btn btn-brass btn-small" data-copy-list="' + esc(ev.name + (ev.venue ? " · " + ev.venue : "") + " – still to pay (" + money(ev.cost || 0) + " each):\n" + Array.from(new Set(unpaidNames)).sort().join(", ")) + '">Copy unpaid list</button>' : "") +
      jumpBtn("Open in Who's paid", { tab: "money", select: "pay-event-select", event: id }) +
      '<button type="button" class="btn btn-outline btn-small" data-round="' + id + '">Round details</button></div>';

    return { kicker: "Payments", title: ev.name + (ev.venue ? " · " + ev.venue : ""), html: html };
  }

  function render(m) {
    root.innerHTML =
      '<div class="ov-toolbar"><span class="small">Updated ' + new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) + '</span><button type="button" class="btn btn-outline btn-small" data-ov-refresh>Refresh</button></div>' +
      '<div class="ov-grid"><div class="ov-stack">' + renderNext(m) + renderTodos(m) + renderSeason(m) + '</div><div class="ov-stack">' + renderLast(m) + renderStandings(m) + "</div></div>";

    root.querySelectorAll("[data-go]").forEach(function (b) {
      b.addEventListener("click", function () { try { goTo(JSON.parse(b.getAttribute("data-go"))); } catch (e) { console.error(e); } });
    });
    if (!root.__ovDelegated) {
      root.__ovDelegated = true;
      root.addEventListener("click", function (e) {
        var t = e.target.closest("[data-round],[data-player],[data-pay]");
        if (t && root.contains(t)) onClick(e);
      });
      root.addEventListener("keydown", function (e) {
        if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("tr[data-round],tr[data-player]")) { e.preventDefault(); onClick(e); }
      });
    }
    root.querySelectorAll("[data-ov-lb]").forEach(function (b) {
      b.addEventListener("click", function () {
        var which = b.getAttribute("data-ov-lb");
        root.querySelectorAll("[data-ov-lb]").forEach(function (x) { var on = x === b; x.className = "btn btn-small " + (on ? "btn-brass" : "btn-outline"); x.setAttribute("aria-pressed", on); });
        root.querySelectorAll("[data-ov-panel]").forEach(function (p) { p.hidden = p.getAttribute("data-ov-panel") !== which; });
      });
    });
    var copy = root.querySelector("[data-copy-reminder]");
    if (copy) copy.addEventListener("click", function () {
      var text = reminderText(m), out = root.querySelector(".ov-copied");
      var done = function () { out.textContent = "Reminder copied. Paste it into the WhatsApp group."; };
      var fallback = function () {
        var ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); done(); } catch (e) { out.textContent = "Couldn't copy automatically."; }
        ta.remove();
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
    });
    var refresh = root.querySelector("[data-ov-refresh]");
    if (refresh) refresh.addEventListener("click", function () { refreshOverview(); });
  }

  async function refreshOverview() {
    if (!root || loading || typeof client === "undefined" || !client) return;
    loading = true;
    try {
      M = model(await load());
      render(M);
      if (panelState && drawer && !drawer.hidden) openPanel(panelState);
    } catch (err) {
      console.error(err);
      root.innerHTML = '<p class="status-msg err">Couldn\'t load the overview: ' + esc(err.message || err) + '</p><button type="button" class="btn btn-outline btn-small" data-ov-refresh>Try again</button>';
      var r = root.querySelector("[data-ov-refresh]"); if (r) r.addEventListener("click", refreshOverview);
    } finally {
      loading = false;
    }
  }
  window.fgsRefreshOverview = refreshOverview;
  window.fgsOverviewOpen = openPanel; // e.g. fgsOverviewOpen({ type: "player", id: "Jon Chapman" })
  window.__fgsOverviewDebug = { roundPanel: roundPanel, playerPanel: playerPanel, payPanel: payPanel, setModel: function (x) { M = x; }, model: model };

  function injectStyles() {
    if (document.getElementById("ov-styles")) return;
    var css = [
      "#overview-card{background:transparent;border:0;box-shadow:none;padding:0;}",
      "#overview-card>h3{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}",
      ".ov-toolbar{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-bottom:12px;}",
      ".ov-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,460px),1fr));gap:18px;align-items:start;}",
      ".ov-stack{display:grid;gap:18px;min-width:0;}",
      ".ov-card{background:var(--panel,#fff);border:1px solid var(--line);border-radius:var(--radius,3px);padding:18px;min-width:0;box-shadow:var(--shadow-card);}",
      ".ov-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:12px;}",
      ".ov-head h4{margin:0;font-family:var(--font-display);text-transform:uppercase;color:var(--navy);font-size:1.05rem;}",
      ".ov-link{background:none;border:0;padding:0;font:inherit;font-size:.82rem;font-weight:600;color:var(--navy);border-bottom:1px solid var(--line);cursor:pointer;text-decoration:none;}",
      ".ov-link.btn{border:1px solid var(--navy);padding:6px 14px;font-family:var(--font-display);}",
      ".ov-link:focus-visible,.ov-go:focus-visible{outline:2px solid var(--gold);outline-offset:2px;}",
      ".ov-round-top{display:flex;flex-wrap:wrap;gap:16px;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:12px;}",
      ".ov-round-name{font-family:var(--font-display);font-size:1.45rem;text-transform:uppercase;color:var(--navy);line-height:1.15;}",
      ".ov-countdown{text-align:right}.ov-countdown b{font-family:var(--font-display);font-size:2rem;color:var(--gold);display:block;line-height:1;}",
      ".ov-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px 14px;margin:0 0 14px;}",
      ".ov-meta dt{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-soft);}.ov-meta dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums;}",
      ".ov-meter-row{margin-bottom:14px}.ov-meter-label{display:flex;justify-content:space-between;gap:8px;font-size:.86rem;margin-bottom:5px;font-variant-numeric:tabular-nums;}",
      ".ov-meter{height:10px;background:#E3E8F1;border-radius:2px;overflow:hidden;display:flex}.ov-meter span{display:block;height:100%}",
      ".ov-fill-navy{background:var(--navy)}.ov-fill-ok{background:#2E7D4F}.ov-fill-warn{background:#C98A1B}.ov-fill-track{background:#E3E8F1;border:1px solid var(--line)}",
      ".ov-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:.8rem;color:var(--ink-soft);margin-top:6px}",
      ".ov-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:middle}",
      ".ov-comps{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}.ov-comp{border:1px solid var(--line);border-radius:3px;padding:5px 10px;font-size:.82rem}.ov-comp b{font-family:var(--font-mono);color:var(--gold)}",
      ".ov-btns{display:flex;flex-wrap:wrap;gap:8px}.ov-copied{min-height:1.3em;margin-top:6px;color:#2E7D4F}",
      ".ov-players{margin-top:10px;border-top:1px solid var(--line);padding-top:10px}.ov-players summary,.ov-rounds summary{cursor:pointer;font-weight:600;font-size:.88rem;color:var(--navy)}",
      ".ov-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.ov-chip{font-size:.78rem;padding:3px 8px;border-radius:2px;background:#F8E1DE;color:#8E2F25}.ov-chip-dup{background:#FBEFD9;color:#8A560B;font-weight:600}",
      ".ov-actions{list-style:none;margin:0;padding:0;display:grid;gap:8px}",
      ".ov-actions li{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:3px}",
      ".ov-t{font-size:.88rem;min-width:0}.ov-t b{color:var(--ink)}",
      ".ov-go{background:none;border:0;font:inherit;font-size:.82rem;font-weight:700;color:var(--navy);cursor:pointer;white-space:nowrap;padding:4px 0}",
      ".ov-go:hover,.ov-link:hover{color:var(--gold)}",
      ".ov-pill{font-family:var(--font-mono);font-size:.66rem;letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;border-radius:2px;white-space:nowrap}",
      ".ov-p-bad{background:#F8E1DE;color:#8E2F25}.ov-p-warn{background:#FBEFD9;color:#8A560B}.ov-p-info{background:rgba(27,58,108,.08);color:var(--navy)}",
      ".ov-podium{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}.ov-podium>div{border:1px solid var(--line);border-radius:3px;padding:10px;text-align:center;min-width:0}",
      ".ov-place{font-family:var(--font-display);color:var(--gold);font-size:1.25rem;line-height:1}.ov-who{font-weight:600;font-size:.88rem;margin-top:4px;overflow-wrap:anywhere}.ov-pts{font-family:var(--font-mono);font-size:.76rem;color:var(--ink-soft)}",
      ".ov-prizes{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px 14px;font-size:.85rem;margin-bottom:10px}.ov-prizes span{display:block;color:var(--ink-soft);font-size:.72rem;text-transform:uppercase;letter-spacing:.06em}",
      ".ov-tbl{overflow-x:auto}.ov-tbl table{width:100%;border-collapse:collapse;font-size:.88rem;font-variant-numeric:tabular-nums}",
      ".ov-tbl th{font-family:var(--font-mono);font-size:.66rem;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-soft);text-align:left;font-weight:600;padding:6px 8px;border-bottom:1px solid var(--line)}",
      ".ov-tbl td{padding:7px 8px;border-bottom:1px solid var(--line)}.ov-num{text-align:right}",
      ".ov-pos{font-family:var(--font-display);color:var(--navy);width:2.6em}.ov-mv{font-family:var(--font-mono);font-size:.76rem}.ov-up{color:#2E7D4F}.ov-down{color:#8E2F25}.ov-same{color:var(--ink-soft)}",
      ".ov-subtabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}",
      ".ov-bars{display:grid;gap:6px;align-items:end;height:150px;margin-top:6px;border-bottom:1px solid var(--line);position:relative}",
      ".ov-bar{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;min-width:0}",
      ".ov-bar i{display:block;width:100%;max-width:34px;background:var(--navy);border-radius:2px 2px 0 0}",
      ".ov-bar i.ov-future{background:repeating-linear-gradient(45deg,#E3E8F1,#E3E8F1 4px,transparent 4px,transparent 8px);border:1px dashed var(--line)}",
      ".ov-bar em{font-style:normal;font-family:var(--font-mono);font-size:.72rem;margin-bottom:3px}",
      ".ov-avg{position:absolute;left:0;right:0;border-top:1px dashed var(--gold);pointer-events:none}.ov-avg span{position:absolute;right:0;top:-18px;font-family:var(--font-mono);font-size:.66rem;color:var(--gold)}",
      ".ov-bar-labels{display:grid;gap:6px;margin-top:4px}.ov-bar-labels span{text-align:center;font-family:var(--font-mono);font-size:.66rem;color:var(--ink-soft)}",
      ".ov-money{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:14px}.ov-money div{border:1px solid var(--line);border-radius:3px;padding:10px}",
      ".ov-money b{display:block;font-family:var(--font-display);font-size:1.2rem;color:var(--navy)}.ov-money span{font-size:.78rem;color:var(--ink-soft)}",
      "@keyframes ovFlash{0%{box-shadow:0 0 0 0 rgba(184,146,60,.0)}20%{box-shadow:0 0 0 4px rgba(184,146,60,.55)}100%{box-shadow:0 0 0 0 rgba(184,146,60,0)}}",
      ".ov-flash{animation:ovFlash 2.2s ease-out 1}",
      ".ov-mark{background:#FBEFD9 !important;outline:2px solid #C98A1B;outline-offset:-2px}",
      /* things that can be clicked */
      ".ov-plain{background:none;border:0;padding:0;margin:0;font:inherit;color:inherit;text-align:inherit;cursor:pointer;}",
      ".ov-underline{text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:3px;}",
      ".ov-plain:hover,.ov-underline:hover{color:var(--gold);text-decoration-color:var(--gold);}",
      ".ov-plain:focus-visible,.ov-bar:focus-visible,.ov-money-box:focus-visible,.ov-row-link:focus-visible,.ov-chip:focus-visible,.ov-meter-click button:focus-visible{outline:2px solid var(--gold);outline-offset:2px;}",
      "button.ov-round-name{display:block;text-align:left;}",
      ".ov-chip{border:0;cursor:pointer;font:inherit;font-size:.78rem;}.ov-chip:hover{filter:brightness(.95);text-decoration:underline;}",
      ".ov-row-link{cursor:pointer;}.ov-row-link:hover td{background:rgba(27,58,108,.05);}",
      ".ov-legend-btn{font-size:.8rem;color:var(--ink-soft);}",
      ".ov-meter-click{height:12px;}.ov-meter-click button{border:0;padding:0;cursor:pointer;height:100%;min-width:0;}",
      ".ov-meter-click .ov-fill-rest{background:transparent;}.ov-meter-click button:hover{filter:brightness(1.12);box-shadow:inset 0 0 0 2px rgba(16,35,63,.25);}",
      "button.ov-money-box{display:block;width:100%;text-align:left;background:var(--panel,#fff);border:1px solid var(--line);border-radius:3px;padding:10px;cursor:pointer;font:inherit;}",
      "button.ov-money-box:hover{border-color:var(--navy);box-shadow:0 6px 14px -10px rgba(16,35,63,.5);}",
      "button.ov-money-box b{display:block;font-family:var(--font-display);font-size:1.2rem;color:var(--navy)}button.ov-money-box span{font-size:.78rem;color:var(--ink-soft)}",
      /* the bar chart */
      "button.ov-bar{background:none;border:0;padding:0;cursor:pointer;position:relative;font:inherit;color:inherit;}",
      "button.ov-bar:hover i,button.ov-bar:focus-visible i{background:var(--gold);}button.ov-bar:hover i.ov-future,button.ov-bar:focus-visible i.ov-future{background:repeating-linear-gradient(45deg,#F1E3BF,#F1E3BF 4px,transparent 4px,transparent 8px);border-color:var(--gold);}",
      ".ov-tip{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:var(--navy-dark,#10233F);color:#fff;font-size:.74rem;line-height:1.45;padding:8px 10px;border-radius:3px;white-space:nowrap;text-align:left;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .12s;z-index:5;box-shadow:0 8px 18px -8px rgba(0,0,0,.5);}",
      ".ov-tip b{color:#fff}.ov-tip-cta{color:var(--gold-light,#D9BE7C);font-size:.7rem}",
      "button.ov-bar:hover .ov-tip,button.ov-bar:focus-visible .ov-tip{opacity:1;visibility:visible;}",
      ".ov-bars>button.ov-bar:first-of-type .ov-tip{left:0;transform:none}.ov-bars>button.ov-bar:last-of-type .ov-tip{left:auto;right:0;transform:none}",
      /* side panel */
      ".ov-no-scroll{overflow:hidden;}",
      ".ov-drawer-wrap{position:fixed;inset:0;z-index:1000;}",
      ".ov-scrim{position:absolute;inset:0;background:rgba(16,35,63,.45);}",
      ".ov-drawer{position:absolute;top:0;right:0;bottom:0;width:min(560px,100%);background:var(--paper,#F3F5F9);box-shadow:-18px 0 40px -20px rgba(0,0,0,.5);display:flex;flex-direction:column;outline:none;animation:ovSlide .18s ease-out;}",
      "@keyframes ovSlide{from{transform:translateX(24px);opacity:.6}to{transform:none;opacity:1}}",
      ".ov-drawer-head{position:relative;padding:18px 56px 14px 20px;padding-top:calc(18px + env(safe-area-inset-top,0px));background:var(--navy);color:#fff;}",
      ".ov-drawer-head h3{color:#fff;margin:2px 0 0;font-size:1.25rem;text-wrap:balance}.ov-drawer-kicker{color:var(--gold-light,#D9BE7C);text-transform:uppercase;letter-spacing:.12em;font-family:var(--font-mono);font-size:.7rem}",
      ".ov-close{position:absolute;top:calc(12px + env(safe-area-inset-top,0px));right:12px;width:36px;height:36px;border-radius:50%;border:1px solid rgba(255,255,255,.35);background:transparent;color:#fff;font-size:1.4rem;line-height:1;cursor:pointer;}.ov-close:hover{background:rgba(255,255,255,.12)}.ov-close:focus-visible{outline:2px solid var(--gold);outline-offset:2px}",
      ".ov-drawer-body{flex:1;overflow-y:auto;padding:16px 20px 28px;padding-bottom:calc(28px + env(safe-area-inset-bottom,0px));display:grid;gap:16px;align-content:start;}",
      ".ov-p-nav{display:flex;justify-content:space-between;font-size:.82rem;font-weight:600;color:var(--navy)}",
      ".ov-p-sec{background:var(--panel,#fff);border:1px solid var(--line);border-radius:3px;padding:14px;min-width:0}",
      ".ov-p-sec h5{margin:0 0 10px;font-family:var(--font-display);text-transform:uppercase;color:var(--navy);font-size:.92rem;letter-spacing:.02em}",
      ".ov-p-list{list-style:none;margin:0;padding:0}.ov-p-list li{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--line);font-size:.88rem}.ov-p-list li:last-child{border-bottom:0}",
      ".ov-p-name{flex:1;min-width:0}",
      ".ov-mini{font:inherit;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:4px 10px;border-radius:3px;border:1px solid var(--navy);background:transparent;color:var(--navy);cursor:pointer;white-space:nowrap}",
      ".ov-mini-go{background:var(--navy);color:#fff}.ov-mini:hover{filter:brightness(1.15)}.ov-mini:disabled{opacity:.5;cursor:wait}",
      ".ov-warn-text{color:#8A560B}",
      ".ov-prize-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px 14px;margin:0;font-size:.88rem}.ov-prize-list dt{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-soft)}.ov-prize-list dd{margin:0}",
      ".ov-groups{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}.ov-group{border:1px solid var(--line);border-radius:3px;padding:8px;display:flex;flex-direction:column;gap:2px;font-size:.84rem}.ov-group span{font-family:var(--font-mono);font-size:.68rem;color:var(--gold);text-transform:uppercase}",
      ".ov-p-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:8px}.ov-p-stats div{background:var(--panel,#fff);border:1px solid var(--line);border-radius:3px;padding:10px}.ov-p-stats b{display:block;font-family:var(--font-display);font-size:1.4rem;color:var(--navy);line-height:1.1}.ov-p-stats span{font-size:.74rem;color:var(--ink-soft)}",
      ".ov-strip{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:4px;height:120px;align-items:end}",
      ".ov-strip-bar{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;background:none;border:0;padding:0;cursor:pointer;font:inherit;min-width:0}",
      ".ov-strip-bar i{display:block;width:100%;max-width:26px;background:var(--navy);border-radius:2px 2px 0 0}.ov-strip-bar i.ov-strip-none{background:#E3E8F1}",
      ".ov-strip-bar em{font-style:normal;font-family:var(--font-mono);font-size:.68rem;margin-bottom:2px}.ov-strip-bar span{font-family:var(--font-mono);font-size:.62rem;color:var(--ink-soft);margin-top:3px}",
      ".ov-strip-bar:hover i{background:var(--gold)}.ov-strip-bar:focus-visible{outline:2px solid var(--gold)}",
      ".ov-filter{display:flex;flex-wrap:wrap;gap:6px}",
      ".ov-p-actions{padding-top:4px}",
      "@media (prefers-reduced-motion:reduce){.ov-flash{animation:none;outline:3px solid var(--gold)}}",
      "@media (max-width:520px){.ov-actions li{grid-template-columns:1fr;gap:6px}.ov-countdown{text-align:left}}"
    ].join("\n");
    var st = document.createElement("style"); st.id = "ov-styles"; st.textContent = css; document.head.appendChild(st);
  }

  function start() {
    root = document.getElementById("overview-root");
    if (!root) return;
    injectStyles();
    // Load once the committee is signed in and the dashboard is showing.
    var tries = 0;
    var timer = setInterval(function () {
      var dash = document.getElementById("dashboard");
      if (dash && dash.style.display !== "none" && typeof client !== "undefined" && client) {
        clearInterval(timer); refreshOverview();
      } else if (++tries > 240) clearInterval(timer);
    }, 250);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
