// ------------------------------------------------------------------
// Wave one additions, loaded on every page by js/nav.js and doing
// nothing on pages they do not concern.
//
//   results.html      a WhatsApp share line and that round's photos,
//                     inside the panel the accordion already opens
//   leaderboard.html  season at a glance: wins, best round, averages
//   fixtures.html     add to calendar, one fixture or the whole season
//
// Everything is read from the same tables the pages already read, and
// added to the markup those pages produce rather than replacing it. If
// this file fails to load, every page behaves exactly as before.
// ------------------------------------------------------------------

(function () {
  "use strict";
  if (window.__fgsExtras) return;
  window.__fgsExtras = true;

  var client = null;
  var GALLERY = "/storage/v1/object/public/gallery/";

  function esc(v) {
    var d = document.createElement("div");
    d.textContent = v === null || v === undefined ? "" : String(v);
    return d.innerHTML;
  }

  function page() {
    return location.pathname.split("/").pop() || "index.html";
  }

  function longDate(iso) {
    return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB",
      { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
  }

  // Waits for a page's own script to finish rendering before decorating it.
  function whenPresent(selector, done) {
    var tries = 0;
    var timer = setInterval(function () {
      if (document.querySelectorAll(selector).length) { clearInterval(timer); done(); }
      if (++tries > 40) clearInterval(timer);
    }, 500);
  }

  // ---------------- results: share and photos ----------------

  function shareText(event, rows) {
    var lines = [event.name + (event.venue ? " at " + event.venue : "") + ", " + longDate(event.event_date) + "."];
    rows.slice(0, 3).forEach(function (r, i) {
      lines.push((i + 1) + ". " + ((r.players && r.players.name) || "Unknown") + " " + r.points + " pts");
    });
    if (rows.length) lines.push(rows.length + " played.");
    lines.push(location.origin + "/results.html#event-" + event.id);
    return lines.join("\n");
  }

  function decorateResults(events, resultsByEvent, photosByEvent) {
    Array.prototype.forEach.call(document.querySelectorAll(".fixture-item[data-event-id]"), function (item) {
      if (item.getAttribute("data-extras") === "done") return;
      var id = item.getAttribute("data-event-id");
      var panel = item.querySelector(".fixture-panel");
      var event = events.filter(function (e) { return e.id === id; })[0];
      if (!panel || !event) return;
      item.setAttribute("data-extras", "done");

      var rows = (resultsByEvent[id] || []).slice().sort(function (a, b) {
        return Number(b.points) - Number(a.points);
      });

      var photos = photosByEvent[id] || [];
      if (photos.length) {
        var strip = document.createElement("div");
        strip.style.cssText = "margin-top:18px;";
        strip.innerHTML =
          '<h4 class="prize-heading">Photos from the day</h4>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
          photos.slice(0, 6).map(function (p) {
            var url = SUPABASE_URL + GALLERY + p.storage_path;
            return '<a href="' + esc(url) + '" target="_blank" rel="noopener">' +
              '<img src="' + esc(url) + '" alt="' + esc(p.caption || event.name) +
              '" loading="lazy" style="width:104px;height:104px;object-fit:cover;border:1px solid var(--line);display:block;"></a>';
          }).join("") +
          "</div>" +
          (photos.length > 6
            ? '<p class="small" style="margin-top:8px;"><a href="gallery.html">All ' + photos.length + " photos from this round</a></p>"
            : "");
        panel.appendChild(strip);
      }

      var share = document.createElement("div");
      share.style.cssText = "margin-top:18px;";
      share.innerHTML = '<button class="btn btn-outline" type="button">Share this round</button>';
      share.querySelector("button").addEventListener("click", function () {
        var text = shareText(event, rows);
        if (navigator.share) {
          navigator.share({ text: text }).catch(function () {});
        } else {
          window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener");
        }
      });
      panel.appendChild(share);
    });
  }

  // ---------------- leaderboard: season at a glance ----------------

  function seasonStats(events, results, year) {
    var inYear = results.filter(function (r) {
      return r.events && String(r.events.event_date).slice(0, 4) === year;
    });

    var byEvent = {};
    inYear.forEach(function (r) {
      byEvent[r.event_id] = byEvent[r.event_id] || [];
      byEvent[r.event_id].push(r);
    });

    var wins = {};
    Object.keys(byEvent).forEach(function (id) {
      var top = byEvent[id].slice().sort(function (a, b) { return Number(b.points) - Number(a.points); })[0];
      if (!top) return;
      var n = (top.players && top.players.name) || "Unknown";
      wins[n] = (wins[n] || 0) + 1;
    });
    var mostWins = Object.keys(wins).map(function (n) { return { name: n, count: wins[n] }; })
      .sort(function (a, b) { return b.count - a.count; })[0];

    var best = inYear.slice().sort(function (a, b) { return Number(b.points) - Number(a.points); })[0];
    var bestEvent = best ? events.filter(function (e) { return e.id === best.event_id; })[0] : null;

    // Averages, and improvement across the season. Both need a few rounds
    // before they say anything, so four is the floor.
    var byPlayer = {};
    inYear.forEach(function (r) {
      var n = (r.players && r.players.name) || "Unknown";
      byPlayer[n] = byPlayer[n] || [];
      byPlayer[n].push({ date: r.events.event_date, points: Number(r.points) || 0 });
    });

    var avg = null, improved = null;
    Object.keys(byPlayer).forEach(function (n) {
      var rounds = byPlayer[n].sort(function (a, b) { return a.date.localeCompare(b.date); });
      if (rounds.length < 4) return;

      var mean = rounds.reduce(function (s, r) { return s + r.points; }, 0) / rounds.length;
      if (!avg || mean > avg.mean) avg = { name: n, mean: mean, rounds: rounds.length };

      var half = Math.floor(rounds.length / 2);
      var early = rounds.slice(0, half).reduce(function (s, r) { return s + r.points; }, 0) / half;
      var late = rounds.slice(rounds.length - half).reduce(function (s, r) { return s + r.points; }, 0) / half;
      if (!improved || late - early > improved.gain) improved = { name: n, gain: late - early };
    });

    return {
      rounds: Object.keys(byEvent).length,
      players: Object.keys(byPlayer).length,
      mostWins: mostWins,
      best: best ? { name: (best.players && best.players.name) || "Unknown", points: best.points, event: bestEvent } : null,
      avg: avg,
      improved: improved && improved.gain > 0 ? improved : null
    };
  }

  function statCard(s, year) {
    var items = [];
    if (s.mostWins && s.mostWins.count > 1) {
      items.push(["Most wins", s.mostWins.name + ", " + s.mostWins.count + " rounds"]);
    }
    if (s.best) {
      items.push(["Best single round", s.best.name + ", " + s.best.points + " points" +
        (s.best.event ? " at " + s.best.event.venue : "")]);
    }
    if (s.avg) {
      items.push(["Best average", s.avg.name + ", " + s.avg.mean.toFixed(1) + " points across " + s.avg.rounds + " rounds"]);
    }
    if (s.improved) {
      items.push(["Most improved", s.improved.name + ", up " + s.improved.gain.toFixed(1) + " points a round"]);
    }
    items.push(["Rounds played", String(s.rounds)]);
    items.push(["Players with a card", String(s.players)]);

    var card = document.createElement("div");
    card.className = "scorecard";
    card.id = "season-stats";
    card.style.marginTop = "24px";
    card.innerHTML =
      '<div class="scorecard-head"><h3>Season at a glance</h3><span class="meta">' + esc(year) + "</span></div>" +
      '<dl class="fixture-facts" style="padding:20px;">' +
      items.map(function (it) {
        return "<dt>" + esc(it[0]) + "</dt><dd>" + esc(it[1]) + "</dd>";
      }).join("") +
      "</dl>" +
      '<p class="small" style="padding:0 20px 20px;color:var(--ink-soft);">Averages and improvement need four rounds before they mean much, so anyone with fewer is left out of those two.</p>';
    return card;
  }

  // ---------------- fixtures: add to calendar ----------------

  function icsDate(event) {
    var d = event.event_date.replace(/-/g, "");
    if (!event.tee_time) return { line: "DTSTART;VALUE=DATE:" + d, end: "DTEND;VALUE=DATE:" + d };
    var t = event.tee_time.slice(0, 5).replace(":", "") + "00";
    var hh = Number(event.tee_time.slice(0, 2));
    var endHH = String(Math.min(hh + 5, 23)).padStart(2, "0");
    // Local time with no zone, so it reads correctly on a UK phone without
    // shipping a timezone table inside the file.
    return { line: "DTSTART:" + d + "T" + t, end: "DTEND:" + d + "T" + endHH + event.tee_time.slice(3, 5) + "00" };
  }

  function icsFor(events) {
    var out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Falkners Arms Golf Society//EN", "CALSCALE:GREGORIAN"];
    events.forEach(function (e) {
      var when = icsDate(e);
      var desc = [
        e.meet_time ? "Meet " + e.meet_time.slice(0, 5) : null,
        e.tee_time ? "First tee " + e.tee_time.slice(0, 5) : null,
        e.cost ? "£" + Number(e.cost).toFixed(2).replace(/\.00$/, "") + " a head" : null,
        "thefalknersarmsgolfsociety.co.uk/fixtures.html"
      ].filter(Boolean).join(". ");

      out.push("BEGIN:VEVENT");
      out.push("UID:" + e.id + "@thefalknersarmsgolfsociety.co.uk");
      out.push("DTSTAMP:" + new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z");
      out.push(when.line);
      out.push(when.end);
      out.push("SUMMARY:" + e.name + " — Falkners Arms Golf Society");
      if (e.venue) out.push("LOCATION:" + (e.address ? e.venue + ", " + e.address : e.venue));
      out.push("DESCRIPTION:" + desc);
      out.push("END:VEVENT");
    });
    out.push("END:VCALENDAR");
    return out.join("\r\n");
  }

  function download(name, text) {
    var blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function decorateFixtures(events) {
    var upcoming = events.filter(function (e) {
      return e.event_date >= new Date().toISOString().slice(0, 10);
    });

    var list = document.getElementById("fixture-list") || document.querySelector(".fixture-list");
    if (upcoming.length && list && !document.getElementById("season-ics")) {
      var wrap = document.createElement("p");
      wrap.id = "season-ics";
      wrap.style.cssText = "margin:0 0 16px;";
      wrap.innerHTML = '<button class="btn btn-outline" type="button">Add the season to my calendar</button>';
      wrap.querySelector("button").addEventListener("click", function () {
        download("falkners-fixtures.ics", icsFor(upcoming));
      });
      list.parentNode.insertBefore(wrap, list);
    }

    Array.prototype.forEach.call(document.querySelectorAll(".fixture-item[data-event-id]"), function (item) {
      if (item.getAttribute("data-ics") === "done") return;
      var id = item.getAttribute("data-event-id");
      var panel = item.querySelector(".fixture-panel");
      var event = events.filter(function (e) { return e.id === id; })[0];
      if (!panel || !event) return;
      item.setAttribute("data-ics", "done");

      var p = document.createElement("p");
      p.style.cssText = "margin-top:14px;";
      p.innerHTML = '<button class="btn btn-outline" type="button">Add to my calendar</button>';
      p.querySelector("button").addEventListener("click", function () {
        download(event.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".ics", icsFor([event]));
      });
      panel.appendChild(p);
    });
  }

  // ---------------- start ----------------

  async function run() {
    if (typeof SUPABASE_URL === "undefined" || !window.supabase) return;
    var here = page();
    if (["results.html", "leaderboard.html", "fixtures.html"].indexOf(here) === -1) return;

    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    try {
      if (here === "fixtures.html") {
        var evs = await client.from("events").select("*").order("event_date");
        var events = evs.data || [];
        whenPresent(".fixture-item[data-event-id]", function () { decorateFixtures(events); });
        return;
      }

      var res = await Promise.all([
        client.from("events").select("*").order("event_date"),
        client.from("results").select("*, players(name), events(event_date)")
      ]);
      var allEvents = res[0].data || [];
      var allResults = res[1].data || [];

      if (here === "leaderboard.html") {
        var year = String(new Date().getFullYear());
        var stats = seasonStats(allEvents, allResults, year);
        if (!stats.rounds) return;
        var host = document.querySelector(".section .container");
        if (host) host.appendChild(statCard(stats, year));
        return;
      }

      var resultsByEvent = {};
      allResults.forEach(function (r) {
        resultsByEvent[r.event_id] = resultsByEvent[r.event_id] || [];
        resultsByEvent[r.event_id].push(r);
      });

      var photosByEvent = {};
      try {
        var ph = await client.from("photos").select("event_id, storage_path, caption").eq("status", "approved");
        (ph.data || []).forEach(function (p) {
          photosByEvent[p.event_id] = photosByEvent[p.event_id] || [];
          photosByEvent[p.event_id].push(p);
        });
      } catch (err) { photosByEvent = {}; }

      whenPresent(".fixture-item[data-event-id]", function () {
        decorateResults(allEvents, resultsByEvent, photosByEvent);
        // The season tabs re-render the list, so decorate again after a change.
        var tabs = document.getElementById("results-years") || document;
        tabs.addEventListener("click", function () {
          setTimeout(function () { decorateResults(allEvents, resultsByEvent, photosByEvent); }, 300);
        });
      });
    } catch (err) {
      // Nothing here is load bearing. Better a plain page than a broken one.
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
