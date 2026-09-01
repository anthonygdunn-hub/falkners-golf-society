/* Pairs draw for the admin page. The society runs a pairs competition
   alongside the individual round, and the two draws are independent: a
   player can be in tee group 1 and paired with someone from group 4.
   Pairs live in the same groupings table but tagged group_type =
   "pairs"; the tee draw only reads, writes and clears rows tagged
   "fours". Same shape as the tee draw on purpose - a number against
   each name - because that is what the committee already knows.

   A player may hold two pair numbers, typed as "3, 7". The society
   often turns out an odd number, so somebody has to play twice for
   nobody to be left out, and that second pairing is a second chance at
   the pairs prize. Each number a player holds is its own row in
   groupings, so the fixtures page needs no change: it already groups
   rows by group_number and lists whoever is in each one. The database
   allows this because sql/pairs-double-up.sql widened the unique
   indexes to include group_number - the same player twice in the SAME
   pair is still refused. */

(function () {
  "use strict";

  var TYPE = "pairs";
  var MAX_PAIRS_PER_PLAYER = 2;
  var MAX_PAIR_NUMBER = 30;
  var client = null;

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  function setStatus(msg, isError) {
    var el = document.getElementById("pair-status");
    if (!el) return;
    el.textContent = msg || "";
    el.className = isError ? "status-msg err" : "small";
  }

  function rowKey(r) { return r.player_id ? "p:" + r.player_id : "m:" + r.profile_id; }

  function inputs() {
    return Array.prototype.slice.call(document.querySelectorAll("#pair-list .pair-input"));
  }

  /* "3" is one pairing, "3, 7" is two. Anything that is not a whole
     number in range is dropped, and the same number typed twice counts
     once, because a player cannot be both halves of one pair. */
  function parsePairNumbers(value) {
    var out = [];
    String(value || "").split(/[^0-9]+/).forEach(function (part) {
      if (!part) return;
      var n = parseInt(part, 10);
      if (!(n >= 1 && n <= MAX_PAIR_NUMBER)) return;
      if (out.indexOf(n) === -1) out.push(n);
    });
    return out.slice(0, MAX_PAIRS_PER_PLAYER);
  }

  function setInputValue(input, numbers) {
    input.value = numbers.join(", ");
  }

  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  function summarise() {
    var all = inputs();
    var counts = {};
    var twice = 0;
    var waiting = 0;
    var rejected = 0;

    all.forEach(function (input) {
      var typed = input.value.trim();
      var numbers = parsePairNumbers(typed);
      if (!numbers.length) {
        if (typed) rejected++; else waiting++;
        return;
      }
      if (numbers.length > 1) twice++;
      numbers.forEach(function (n) { counts[n] = (counts[n] || 0) + 1; });
    });

    var numbers = Object.keys(counts).map(Number).sort(function (a, b) { return a - b; });
    var complete = numbers.filter(function (n) { return counts[n] === 2; });
    var singles = numbers.filter(function (n) { return counts[n] === 1; });
    var crowded = numbers.filter(function (n) { return counts[n] > 2; });

    var msg = plural(complete.length, "pair", "pairs") + " set";
    if (twice) msg += " - " + plural(twice, "player is", "players are") + " playing twice";
    if (waiting) msg += " - " + waiting + " not yet paired";
    if (singles.length) msg += " - pair " + singles.join(", ") + " has only one player";
    if (crowded.length) msg += " - pair " + crowded.join(", ") + " has more than two";
    if (rejected) msg += " - " + plural(rejected, "box", "boxes") + " not understood, use numbers like 3 or 3, 7";

    setStatus(msg, singles.length > 0 || crowded.length > 0 || rejected > 0);
  }

  async function refreshPairList(eventId) {
    var el = document.getElementById("pair-list");
    if (!el || !eventId) return;
    var attRes = await client.from("attendance").select("profile_id, player_id").eq("event_id", eventId).order("created_at", { ascending: true });
    if (attRes.error) { el.innerHTML = '<p class="status-msg err">Could not load the round.</p>'; return; }
    var attendance = attRes.data || [];
    if (!attendance.length) { el.innerHTML = '<p class="small">Nobody is on this round yet, so there are no pairs to draw.</p>'; setStatus(""); return; }

    /* A player can now hold more than one pair row, so collect them all
       and show them in the one box, lowest first. */
    var pairRes = await client.from("groupings").select("profile_id, player_id, group_number").eq("event_id", eventId).eq("group_type", TYPE).order("group_number", { ascending: true });
    var existing = {};
    (pairRes.data || []).forEach(function (g) {
      var k = rowKey(g);
      if (!existing[k]) existing[k] = [];
      if (existing[k].indexOf(g.group_number) === -1) existing[k].push(g.group_number);
    });

    var profileIds = attendance.map(function (a) { return a.profile_id; }).filter(Boolean);
    var profById = {};
    if (profileIds.length) { var pRes = await client.from("profiles").select("id, display_name").in("id", profileIds); (pRes.data || []).forEach(function (p) { profById[p.id] = p.display_name; }); }
    var playerIds = attendance.map(function (a) { return a.player_id; }).filter(Boolean);
    var playerById = {};
    if (playerIds.length) { var plRes = await client.from("players").select("id, name").in("id", playerIds); (plRes.data || []).forEach(function (p) { playerById[p.id] = p.name; }); }

    el.innerHTML = attendance.map(function (a) {
      var name = a.player_id ? (playerById[a.player_id] || "Player") : (profById[a.profile_id] || "Member");
      var value = (existing[rowKey(a)] || []).join(", ");
      return '<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid var(--line);">' +
        '<span>' + escapeHtml(name) + '</span>' +
        '<input type="text" class="pair-input" placeholder="Pair" title="One number, or two separated by a comma to play twice" style="width:104px; text-align:center;" ' +
        'data-profile-id="' + (a.profile_id || "") + '" data-player-id="' + (a.player_id || "") + '" value="' + escapeHtml(value) + '"></div>';
    }).join("");
    summarise();
  }

  /* Pairs everyone in list order. With an odd turnout the last player
     would have nobody, so they get a pair of their own and one player
     drawn at random from the pairs already made joins them - that
     player is then in two pairs and has two chances at the prize. */
  function autofillPairs() {
    var all = inputs();
    var assigned = all.map(function () { return []; });
    var wholePairs = Math.floor(all.length / 2);

    for (var i = 0; i < wholePairs * 2; i++) assigned[i].push(Math.floor(i / 2) + 1);

    if (all.length % 2 === 1 && wholePairs > 0) {
      var oddOne = all.length - 1;
      var extra = wholePairs + 1;
      var lucky = Math.floor(Math.random() * (wholePairs * 2));
      assigned[oddOne].push(extra);
      assigned[lucky].push(extra);
    }

    all.forEach(function (input, i) { setInputValue(input, assigned[i]); });
    summarise();
  }

  function clearPairs() {
    inputs().forEach(function (i) { i.value = ""; });
    summarise();
  }

  /* One row per player per pair number, so a player playing twice
     writes two rows. The whole pairs draw for the round is cleared and
     rewritten, which is also how a player drops back to one pair. */
  async function savePairs() {
    var select = document.getElementById("pair-event-select");
    var eventId = select ? select.value : null;
    if (!eventId) return;

    var rows = [];
    inputs().forEach(function (input) {
      parsePairNumbers(input.value).forEach(function (n) {
        rows.push({
          event_id: eventId,
          profile_id: input.dataset.profileId || null,
          player_id: input.dataset.playerId || null,
          group_number: n,
          group_type: TYPE,
          position: rows.length
        });
      });
    });

    setStatus("Saving...");
    var clear = await client.from("groupings").delete().eq("event_id", eventId).eq("group_type", TYPE);
    if (clear.error) { setStatus(clear.error.message, true); return; }
    if (rows.length) { var ins = await client.from("groupings").insert(rows); if (ins.error) { setStatus(ins.error.message, true); return; } }
    setStatus("Pairs saved.");
    summarise();
  }

  async function start() {
    var host = document.getElementById("pair-list");
    if (!host || !window.supabase || typeof SUPABASE_URL === "undefined") return;
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    var sess = await client.auth.getSession();
    if (!sess || !sess.data || !sess.data.session) return;
    var evRes = await client.from("events").select("id, name, event_date").order("event_date", { ascending: false });
    var events = evRes.data || [];
    var select = document.getElementById("pair-event-select");
    if (select) {
      select.innerHTML = events.map(function (e) { return '<option value="' + e.id + '">' + escapeHtml(e.name) + " - " + e.event_date + "</option>"; }).join("");
      select.onchange = function () { refreshPairList(select.value); };
      if (events.length) await refreshPairList(select.value);
    }
    var auto = document.getElementById("autofill-pairs-btn");
    if (auto) auto.addEventListener("click", autofillPairs);
    var clearBtn = document.getElementById("clear-pairs-btn");
    if (clearBtn) clearBtn.addEventListener("click", clearPairs);
    var save = document.getElementById("save-pairs-btn");
    if (save) save.addEventListener("click", savePairs);
    host.addEventListener("input", function (e) { if (e.target && e.target.classList && e.target.classList.contains("pair-input")) summarise(); });
  }

  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", start); } else { start(); }
})();
