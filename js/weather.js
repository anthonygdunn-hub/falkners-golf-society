/* ============================================================
   The Falkners Arms Golf Society - the forecast for a round

   Used by the app (round page, home screen) and the website's
   fixture cards. Forecasts come from Open-Meteo: free, no key, and
   no personal data sent - just the course's position and the date.
   They only reach about 16 days ahead, so further out nothing shows.

   Where the course is: the position saved when the committee mapped
   it, or else the venue name looked up once on OpenStreetMap and
   remembered on this device.
   ============================================================ */

window.FalknersWeather = (function () {
  "use strict";

  var CODES = [
    [[0], "☀️", "Sunny"], [[1], "🌤️", "Mostly sunny"], [[2], "⛅", "Partly cloudy"], [[3], "☁️", "Cloudy"],
    [[45, 48], "🌫️", "Fog"], [[51, 53, 55, 56, 57], "🌦️", "Drizzle"], [[61, 63, 66, 80, 81], "🌧️", "Rain"],
    [[65, 67, 82], "🌧️", "Heavy rain"], [[71, 73, 75, 77, 85, 86], "🌨️", "Snow"], [[95, 96, 99], "⛈️", "Thunder"]
  ];
  function describe(code) {
    for (var i = 0; i < CODES.length; i++) if (CODES[i][0].indexOf(code) >= 0) return { icon: CODES[i][1], text: CODES[i][2] };
    return { icon: "🌡️", text: "" };
  }

  function getStore(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }
  function setStore(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }

  async function locate(venue, lat, lng) {
    if (lat != null && lng != null) return { lat: Number(lat), lng: Number(lng) };
    if (!venue) return null;
    var key = "wx-place-" + venue.toLowerCase();
    var hit = getStore(key);
    if (hit) return hit.lat == null ? null : hit;
    try {
      var res = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gb&q=" + encodeURIComponent(venue), { headers: { "Accept": "application/json" } });
      var rows = res.ok ? await res.json() : [];
      var place = rows && rows[0] ? { lat: Number(rows[0].lat), lng: Number(rows[0].lon) } : { lat: null };
      setStore(key, place);
      return place.lat == null ? null : place;
    } catch (e) { return null; }
  }

  // { venue, date: "YYYY-MM-DD", time: "HH:MM[:SS]", lat?, lng? } -> forecast for the
  // first tee and the four hours after it, or null when it's too far ahead.
  async function forRound(o) {
    if (!o || !o.date) return null;
    var today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
    var days = Math.round((new Date(o.date + "T12:00:00") - new Date(today + "T12:00:00")) / 864e5);
    if (days < 0 || days > 15) return null;
    var where = await locate(o.venue, o.lat, o.lng);
    if (!where) return null;
    var cacheKey = "wx-" + where.lat.toFixed(3) + "," + where.lng.toFixed(3) + "," + o.date;
    var cached = getStore(cacheKey);
    var data = cached && Date.now() - cached.at < 3 * 3600e3 ? cached.data : null;
    if (!data) {
      try {
        var url = "https://api.open-meteo.com/v1/forecast?latitude=" + where.lat + "&longitude=" + where.lng +
          "&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m" +
          "&wind_speed_unit=mph&timezone=Europe%2FLondon&start_date=" + o.date + "&end_date=" + o.date;
        var res = await fetch(url);
        if (!res.ok) return null;
        data = await res.json();
        setStore(cacheKey, { at: Date.now(), data: data });
      } catch (e) { return null; }
    }
    var h = data && data.hourly;
    if (!h || !h.time) return null;
    var start = parseInt(String(o.time || "10:00").slice(0, 2), 10);
    if (!(start >= 5 && start <= 18)) start = 10;
    var hours = [];
    for (var i = 0; i < h.time.length; i++) {
      var hr = parseInt(h.time[i].slice(11, 13), 10);
      if (hr >= start && hr < start + 5) hours.push({
        hour: hr, temp: Math.round(h.temperature_2m[i]), rain: h.precipitation_probability[i],
        wind: Math.round(h.wind_speed_10m[i]), gust: Math.round(h.wind_gusts_10m[i]), w: describe(h.weather_code[i]),
      });
    }
    if (!hours.length) return null;
    var first = hours[0];
    var maxRain = Math.max.apply(null, hours.map(function (x) { return x.rain || 0; }));
    var maxWind = Math.max.apply(null, hours.map(function (x) { return x.wind; }));
    var maxGust = Math.max.apply(null, hours.map(function (x) { return x.gust; }));
    return {
      days: days, first: first, hours: hours, maxRain: maxRain, maxWind: maxWind, maxGust: maxGust,
      summary: first.w.icon + " " + first.temp + "°C · " + maxRain + "% rain · wind " + maxWind + " mph",
      text: first.w.text,
    };
  }

  // A small ready-made block: the headline and an hour-by-hour strip.
  function html(f, opts) {
    if (!f) return "";
    var light = opts && opts.light;
    return '<div class="wx' + (light ? " wx-light" : "") + '">' +
      '<div class="wx-head"><span class="wx-icon">' + f.first.w.icon + '</span><span><b>' + f.first.temp + '°C</b> ' + f.text +
      '<small>' + f.maxRain + '% chance of rain · wind ' + f.maxWind + ' mph, gusts ' + f.maxGust + '</small></span></div>' +
      '<div class="wx-hours">' + f.hours.map(function (x) {
        return '<span><small>' + String(x.hour).padStart(2, "0") + ':00</small>' + x.w.icon + '<b>' + x.temp + '°</b><small>' + (x.rain || 0) + '%</small></span>';
      }).join("") + '</div>' +
      '<div class="wx-src">Forecast for the first tee · Open-Meteo</div></div>';
  }

  return { forRound: forRound, html: html };
})();
