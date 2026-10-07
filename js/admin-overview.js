/* Committee Overview: the first tab on the admin page.

   One screen that answers "what's happening and what needs doing":
   the next round (sign-ups, payments, side comps), a to-do list built
   from the live data, the last round's results, the standings and the
   season so far.

   Every to-do item and shortcut opens the tab where the job is done,
   picks the right round in that section's fixture list and scrolls to
   it with a brief highlight, so you land exactly where the work is.

   Read-only: nothing on this tab writes to the database. It reuses
   the page's signed-in Supabase client (`client`, from admin.js). */

(function () {
  "use strict";

  var root = null;
  var loading = false;

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
      client.from("players").select("id, name, profile_id"),
      client.from("results").select("event_id, player_id, points"),
      client.from("event_prizes").select("*"),
      client.from("memberships").select("profile_id", { count: "exact", head: true }).eq("status", "pending"),
      client.from("photos").select("id", { count: "exact", head: true }).eq("status", "pending"),
      client.from("hole_in_one_ledger").select("amount"),
      client.from("league_settings").select("*").maybeSingle(),
      client.from("groupings").select("event_id, group_type")
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
      '<div class="ov-round-top"><div><div class="ov-round-name">' + esc(roundLabel(ev)) + '</div><div class="small">' + esc(parseDate(ev.event_date).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })) + "</div></div>" +
      '<div class="ov-countdown"><b>' + (days === 0 ? "Today" : days) + "</b>" + (days === 0 ? "" : '<span class="small">' + (days === 1 ? "day" : "days") + " to go</span>") + "</div></div>" +
      '<dl class="ov-meta">' +
        "<div><dt>Meet</dt><dd>" + (hhmm(ev.meet_time) || "Not set") + "</dd></div>" +
        "<div><dt>First tee</dt><dd>" + (hhmm(ev.tee_time) || "Not set") + "</dd></div>" +
        "<div><dt>Cost</dt><dd>" + (ev.cost != null ? money(ev.cost) : "Not set") + "</dd></div>" +
        "<div><dt>Sign-ups</dt><dd>" + (closed ? "Closed " + niceDate(s.closes) : "Close " + niceDate(s.closes)) + "</dd></div>" +
        "<div><dt>Draw</dt><dd>" + (s.fours ? "Tee groups set" : "Not drawn") + "</dd></div>" +
      "</dl>" +
      '<div class="ov-meter-row"><div class="ov-meter-label"><span>Registered</span><span><b>' + s.playing.length + "</b> / " + s.cap + " places</span></div>" +
        '<div class="ov-meter"><span class="ov-fill-navy" style="width:' + pct(s.playing.length, s.cap) + '%"></span></div>' +
        '<div class="ov-legend"><span>' + Math.max(0, s.cap - s.playing.length) + " places left" + (s.waiting.length ? " · " + s.waiting.length + " waiting" : "") + (s.dups.length ? " · " + s.dups.length + " possible duplicate" + (s.dups.length > 1 ? "s" : "") : "") + "</span></div></div>" +
      (ev.cost ? '<div class="ov-meter-row"><div class="ov-meter-label"><span>Payments</span><span>' + money(received) + " of " + money(expected) + " confirmed</span></div>" +
        '<div class="ov-meter"><span class="ov-fill-ok" style="width:' + pct(s.confirmed, s.playing.length) + '%"></span><span class="ov-fill-warn" style="width:' + pct(s.claimed, s.playing.length) + '%"></span></div>' +
        '<div class="ov-legend"><span><i class="ov-dot ov-fill-ok"></i>' + s.confirmed + ' confirmed</span><span><i class="ov-dot ov-fill-warn"></i>' + s.claimed + ' say they\'ve paid</span><span><i class="ov-dot ov-fill-track"></i>' + s.unpaid + " unpaid</span></div></div>" : "") +
      (comps.length ? '<div class="small" style="margin-bottom:6px;">Side competitions</div><div class="ov-comps">' + comps.map(function (c) { return '<span class="ov-comp">' + esc(c.label + " " + c.nine.replace("front 9", "F9").replace("back 9", "B9")) + " <b>H" + window.competitionHole(ev, c) + "</b></span>"; }).join("") + "</div>" : '<p class="small">No side competitions set for this round.</p>') +
      '<div class="ov-btns">' +
        (unpaidNames.length && ev.cost ? '<button type="button" class="btn btn-brass btn-small" data-copy-reminder>Copy payment reminder</button>' : "") +
        linkBtn("Confirm payments", { tab: "money", select: "pay-event-select", event: ev.id }, "btn btn-outline btn-small") +
        linkBtn("Who's playing", { tab: "fixtures", select: "playing-event-select", event: ev.id }, "btn btn-outline btn-small") +
      '</div><div class="ov-copied small" aria-live="polite"></div>' +
      (unpaidNames.length ? '<details class="ov-players"><summary>' + unpaidNames.length + " unpaid</summary><div class=\"ov-chips\">" + unpaidNames.map(function (n) { return '<span class="ov-chip' + (s.dups.indexOf(n) > -1 ? " ov-chip-dup" : "") + '">' + esc(n) + "</span>"; }).join("") + "</div></details>" : "") +
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
      return "<tr><td>" + esc(e.name.replace("Round ", "R")) + "</td><td>" + esc(pr.first_place || "—") + "</td><td>" + esc(pr.winning_pair || "—") + "</td><td>" + (winners.length ? esc(winners.join(", ")) : "None recorded") + "</td></tr>";
    }).join("");

    return '<section class="ov-card" aria-labelledby="ov-last-h"><div class="ov-head"><h4 id="ov-last-h">Last round · ' + esc(ev.name) + "</h4>" + linkBtn("Edit results →", { tab: "results", select: "event-select", event: ev.id }) + "</div>" +
      '<div class="small" style="margin-bottom:10px;">' + esc((ev.venue || "Venue TBC") + " · " + niceDate(ev.event_date) + " · " + s.results.length + " played") + "</div>" +
      '<div class="ov-podium">' + podium.map(function (x) { return '<div><div class="ov-place">' + x[0] + '</div><div class="ov-who">' + esc(x[1]) + '</div><div class="ov-pts">' + esc(ptsFor(x[1])) + "</div></div>"; }).join("") + "</div>" +
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
      return '<tr><td class="ov-pos">' + pos[i] + "</td><td>" + (before.length ? mv : "") + "</td><td>" + esc(r.name) + '</td><td class="ov-num">' + r.rounds + '</td><td class="ov-num">' + r.points + "</td></tr>";
    }).join("");

    var side = sideComps(m);
    var spos = positions(side, "total");
    var sideRows = side.slice(0, 12).map(function (r, i) {
      return '<tr><td class="ov-pos">' + spos[i] + "</td><td>" + esc(r.name) + '</td><td class="ov-num">' + r.ld + '</td><td class="ov-num">' + r.ntp + '</td><td class="ov-num"><b>' + r.total + "</b></td></tr>";
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
      return "<div><b>" + money(s.confirmed * Number(ev.cost)) + "</b><span>" + esc(ev.name) + " received · " + s.confirmed + " of " + s.playing.length + "</span></div>";
    });
    moneyCells.push("<div><b>" + money(m.d.pot) + "</b><span>Hole in One pot</span></div>");

    var playedCount = m.played.length;
    return '<section class="ov-card" aria-labelledby="ov-season-h"><div class="ov-head"><h4 id="ov-season-h">Season so far</h4><span class="small">' + playedCount + " of " + m.rounds.length + " rounds played</span></div>" +
      '<div class="small">Players per round</div>' +
      '<div class="ov-bars" style="grid-template-columns:repeat(' + Math.max(1, bars.length) + ',1fr)">' +
        (avg ? '<div class="ov-avg" style="bottom:' + (avg / max * 100) + '%"><span>avg ' + Math.round(avg) + "</span></div>" : "") +
        bars.map(function (b) { return '<div class="ov-bar" title="' + esc(b.ev.name + ": " + b.n + (b.future ? " registered" : " played")) + '"><em>' + b.n + '</em><i class="' + (b.future ? "ov-future" : "") + '" style="height:' + (max ? b.n / max * 100 : 0) + '%"></i></div>'; }).join("") +
      "</div>" +
      '<div class="ov-bar-labels" style="grid-template-columns:repeat(' + Math.max(1, bars.length) + ',1fr)">' + bars.map(function (b) { return "<span>" + esc(b.ev.name.replace("Round ", "R")) + "</span>"; }).join("") + "</div>" +
      '<p class="small" style="margin-top:6px;">Striped bars are sign-ups for rounds not played yet.</p>' +
      '<div class="ov-money">' + moneyCells.join("") + "</div>" +
      "</section>";
  }
  function s32(m) { return m.d.settings.max_players || 32; }

  function render(m) {
    root.innerHTML =
      '<div class="ov-toolbar"><span class="small">Updated ' + new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) + '</span><button type="button" class="btn btn-outline btn-small" data-ov-refresh>Refresh</button></div>' +
      '<div class="ov-grid"><div class="ov-stack">' + renderNext(m) + renderTodos(m) + renderSeason(m) + '</div><div class="ov-stack">' + renderLast(m) + renderStandings(m) + "</div></div>";

    root.querySelectorAll("[data-go]").forEach(function (b) {
      b.addEventListener("click", function () { try { goTo(JSON.parse(b.getAttribute("data-go"))); } catch (e) { console.error(e); } });
    });
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
      render(model(await load()));
    } catch (err) {
      console.error(err);
      root.innerHTML = '<p class="status-msg err">Couldn\'t load the overview: ' + esc(err.message || err) + '</p><button type="button" class="btn btn-outline btn-small" data-ov-refresh>Try again</button>';
      var r = root.querySelector("[data-ov-refresh]"); if (r) r.addEventListener("click", refreshOverview);
    } finally {
      loading = false;
    }
  }
  window.fgsRefreshOverview = refreshOverview;

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
