// ------------------------------------------------------------------
// Which pages are live.
//
// Loaded on every public page by js/nav.js, so nothing has to be pasted
// into ten HTML files. It does two things:
//
//   1. takes an unpublished page out of the menu
//   2. if you are standing on an unpublished page, replaces it with a
//      coming soon notice
//
// Committee accounts see everything as normal, with a warning strip, so
// a page can be checked before it goes live.
//
// This is a curtain, not a lock. The site is static and its data is
// public by design, so anyone with the URL can still see the markup.
// Right for "not launched yet", wrong for anything private.
// ------------------------------------------------------------------

(function () {
  "use strict";
  if (window.__fgsSitePages) return;
  window.__fgsSitePages = true;

  var C = { navy: "#1B3A6C", gold: "#B8923C", ink: "#171F30", inkSoft: "#57617A" };

  function currentSlug() {
    var file = location.pathname.split("/").pop() || "index.html";
    return file.replace(/\.html$/, "") || "index";
  }

  function removeFromNav(slug) {
    var link = document.querySelector('.main-nav a[href="' + slug + '.html"]');
    if (link && link.parentElement) link.parentElement.remove();
  }

  function comingSoon(page) {
    // Everything between the header and the footer goes, so no half-built
    // content is left on screen while the notice sits above it.
    Array.prototype.forEach.call(document.querySelectorAll("section.section"), function (s) {
      s.remove();
    });

    var wrap = document.createElement("section");
    wrap.className = "section";
    wrap.innerHTML =
      '<div class="container" style="max-width:560px;">' +
      '<div class="scorecard">' +
      '<div class="scorecard-head"><h3>' + escapeText(page.title) + "</h3></div>" +
      '<div style="padding:24px;">' +
      '<p style="font-family:var(--font-display);font-size:22px;letter-spacing:0.04em;text-transform:uppercase;color:' + C.navy + ';margin:0 0 12px;">Coming soon</p>' +
      '<p class="small">' + escapeText(page.note || "This one is not live yet. It will appear in the menu the moment it is ready.") + "</p>" +
      '<a class="btn btn-outline" href="index.html">Back to the society</a>' +
      "</div></div></div>";

    var footer = document.querySelector(".site-footer");
    if (footer && footer.parentNode) footer.parentNode.insertBefore(wrap, footer);
    else document.body.appendChild(wrap);

    document.title = page.title + " — The Falkners Arms Golf Society";
  }

  function committeeStrip(page) {
    if (document.getElementById("fgs-hidden-strip")) return;
    var bar = document.createElement("div");
    bar.id = "fgs-hidden-strip";
    bar.style.cssText =
      "background:#FBF6E9;border-bottom:3px solid " + C.gold + ";padding:10px 16px;text-align:center;" +
      "font-family:var(--font-body);font-size:13px;color:" + C.ink + ";";
    bar.innerHTML = "This page is hidden from members. You can see it because you are on the committee. " +
      '<a href="admin.html" style="color:' + C.navy + ';">Pages in admin</a>';
    var header = document.querySelector(".site-header");
    if (header && header.parentNode) header.parentNode.insertBefore(bar, header.nextSibling);
  }

  function escapeText(v) {
    var d = document.createElement("div");
    d.textContent = v === null || v === undefined ? "" : String(v);
    return d.innerHTML;
  }

  async function run() {
    if (typeof SUPABASE_URL === "undefined" || !window.supabase) return;
    var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    var pages;
    try {
      var res = await client.from("site_pages").select("slug, title, published, note");
      pages = res.data || [];
    } catch (err) {
      return;   // If this cannot load, the site behaves exactly as before.
    }

    var hidden = pages.filter(function (p) { return !p.published; });
    if (!hidden.length) return;

    var committee = false;
    try {
      var got = await client.auth.getSession();
      if (got.data.session) {
        var m = await client.from("memberships").select("role, status")
          .eq("profile_id", got.data.session.user.id).maybeSingle();
        committee = !!(m.data && m.data.role === "committee" && m.data.status === "approved");
      }
    } catch (err) { committee = false; }

    var here = currentSlug();
    var thisPage = hidden.filter(function (p) { return p.slug === here; })[0];

    if (committee) {
      if (thisPage) committeeStrip(thisPage);
      return;   // Committee keeps the full menu, so hidden pages stay reachable.
    }

    hidden.forEach(function (p) { removeFromNav(p.slug); });
    if (thisPage) comingSoon(thisPage);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
