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
    return dt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
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

  /* Fill a select, keeping what was chosen before (or `keep`) when it is
     still there, otherwise opening on the default round. */
  function fill(select, events, opts) {
    if (!select) return null;
    opts = opts || {};
    var previous = opts.keep != null ? opts.keep : select.value;
    select.innerHTML = html(events, opts);
    var has = function (v) { return v && Array.prototype.some.call(select.options, function (o) { return o.value === v; }); };
    if (has(previous)) select.value = previous;
    else if (!opts.blank || opts.mode) select.value = defaultId(events, opts.mode);
    return select;
  }

  window.RoundOptions = { html: html, defaultId: defaultId, fill: fill, label: label, fmt: fmt, seasons: seasons };
})();
