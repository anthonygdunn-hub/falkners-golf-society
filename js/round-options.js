/* Round pickers, grouped by season.

   Every "which round?" dropdown on the committee pages uses this, so they
   all read the same way: this season first, then next season, then past
   seasons, each under its own heading, rounds in date order inside each.
   Dates read "Sun 29 Nov" rather than 2026-11-29. A season runs with the
   calendar year (London time), so 2026 stays "this season" until
   1 January, when 2027 takes over and 2026 drops to the past.

   RoundOptions.html(events, { blank, venue })  -> <optgroup>… markup
   RoundOptions.defaultId(events, mode)         -> the round to open on:
       "next"    (default) the next round still to be played
       "results" the most recent round played (for entering results)
   RoundOptions.fill(select, events, { blank, venue, mode, keep }) */
(function () {
  "use strict";
  var TZ = "Europe/London";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function today() { return new Date().toLocaleDateString("en-CA", { timeZone: TZ }); }
  function yearOf(e) { return String((e && e.event_date) || "").slice(0, 4); }
  function fmt(d) {
    if (!d) return "";
    var dt = new Date(String(d).slice(0, 10) + "T12:00:00");
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getDay()] + " " + dt.getDate() + " " +
      ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][dt.getMonth()];
  }
  function byDate(a, b) { return String(a.event_date).localeCompare(String(b.event_date)) || String(a.name).localeCompare(String(b.name)); }

  function label(e, opts) {
    var s = e.name + " · " + fmt(e.event_date);
    if (opts && opts.venue && e.venue && e.venue !== "TBC") s += " · " + e.venue;
    return s;
  }

  function seasons(events) {
    var cur = today().slice(0, 4);
    var years = [];
    (events || []).forEach(function (e) { var y = yearOf(e); if (y && years.indexOf(y) < 0) years.push(y); });
    var future = years.filter(function (y) { return y > cur; }).sort();
    var past = years.filter(function (y) { return y < cur; }).sort().reverse();
    var order = (years.indexOf(cur) >= 0 ? [cur] : []).concat(future, past);
    return order.map(function (y) {
      return {
        year: y,
        label: y === cur ? y + " season · this season" : y > cur ? y + " season · next season" : y + " season",
        events: events.filter(function (e) { return yearOf(e) === y; }).slice().sort(byDate)
      };
    });
  }

  function html(events, opts) {
    opts = opts || {};
    var out = opts.blank ? '<option value="">' + esc(opts.blank) + "</option>" : "";
    seasons(events || []).forEach(function (g) {
      out += '<optgroup label="' + esc(g.label) + '">' +
        g.events.map(function (e) { return '<option value="' + esc(e.id) + '">' + esc(label(e, opts)) + "</option>"; }).join("") +
        "</optgroup>";
    });
    return out;
  }

  function defaultId(events, mode) {
    var list = (events || []).slice().sort(byDate);
    if (!list.length) return "";
    var t = today();
    if (mode === "results") {
      var played = list.filter(function (e) { return e.event_date <= t; });
      return (played.length ? played[played.length - 1] : list[0]).id;
    }
    var next = list.filter(function (e) { return e.event_date >= t; })[0];
    return (next || list[list.length - 1]).id;
  }

  /* Which round to open on inside one season: the next one still to play
     in this or a future season, the latest one in a past season (and for
     results, the latest one played). */
  function defaultInSeason(list, mode) {
    list = list.slice().sort(byDate);
    if (!list.length) return "";
    var t = today();
    if (mode === "results") {
      var played = list.filter(function (e) { return e.event_date <= t; });
      return (played.length ? played[played.length - 1] : list[0]).id;
    }
    var next = list.filter(function (e) { return e.event_date >= t; })[0];
    return (next || list[list.length - 1]).id;
  }

  function optionsFor(list, opts) {
    var out = opts.blank ? '<option value="">' + esc(opts.blank) + "</option>" : "";
    return out + list.slice().sort(byDate).map(function (e) {
      return '<option value="' + esc(e.id) + '">' + esc(label(e, opts)) + "</option>";
    }).join("");
  }

  /* Fill a select, with season buttons above it (2026 · 2027 · …), the
     same as the season buttons on the fixtures page and in the app. The
     list only holds the chosen season's rounds, so nobody scrolls through
     next year to reach this year. It keeps what was chosen before (or
     `keep`) when it is still there, otherwise opens on the default round.
     Picking a season chooses that season's default round and fires the
     select's change, so the panel underneath loads it. */
  function fill(select, events, opts) {
    if (!select) return null;
    opts = opts || {};
    events = events || [];
    var previous = opts.keep != null ? opts.keep : select.value;
    var groups = seasons(events);
    var prevEv = previous && events.filter(function (e) { return e.id === previous; })[0];
    var pick = prevEv ? previous : (!opts.blank || opts.mode ? defaultId(events, opts.mode) : "");
    var pickEv = pick && events.filter(function (e) { return e.id === pick; })[0];
    var year = pickEv ? yearOf(pickEv) : (select.__season && groups.some(function (g) { return g.year === select.__season; }) ? select.__season : (groups[0] && groups[0].year));
    select.__season = year;

    function render(y) {
      var g = groups.filter(function (x) { return x.year === y; })[0];
      select.innerHTML = optionsFor(g ? g.events : [], opts);
    }
    render(year);
    if (pick && Array.prototype.some.call(select.options, function (o) { return o.value === pick; })) select.value = pick;
    else if (opts.blank && !opts.mode) select.value = "";

    // The season buttons sit straight above the select, made once.
    var bar = select.__seasonBar;
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "year-tabs round-seasons";
      select.parentNode.insertBefore(bar, select);
      select.__seasonBar = bar;
    }
    if (groups.length < 2) { bar.hidden = true; bar.innerHTML = ""; return select; }
    bar.hidden = false;
    var cur = today().slice(0, 4);
    bar.innerHTML = groups.slice().sort(function (a, b) { return a.year.localeCompare(b.year); }).map(function (g) {
      var on = g.year === year;
      return '<button type="button" class="year-tab' + (on ? " is-active" : "") + '" data-year="' + g.year + '" aria-pressed="' + on + '">' +
        g.year + (g.year === cur ? " · this season" : "") + "</button>";
    }).join("");
    bar.onclick = function (ev) {
      var btn = ev.target.closest(".year-tab");
      if (!btn || btn.dataset.year === select.__season) return;
      var y = btn.dataset.year;
      select.__season = y;
      Array.prototype.forEach.call(bar.querySelectorAll(".year-tab"), function (b) {
        var on = b.dataset.year === y;
        b.classList.toggle("is-active", on); b.setAttribute("aria-pressed", on);
      });
      render(y);
      var g = groups.filter(function (x) { return x.year === y; })[0];
      select.value = opts.blank && !opts.mode ? "" : defaultInSeason(g ? g.events : [], opts.mode);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    };
    return select;
  }

  window.RoundOptions = { html: html, defaultId: defaultId, fill: fill, label: label, fmt: fmt, seasons: seasons };
})();
