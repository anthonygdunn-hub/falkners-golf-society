// ------------------------------------------------------------------
// The Pages card in committee admin.
//
// Lists every page held in site_pages with a tick box each. Tick it and
// the page joins the menu, untick it and it drops out and shows a coming
// soon notice instead.
//
// The card builds itself rather than living in admin.html, so admin.html
// is left alone. js/admin-tabs.js finds it by its heading and files it
// under the Pages tab.
// ------------------------------------------------------------------

(function () {
  "use strict";
  if (window.__fgsPagesAdmin) return;
  window.__fgsPagesAdmin = true;

  var client = null;
  var card = null;

  function esc(v) {
    var d = document.createElement("div");
    d.textContent = v === null || v === undefined ? "" : String(v);
    return d.innerHTML;
  }

  function build() {
    var shell = document.querySelector(".admin-shell");
    var dashboard = document.getElementById("dashboard");
    if (!shell || !dashboard || document.getElementById("pages-card")) return false;

    card = document.createElement("div");
    card.className = "scorecard";
    card.id = "pages-card";
    card.style.marginTop = "20px";
    card.innerHTML =
      '<div class="scorecard-head"><h3>Pages</h3></div>' +
      '<div style="padding:20px;">' +
      '<p class="small">Tick a page to put it in the menu. Unticked, it drops out of the menu and anyone with the link sees a coming soon notice instead. You still see it, with a strip across the top.</p>' +
      '<div id="pages-list"><p class="small">Loading…</p></div>' +
      '<p class="small" id="pages-status" style="margin-top:12px;"></p>' +
      "</div>";

    dashboard.appendChild(card);
    return true;
  }

  function say(msg, bad) {
    var el = document.getElementById("pages-status");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = bad ? "#A33131" : "var(--ink-soft)";
  }

  async function load() {
    var res = await client.from("site_pages").select("*").order("sort", { ascending: true, nullsFirst: false }).order("title");
    var rows = res.data || [];
    var list = document.getElementById("pages-list");
    if (!list) return;

    if (!rows.length) {
      list.innerHTML = '<p class="small">No pages are being managed yet.</p>';
      return;
    }

    list.innerHTML =
      '<table style="width:100%;border-collapse:collapse;">' +
      rows.map(function (p) {
        return '<tr>' +
          '<td style="padding:10px 0;border-bottom:1px solid var(--line);">' +
          '<label style="display:flex;align-items:center;gap:10px;cursor:pointer;">' +
          '<input type="checkbox" data-slug="' + esc(p.slug) + '"' + (p.published ? " checked" : "") + (p.can_hide === false ? " disabled" : "") + ">" +
          "<span>" +
          "<strong>" + esc(p.title) + "</strong>" +
          '<br><span class="small" style="color:var(--ink-soft);">' + esc(p.slug) + ".html" +
          (p.note ? " &nbsp;·&nbsp; " + esc(p.note) : "") + "</span>" +
          "</span></label></td>" +
          '<td align="right" style="padding:10px 0;border-bottom:1px solid var(--line);white-space:nowrap;">' +
          '<span class="small" data-state="' + esc(p.slug) + '" style="color:' + (p.published ? "#1D7A46" : "var(--ink-soft)") + ';">' +
          (p.can_hide === false ? "Always live" : p.published ? "In the menu" : "Hidden") + "</span></td></tr>";
      }).join("") +
      "</table>";

    list.addEventListener("change", async function (e) {
      var box = e.target.closest("input[type=checkbox][data-slug]");
      if (!box) return;
      var slug = box.getAttribute("data-slug");
      var on = box.checked;
      box.disabled = true;
      say("Saving…");

      var upd = await client.from("site_pages")
        .update({ published: on, updated_at: new Date().toISOString() })
        .eq("slug", slug);

      box.disabled = false;

      if (upd.error) {
        box.checked = !on;
        say(upd.error.message, true);
        return;
      }

      var state = list.querySelector('[data-state="' + slug + '"]');
      if (state) {
        state.textContent = on ? "In the menu" : "Hidden";
        state.style.color = on ? "#1D7A46" : "var(--ink-soft)";
      }
      say(on ? "Live. It is in the menu now." : "Hidden. It has left the menu.");
    });
  }

  async function start() {
    if (typeof SUPABASE_URL === "undefined" || !window.supabase) return;
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // The card only appears once the committee dashboard is on screen.
    var tries = 0;
    var timer = setInterval(function () {
      var dashboard = document.getElementById("dashboard");
      var visible = dashboard && dashboard.style.display !== "none";
      if (visible && build()) {
        clearInterval(timer);
        load().catch(function (err) { say(String(err.message || err), true); });
      }
      if (++tries > 60) clearInterval(timer);
    }, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
