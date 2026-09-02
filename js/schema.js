// ------------------------------------------------------------------
// Structured data for search engines.
//
// Loaded on every page by js/nav.js. It adds a SportsOrganization
// record for the society, and on the fixtures page an Event record for
// each round still to be played, so a Google result can carry the date
// and the course rather than just a page title.
//
// Written from the fixtures already in the database, so it can never
// drift from what the page shows.
// ------------------------------------------------------------------

(function () {
  "use strict";
  if (window.__fgsSchema) return;
  window.__fgsSchema = true;

  var SITE = "https://www.thefalknersarmsgolfsociety.co.uk";

  function add(data) {
    var s = document.createElement("script");
    s.type = "application/ld+json";
    s.textContent = JSON.stringify(data);
    document.head.appendChild(s);
  }

  function society() {
    return {
      "@context": "https://schema.org",
      "@type": "SportsOrganization",
      name: "The Falkners Arms Golf Society",
      sport: "Golf",
      url: SITE,
      logo: SITE + "/assets/logo.jpeg",
      foundingDate: "2023",
      areaServed: "Hampshire and Surrey",
      location: {
        "@type": "Place",
        name: "The Falkners Arms",
        address: {
          "@type": "PostalAddress",
          addressLocality: "Fleet",
          addressRegion: "Hampshire",
          addressCountry: "GB"
        }
      }
    };
  }

  function fixtureEvent(e) {
    var start = e.event_date + (e.tee_time ? "T" + e.tee_time : "");
    var ev = {
      "@context": "https://schema.org",
      "@type": "SportsEvent",
      name: e.name + " — The Falkners Arms Golf Society",
      sport: "Golf",
      startDate: start,
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      url: SITE + "/fixtures.html",
      organizer: { "@type": "SportsOrganization", name: "The Falkners Arms Golf Society", url: SITE }
    };

    if (e.venue) {
      ev.location = {
        "@type": "Place",
        name: e.venue,
        address: e.address || { "@type": "PostalAddress", addressCountry: "GB" }
      };
    }

    if (e.cost) {
      ev.offers = {
        "@type": "Offer",
        price: String(e.cost),
        priceCurrency: "GBP",
        availability: "https://schema.org/InStock",
        url: SITE + "/fixtures.html"
      };
    }

    return ev;
  }

  async function run() {
    add(society());

    var here = (location.pathname.split("/").pop() || "index.html");
    if (here !== "fixtures.html") return;
    if (typeof SUPABASE_URL === "undefined" || !window.supabase) return;

    try {
      var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      var today = new Date().toISOString().slice(0, 10);
      var res = await client.from("events")
        .select("name, venue, address, event_date, tee_time, cost")
        .gte("event_date", today)
        .order("event_date", { ascending: true });
      (res.data || []).forEach(function (e) { add(fixtureEvent(e)); });
    } catch (err) {
      // No structured data is better than wrong structured data.
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
