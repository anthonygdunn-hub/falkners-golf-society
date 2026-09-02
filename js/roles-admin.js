// ------------------------------------------------------------------
// Roles and moderators, in committee admin.
//
// Two cards. One sets a member's level. The other says which fixtures a
// moderator may touch, either one at a time or the lot.
//
// The screen is only the handle. What a moderator can actually do is
// decided by can_moderate() in the database, so a hidden button is not
// a permission and this card cannot hand out more than the policies
// allow.
//
// Builds itself so admin.html is left alone. js/admin-view.js files it
// under the People tab by its headings.
// ------------------------------------------------------------------

(function () {
  "use strict";
  if (window.__fgsRolesAdmin) return;
  window.__fgsRolesAdmin = true;

  var client = null;
  var me = null;
  var members = [];
  var events = [];
  var grants = [];

  function esc(v) {
    var d = document.createElement("div");
    d.textContent = v === null || v === undefined ? "" : String(v);
    return d.innerHTML;
  }

  function say(id, msg, bad) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = bad ? "#A33131" : "var(--ink-soft)";
  }

  function shortDate(iso) {
    return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB",
      { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
  }

  function build() {
    var dashboard = document.getElementById("dashboard");
    if (!dashboard || document.getElementById("roles-card")) return false;

    var roles = document.createElement("div");
    roles.className = "scorecard";
    roles.id = "roles-card";
    roles.style.marginTop = "20px";
    roles.innerHTML =
      '<div class="scorecard-head"><h3>Member levels</h3></div>' +
      '<div style="padding:20px;">' +
      '<p class="small">Member sees the site as anyone does. Moderator can work on the fixtures you give them below. Committee can do everything, including this.</p>' +
      '<div id="roles-list"><p class="small">Loading…</p></div>' +
      '<p class="small" id="roles-status" style="margin-top:12px;"></p>' +
      "</div>";

    var mods = document.createElement("div");
    mods.className = "scorecard";
    mods.id = "grants-card";
    mods.style.marginTop = "20px";
    mods.innerHTML =
      '<div class="scorecard-head"><h3>What moderators cover</h3></div>' +
      '<div style="padding:20px;">' +
      '<p class="small">Give a moderator a single fixture, or all of them. On a fixture they hold they can enter results, edit the details, set who is playing, the tee groups and pairs, and record the prizes.</p>' +
      '<div id="grants-list"><p class="small">Loading…</p></div>' +
      '<p class="small" id="grants-status" style="margin-top:12px;"></p>' +
      "</div>";

    dashboard.appendChild(roles);
    dashboard.appendChild(mods);
    return true;
  }

  async function loadAll() {
    var res = await Promise.all([
      client.from("memberships").select("profile_id, role, status"),
      client.from("profiles").select("id, display_name"),
      client.from("events").select("id, name, venue, event_date").order("event_date", { ascending: false }),
      client.from("moderator_grants").select("id, profile_id, event_id")
    ]);

    var ms = res[0].data || [];
    var ps = res[1].data || [];
    events = res[2].data || [];
    grants = res[3].data || [];

    var nameOf = {};
    ps.forEach(function (p) { nameOf[p.id] = p.display_name; });

    members = ms
      .filter(function (m) { return m.status === "approved"; })
      .map(function (m) { return { id: m.profile_id, name: nameOf[m.profile_id] || "Unnamed", role: m.role }; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });

    renderRoles();
    renderGrants();
  }

  function renderRoles() {
    var list = document.getElementById("roles-list");
    if (!list) return;

    list.innerHTML = '<table style="width:100%;border-collapse:collapse;">' +
      members.map(function (m) {
        var self = m.id === me;
        return '<tr>' +
          '<td style="padding:10px 0;border-bottom:1px solid var(--line);">' + esc(m.name) +
          (self ? ' <span class="small" style="color:var(--ink-soft);">(you)</span>' : "") + "</td>" +
          '<td align="right" style="padding:10px 0;border-bottom:1px solid var(--line);">' +
          '<select data-role-for="' + esc(m.id) + '"' + (self ? " disabled" : "") + ">" +
          ["member", "moderator", "committee"].map(function (r) {
            return '<option value="' + r + '"' + (m.role === r ? " selected" : "") + ">" +
              r.charAt(0).toUpperCase() + r.slice(1) + "</option>";
          }).join("") +
          "</select></td></tr>";
      }).join("") + "</table>";

    // Your own row is fixed. Demoting yourself by accident would leave the
    // society with one fewer committee account and no way back in.
    list.onchange = async function (e) {
      var sel = e.target.closest("select[data-role-for]");
      if (!sel) return;
      var id = sel.getAttribute("data-role-for");
      var role = sel.value;
      sel.disabled = true;
      say("roles-status", "Saving…");

      var upd = await client.from("memberships").update({ role: role }).eq("profile_id", id);
      sel.disabled = false;

      if (upd.error) { say("roles-status", upd.error.message, true); return; }

      members.forEach(function (m) { if (m.id === id) m.role = role; });
      say("roles-status", "Saved.");
      renderGrants();
    };
  }

  function renderGrants() {
    var list = document.getElementById("grants-list");
    if (!list) return;

    var mods = members.filter(function (m) { return m.role === "moderator"; });
    if (!mods.length) {
      list.innerHTML = '<p class="small">Nobody is a moderator yet. Set someone to Moderator above and they will appear here.</p>';
      return;
    }

    list.innerHTML = mods.map(function (m) {
      var mine = grants.filter(function (g) { return g.profile_id === m.id; });
      var blanket = mine.filter(function (g) { return !g.event_id; })[0];
      var held = mine.filter(function (g) { return g.event_id; });

      return '<div style="padding:14px 0;border-bottom:1px solid var(--line);">' +
        "<strong>" + esc(m.name) + "</strong>" +
        '<div style="margin-top:8px;">' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
        '<input type="checkbox" data-blanket="' + esc(m.id) + '"' + (blanket ? " checked" : "") + ">" +
        '<span class="small">Every fixture, this season and future ones</span></label></div>' +
        (blanket ? "" :
          '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
          '<select data-add-for="' + esc(m.id) + '" style="max-width:280px;">' +
          '<option value="">Add a fixture…</option>' +
          events.filter(function (ev) {
            return !held.some(function (g) { return g.event_id === ev.id; });
          }).map(function (ev) {
            return '<option value="' + esc(ev.id) + '">' + esc(ev.name) + " — " + esc(shortDate(ev.event_date)) + "</option>";
          }).join("") +
          "</select></div>" +
          '<div style="margin-top:8px;">' +
          (held.length
            ? held.map(function (g) {
                var ev = events.filter(function (e2) { return e2.id === g.event_id; })[0];
                return '<span style="display:inline-flex;align-items:center;gap:6px;background:var(--paper);border-left:3px solid var(--navy);padding:6px 10px;margin:0 6px 6px 0;font-size:13px;">' +
                  esc(ev ? ev.name + " — " + shortDate(ev.event_date) : "Fixture") +
                  '<button type="button" data-drop="' + esc(g.id) + '" aria-label="Remove" style="background:none;border:0;cursor:pointer;color:#A33131;font-size:15px;line-height:1;">×</button></span>';
              }).join("")
            : '<span class="small" style="color:var(--ink-soft);">No fixtures yet.</span>') +
          "</div>") +
        "</div>";
    }).join("");

    list.onchange = async function (e) {
      var blanket = e.target.closest("input[data-blanket]");
      if (blanket) {
        var id = blanket.getAttribute("data-blanket");
        blanket.disabled = true;
        say("grants-status", "Saving…");
        var r;
        if (blanket.checked) {
          r = await client.from("moderator_grants").insert({ profile_id: id, event_id: null, granted_by: me });
        } else {
          r = await client.from("moderator_grants").delete().eq("profile_id", id).is("event_id", null);
        }
        blanket.disabled = false;
        if (r.error) { blanket.checked = !blanket.checked; say("grants-status", r.error.message, true); return; }
        await refreshGrants("Saved.");
        return;
      }

      var add = e.target.closest("select[data-add-for]");
      if (add && add.value) {
        var who = add.getAttribute("data-add-for");
        var ev = add.value;
        add.disabled = true;
        say("grants-status", "Saving…");
        var ins = await client.from("moderator_grants").insert({ profile_id: who, event_id: ev, granted_by: me });
        add.disabled = false;
        if (ins.error) { say("grants-status", ins.error.message, true); return; }
        await refreshGrants("Added.");
      }
    };

    list.onclick = async function (e) {
      var drop = e.target.closest("button[data-drop]");
      if (!drop) return;
      drop.disabled = true;
      say("grants-status", "Removing…");
      var del = await client.from("moderator_grants").delete().eq("id", drop.getAttribute("data-drop"));
      if (del.error) { drop.disabled = false; say("grants-status", del.error.message, true); return; }
      await refreshGrants("Removed.");
    };
  }

  async function refreshGrants(msg) {
    var res = await client.from("moderator_grants").select("id, profile_id, event_id");
    grants = res.data || [];
    renderGrants();
    say("grants-status", msg);
  }

  async function start() {
    if (typeof SUPABASE_URL === "undefined" || !window.supabase) return;
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    var tries = 0;
    var timer = setInterval(async function () {
      var dashboard = document.getElementById("dashboard");
      var visible = dashboard && dashboard.style.display !== "none";
      if (visible) {
        var got = await client.auth.getSession();
        if (!got.data.session) return;
        me = got.data.session.user.id;
        if (build()) {
          clearInterval(timer);
          loadAll().catch(function (err) { say("roles-status", String(err.message || err), true); });
        }
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
