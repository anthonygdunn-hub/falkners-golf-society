// ------------------------------------------------------------------
// Falkners Golf — live scoring app.
//
// Plain JavaScript, no build step, same as the rest of the site. It
// shares the website's Supabase project and login, so anybody signed
// in on the site is already signed in here.
//
// Routes (hash based so GitHub Pages needs no config):
//   #/                 rounds
//   #/round/<id>       a round: score, leaderboard, setup
//   #/courses          course list (committee)
//   #/course/<teeId>   edit a tee's holes (committee)
// ------------------------------------------------------------------
(function () {
  "use strict";

  const S = window.Scoring;
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const $ = sel => document.querySelector(sel);
  const view = $("#view");

  const QUEUE_KEY = "falkners-entry-queue";
  const DEFAULT_ALLOWANCE = 75;   // society default; the committee can change it per round
  const DEFAULT_TEE = "yellow";   // the society plays off the yellows
  // Individual formats the committee can switch on. Pairs isn't one of
  // them: it runs whenever the round has a pairs draw on the admin page.
  const FORMAT_LABELS = { stableford: "Stableford", medal: "Medal", skins: "Skins" };

  const app = {
    user: null,
    approved: false,
    committee: false,
    round: null,      // the round currently open
    channel: null,
    pollTimer: null,
  };

  // ---------- small helpers ----------

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  const todayISO = () => new Date().toISOString().slice(0, 10);
  // The UK date, so "on the day" is the golfer's day whatever the clock change.
  const londonToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  function fmtDate(iso, opts) {
    return new Date(iso + "T12:00:00").toLocaleDateString("en-GB", opts || { weekday: "short", day: "numeric", month: "short" });
  }
  function toPar(n) {
    if (n == null) return "–";
    if (n === 0) return "E";
    return n > 0 ? "+" + n : String(n);
  }
  function parClass(n) { return n == null || n === 0 ? "" : n < 0 ? "under-par" : "over-par"; }

  let toastTimer;
  function toast(msg, isErr) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 5000 : 2200);
  }

  function openSheet(html) {
    $("#sheet-body").innerHTML = html;
    $("#sheet").hidden = false;
  }
  function closeSheet() { $("#sheet").hidden = true; }

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  // ---------- offline score queue ----------
  // Every score goes into the queue first, then out to the database as
  // this phone's own entry (score_entries). The database works out the
  // result, and flags a dispute if another phone put in a different
  // number. No signal on the 14th? It waits on the phone and goes when
  // it can.

  function queue() { return store.get(QUEUE_KEY, []); }
  function setQueue(q) { store.set(QUEUE_KEY, q); updateSyncPill(); }

  function queueScore(row) {
    const q = queue().filter(r => !(r.event_id === row.event_id && r.player_id === row.player_id && r.hole === row.hole));
    q.push(row);
    setQueue(q);
    flushQueue();
  }

  let flushing = false;
  async function flushQueue() {
    if (flushing || !navigator.onLine) { updateSyncPill(); return; }
    const q = queue();
    if (!q.length) { updateSyncPill(); return; }
    flushing = true;
    try {
      const clears = q.filter(r => r.clear);
      const me = app.user && app.user.id;
      if (!me) return;
      const ups = q.filter(r => !r.clear).map(({ event_id, player_id, hole, strokes, picked_up }) =>
        ({ event_id, player_id, hole, strokes, picked_up, entered_by: me }));
      if (ups.length) {
        const { error } = await client.from("score_entries").upsert(ups, { onConflict: "event_id,player_id,hole,entered_by" });
        if (error) throw error;
      }
      for (const c of clears) {
        const { error } = await client.from("score_entries").delete()
          .eq("event_id", c.event_id).eq("player_id", c.player_id).eq("hole", c.hole).eq("entered_by", me);
        if (error) throw error;
      }
      // Only drop what we sent — anything added meanwhile stays.
      const sent = new Set(q.map(r => r.event_id + r.player_id + r.hole + (r.ts || "")));
      setQueue(queue().filter(r => !sent.has(r.event_id + r.player_id + r.hole + (r.ts || ""))));
    } catch (err) {
      // A permission error won't fix itself by retrying: say so.
      if (err && (err.code === "42501" || /row-level security/i.test(err.message || ""))) {
        toast("Scores couldn't be saved — the round may not be live, the card may be submitted, or you're not on it.", true);
        // Those entries will never go: drop them so the phone matches the card.
        setQueue([]);
        if (app.round) reloadRound(true);
      }
    } finally {
      flushing = false;
      updateSyncPill();
    }
  }

  function updateSyncPill() {
    const pill = $("#sync-pill");
    const n = queue().length;
    if (!navigator.onLine) {
      pill.hidden = false; pill.className = "sync-pill offline";
      pill.textContent = n ? `Offline · ${n} to send` : "Offline";
    } else if (n) {
      pill.hidden = false; pill.className = "sync-pill";
      pill.textContent = `Sending ${n}…`;
    } else pill.hidden = true;
  }

  window.addEventListener("online", flushQueue);
  window.addEventListener("offline", updateSyncPill);
  setInterval(flushQueue, 15000);

  // ---------- auth ----------

  async function loadUser() {
    const { data } = await client.auth.getSession();
    app.user = data.session ? data.session.user : null;
    if (!app.user) { app.approved = false; app.committee = false; return; }
    const [appr, comm] = await Promise.all([
      client.rpc("is_approved_member"),
      client.rpc("is_committee"),
    ]);
    app.approved = !!appr.data;
    app.committee = !!comm.data;
    $("#menu-btn").hidden = false;
    $("#menu-courses").hidden = !app.committee;
  }

  function renderSignIn(msg) {
    $("#menu-btn").hidden = true;
    view.innerHTML = `
      <div class="card">
        <h1>Sign in</h1>
        <p class="muted small">Same email and password as the society website.</p>
        <form id="signin-form">
          <label class="field">Email<input type="email" name="email" autocomplete="email" required></label>
          <label class="field">Password<input type="password" name="password" autocomplete="current-password" required></label>
          <button class="btn block" type="submit">Sign in</button>
          <div id="signin-status" class="status-msg ${msg ? "err" : ""}" ${msg ? "" : "hidden"}>${esc(msg || "")}</div>
        </form>
        <p class="small" style="margin-top:16px;">
          New to the society? <a href="../member.html">Join on the website</a><br>
          Forgotten your password? <a href="../member.html">Reset it here</a>
        </p>
      </div>`;
    $("#signin-form").addEventListener("submit", async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const st = $("#signin-status");
      st.hidden = false; st.className = "status-msg"; st.textContent = "Signing in…";
      const { error } = await client.auth.signInWithPassword({ email: f.get("email"), password: f.get("password") });
      if (error) { st.className = "status-msg err"; st.textContent = error.message; return; }
      await loadUser();
      route();
    });
  }

  function renderNotApproved() {
    view.innerHTML = `
      <div class="card">
        <h1>Nearly there</h1>
        <p>Your membership is waiting for the committee to approve it. Once it is, live scores and leaderboards appear here.</p>
        <a class="btn ghost block" href="../member.html">My account</a>
      </div>`;
  }

  // ---------- rounds list ----------

  async function renderHome() {
    view.innerHTML = `<div class="loading">Loading rounds…</div>`;
    const [{ data: events, error }, { data: setups }] = await Promise.all([
      client.from("events").select("id, name, venue, event_date, tee_time, format, hidden").eq("hidden", false).order("event_date"),
      client.from("event_scoring").select("event_id, status"),
    ]);
    if (error) { view.innerHTML = `<div class="card status-msg err">Couldn't load rounds: ${esc(error.message)}</div>`; return; }
    const status = new Map((setups || []).map(s => [s.event_id, s.status]));
    const today = todayISO();
    const live = events.filter(e => status.get(e.id) === "live");
    const upcoming = events.filter(e => e.event_date >= today && status.get(e.id) !== "live");
    const past = events.filter(e => e.event_date < today && status.get(e.id) !== "live").reverse();

    const item = e => {
      const st = status.get(e.id);
      const badge = st === "live" ? `<span class="badge live">Live</span>`
        : st === "final" ? `<span class="badge final">Final</span>`
        : st === "setup" ? `<span class="badge">Set up</span>` : "";
      const d = new Date(e.event_date + "T12:00:00");
      return `
        <a class="card round-item" href="#/round/${e.id}">
          <div class="round-date"><b>${d.getDate()}</b><span>${d.toLocaleDateString("en-GB", { month: "short" })}</span></div>
          <div class="round-meta">
            <strong>${esc(e.name)}</strong>
            <span class="muted small">${esc(e.venue || "Venue TBC")}${e.tee_time ? " · " + esc(e.tee_time.slice(0, 5)) : ""}</span>
          </div>
          ${badge}
        </a>`;
    };

    view.innerHTML = `
      ${installTip()}
      ${live.length ? `<div class="section-label">Live now</div>${live.map(item).join("")}` : ""}
      <div class="section-label">Coming up</div>
      ${upcoming.length ? upcoming.map(item).join("") : `<p class="empty">No rounds scheduled.</p>`}
      ${past.length ? `<div class="section-label">Played</div>${past.map(item).join("")}` : ""}`;
  }

  function installTip() {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    if (standalone || store.get("hide-install-tip", false)) return "";
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    return `
      <div class="card install-tip small">
        <div class="row"><strong>Put this on your home screen</strong><span class="spacer"></span>
          <button class="icon-btn" style="color:var(--ink-soft)" data-action="hide-tip" aria-label="Dismiss">×</button></div>
        <div class="muted">${ios
          ? "In Safari, tap the Share button, then <b>Add to Home Screen</b>."
          : "In Chrome, tap the ⋮ menu, then <b>Add to Home screen</b> or <b>Install app</b>."}</div>
      </div>`;
  }

  // ---------- loading a round ----------

  async function loadRound(eventId) {
    const [ev, setup, field, hcps, scores, manage, entries, subs, checks] = await Promise.all([
      client.from("events").select("*").eq("id", eventId).maybeSingle(),
      client.from("event_scoring").select("*").eq("event_id", eventId).maybeSingle(),
      client.rpc("scoring_field", { target: eventId }),
      client.from("event_handicaps").select("*").eq("event_id", eventId),
      client.from("hole_scores").select("player_id, hole, strokes, picked_up, updated_at, disputed, escalated, settled_by").eq("event_id", eventId),
      client.rpc("can_manage_round", { target: eventId }),
      client.from("score_entries").select("player_id, hole, entered_by, strokes, picked_up, updated_at").eq("event_id", eventId),
      client.from("card_submissions").select("player_id, submitted_by, submitted_at").eq("event_id", eventId),
      client.from("round_checkins").select("player_id, checked_in_by, checked_in_at").eq("event_id", eventId),
    ]);
    // Check-ins are a nice-to-have: if they can't load, the round still opens.
    const err = ev.error || setup.error || field.error || hcps.error || scores.error || entries.error || subs.error;
    if (err) throw err;
    if (!ev.data) throw new Error("That round doesn't exist.");

    let tee = null, holes = [], course = null;
    if (setup.data && setup.data.tee_id) {
      const [t, h] = await Promise.all([
        client.from("course_tees").select("*, courses(*)").eq("id", setup.data.tee_id).maybeSingle(),
        client.from("course_holes").select("*").eq("tee_id", setup.data.tee_id).order("hole"),
      ]);
      tee = t.data; course = t.data && t.data.courses; holes = h.data || [];
    }
    let geo = new Map();
    if (course) {
      const { data: g } = await client.from("course_hole_geo").select("*").eq("course_id", course.id);
      geo = new Map((g || []).map(x => [x.hole, x]));
    }

    const r = {
      id: eventId,
      event: ev.data,
      setup: setup.data,
      tee, course, holes, geo,
      field: field.data || [],
      hcps: new Map((hcps.data || []).map(h => [h.player_id, h])),
      scores: {},
      entries: new Map(),
      submitted: new Map((subs.data || []).map(x => [x.player_id, x])),
      checkins: new Map((checks.error ? [] : checks.data || []).map(x => [x.player_id, x])),
      checkinsOff: !!checks.error,
      canManage: !!manage.data,
    };
    (scores.data || []).forEach(s => applyScore(r, s));
    (entries.data || []).forEach(e => applyEntry(r, e));
    buildPlayers(r);
    return r;
  }

  function applyScore(r, s) {
    if (!r.scores[s.player_id]) r.scores[s.player_id] = {};
    const prev = r.scores[s.player_id][s.hole] || {};
    r.scores[s.player_id][s.hole] = {
      strokes: s.strokes, picked_up: s.picked_up,
      disputed: s.disputed != null ? !!s.disputed : !!prev.disputed,
      escalated: s.escalated != null ? !!s.escalated : !!prev.escalated,
      settled: s.settled_by !== undefined ? !!s.settled_by : !!prev.settled,
    };
  }

  // ---------- entries: who put in what ----------

  const cellKey = (pid, hole) => pid + ":" + hole;
  const sameScore = (a, b) => !!a && !!b && !!a.picked_up === !!b.picked_up && (a.picked_up || a.strokes === b.strokes);
  const scoreText = e => e.picked_up ? "P/U" : String(e.strokes);

  function applyEntry(r, e) {
    const k = cellKey(e.player_id, e.hole);
    const list = (r.entries.get(k) || []).filter(x => x.entered_by !== e.entered_by);
    list.push({ entered_by: e.entered_by, strokes: e.strokes, picked_up: !!e.picked_up, updated_at: e.updated_at || new Date().toISOString() });
    r.entries.set(k, list);
  }

  function removeEntry(r, pid, hole, by) {
    const k = cellKey(pid, hole);
    const list = (r.entries.get(k) || []).filter(x => x.entered_by !== by);
    if (list.length) r.entries.set(k, list); else r.entries.delete(k);
  }

  function entriesFor(r, pid, hole) { return r.entries.get(cellKey(pid, hole)) || []; }
  function myEntry(r, pid, hole) { return entriesFor(r, pid, hole).find(e => app.user && e.entered_by === app.user.id) || null; }

  // The same rule the database uses: all entries agree, or it's disputed
  // and the most recent one shows. Used for this phone's unsent entries.
  function recomputeCell(r, pid, hole) {
    const list = entriesFor(r, pid, hole);
    if (!list.length) { if (r.scores[pid]) delete r.scores[pid][hole]; return; }
    const latest = list.slice().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
    const disputed = list.some(e => !sameScore(e, list[0]));
    const prev = (r.scores[pid] || {})[hole] || {};
    applyScore(r, { player_id: pid, hole, strokes: latest.strokes, picked_up: latest.picked_up, disputed,
                    escalated: disputed ? !!prev.escalated : false, settled_by: disputed ? null : (prev.settled ? true : null) });
  }

  // Who put an entry in, in words.
  function entrant(r, by) {
    if (app.user && by === app.user.id) return "You";
    const f = r.field.find(x => x.profile_id === by);
    return f ? f.name.split(" ")[0] : "Committee";
  }

  // Overlay anything still waiting to send, so your own phone always
  // shows what you entered even before it reaches the server.
  function overlayQueue(r) {
    if (!app.user) return;
    queue().filter(q => q.event_id === r.id).forEach(q => {
      if (q.clear) removeEntry(r, q.player_id, q.hole, app.user.id);
      else applyEntry(r, { ...q, entered_by: app.user.id, updated_at: new Date(q.ts || Date.now()).toISOString() });
      recomputeCell(r, q.player_id, q.hole);
    });
  }

  function disputesFor(r, players) {
    const out = [];
    players.forEach(p => Object.entries(p.scores || {}).forEach(([hole, sc]) => {
      if (sc && sc.disputed) out.push({ player: p, hole: Number(hole), sc, entries: entriesFor(r, p.id, Number(hole)) });
    }));
    return out.sort((a, b) => a.hole - b.hole || a.player.name.localeCompare(b.player.name));
  }

  // The pairs draw as [{ number, players }], from the numbers set on the
  // admin page. A player holding two numbers appears in both pairs.
  function pairsOf(players) {
    const byPair = new Map();
    players.forEach(p => (p.pairs || []).forEach(n => {
      if (!byPair.has(n)) byPair.set(n, []);
      byPair.get(n).push(p);
    }));
    return [...byPair.entries()].sort((a, b) => a[0] - b[0]).map(([number, ps]) => ({ number, players: ps }));
  }

  function partnersOf(r, p) {
    return (r.pairs || []).filter(x => x.players.some(y => y.id === p.id))
      .map(x => ({ number: x.number, others: x.players.filter(y => y.id !== p.id) }));
  }

  function parTotal(r) { return r.holes.reduce((t, h) => t + h.par, 0); }

  function buildPlayers(r) {
    overlayQueue(r);
    const setup = r.setup || {};
    // Before the round's tee is saved, preview the one setup has picked.
    const tee = r.tee || r.previewTee || null;
    const par = r.tee ? parTotal(r) : (r.previewTee ? r.previewTee.par : null);
    r.players = r.field.filter(f => f.player_id).map(f => {
      const h = r.hcps.get(f.player_id) || {};
      const index = h.handicap_index != null ? Number(h.handicap_index) : (f.handicap != null ? Number(f.handicap) : null);
      const method = setup.handicap_method || "whs";
      const ph = S.playingHandicap({
        method,
        allowance: setup.allowance != null ? setup.allowance : DEFAULT_ALLOWANCE,
        index, override: h.playing_handicap, tee, par,
      });
      const ch = method === "whs" && tee && index != null
        ? S.courseHandicap(index, tee.slope, tee.course_rating, par) : null;
      return {
        id: f.player_id, profileId: f.profile_id, name: f.name, index, ph, ch,
        overridden: h.playing_handicap != null,
        guest: f.is_guest, group: f.tee_group, pairs: (f.pair_groups || []).map(Number),
        scores: r.scores[f.player_id] || {},
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    r.unlinked = r.field.filter(f => !f.player_id);
    r.pairs = pairsOf(r.players);
    r.me = r.players.find(p => p.profileId && app.user && p.profileId === app.user.id) || null;
  }

  // ---------- realtime ----------

  function subscribe(r) {
    unsubscribe();
    app.channel = client.channel("round-" + r.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "hole_scores", filter: `event_id=eq.${r.id}` }, payload => {
        if (!app.round || app.round.id !== r.id) return;
        if (payload.eventType === "DELETE") {
          const o = payload.old || {};
          if (o.player_id && app.round.scores[o.player_id]) delete app.round.scores[o.player_id][o.hole];
        } else {
          const n = payload.new;
          const before = (app.round.scores[n.player_id] || {})[n.hole];
          applyScore(app.round, n);
          notifyChange(app.round, before, n);
        }
        refreshRound();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "score_entries", filter: `event_id=eq.${r.id}` }, payload => {
        if (!app.round || app.round.id !== r.id) return;
        if (payload.eventType === "DELETE") {
          const o = payload.old || {};
          if (o.player_id) removeEntry(app.round, o.player_id, o.hole, o.entered_by);
        } else {
          applyEntry(app.round, payload.new);
          notifyClash(app.round, payload.new);
        }
        refreshRound();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "card_submissions", filter: `event_id=eq.${r.id}` }, () => reloadRound(true))
      .on("postgres_changes", { event: "*", schema: "public", table: "round_checkins", filter: `event_id=eq.${r.id}` }, payload => {
        if (!app.round || app.round.id !== r.id) return;
        if (payload.eventType === "DELETE") { if (payload.old && payload.old.player_id) app.round.checkins.delete(payload.old.player_id); }
        else app.round.checkins.set(payload.new.player_id, payload.new);
        refreshRound();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "event_scoring", filter: `event_id=eq.${r.id}` }, () => reloadRound())
      .subscribe();
    // Belt and braces: phones drop sockets when the screen locks.
    app.pollTimer = setInterval(() => { if (document.visibilityState === "visible") reloadRound(true); }, 30000);
  }

  // Everyone is told when somebody else's number clashes with theirs, or
  // changes a score in the group they're marking.
  const told = new Set();
  function notifyClash(r, e) {
    if (!app.user || e.entered_by === app.user.id) return;
    const mine = myEntry(r, e.player_id, e.hole);
    if (!mine || sameScore(mine, e)) return;
    const key = [e.player_id, e.hole, e.entered_by, e.strokes, e.picked_up].join("|");
    if (told.has(key)) return;
    told.add(key);
    const p = r.players.find(x => x.id === e.player_id);
    toast(`${entrant(r, e.entered_by)} put ${scoreText(e)} for ${p ? p.name : "a player"} on hole ${e.hole} — you have ${scoreText(mine)}. Agree it before the card goes in.`, true);
  }

  function notifyChange(r, before, n) {
    if (!app.user || !before || n.entered_by === app.user.id) return;
    if (sameScore(before, n) || n.disputed) return; // disputes are told by notifyClash
    const inView = selectedPlayers(r).some(p => p.id === n.player_id);
    if (!inView || myEntry(r, n.player_id, n.hole)) return;
    const p = r.players.find(x => x.id === n.player_id);
    toast(`${entrant(r, n.entered_by)} changed ${p ? p.name : "a player"}'s hole ${n.hole} to ${scoreText(n)}.`);
  }

  function unsubscribe() {
    if (app.channel) { client.removeChannel(app.channel); app.channel = null; }
    if (app.pollTimer) { clearInterval(app.pollTimer); app.pollTimer = null; }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && app.round) reloadRound(true);
  });

  let refreshQueued = false;
  function refreshRound() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      if (!app.round) return;
      buildPlayers(app.round);
      // Don't redraw the setup form under somebody's thumbs.
      if (app.round.tab !== "setup") renderRoundBody();
    });
  }

  async function reloadRound(quiet) {
    if (!app.round) return;
    const keep = { tab: app.round.tab, hole: app.round.hole, board: app.round.board, groupKey: app.round.groupKey, gross: app.round.gross, editHcp: app.round.editHcp, arrived: app.round.arrived };
    try {
      const r = await loadRound(app.round.id);
      Object.assign(r, keep);
      app.round = r;
      if (!(quiet && keep.tab === "setup")) renderRoundBody();
    } catch (e) { if (!quiet) toast(e.message, true); }
  }

  // ---------- round page ----------

  async function renderRound(eventId, arrived) {
    view.innerHTML = `<div class="loading">Loading round…</div>`;
    let r;
    try { r = await loadRound(eventId); }
    catch (e) { view.innerHTML = `<div class="card status-msg err">${esc(e.message)}</div>`; return; }
    const prefs = store.get("round-" + eventId, {});
    const live = r.setup && r.setup.status === "live";
    r.tab = prefs.tab || (live && r.me ? "score" : r.setup ? "board" : (r.canManage ? "setup" : "board"));
    r.hole = prefs.hole || 1;
    r.groupKey = prefs.groupKey || (r.me && r.me.group ? "g" + r.me.group : null);
    r.board = prefs.board || null;
    // Arriving from "Start round" on the fixture page: straight to your group's card.
    if (arrived) {
      r.tab = "score";
      r.arrived = true;
      if (r.me && r.me.group) r.groupKey = "g" + r.me.group;
      else if (r.me) r.groupKey = "me";
      history.replaceState(null, "", "#/round/" + eventId);
    }
    app.round = r;
    subscribe(r);
    renderRoundBody();
  }

  function savePrefs() {
    const r = app.round;
    store.set("round-" + r.id, { tab: r.tab, hole: r.hole, groupKey: r.groupKey, board: r.board });
  }

  function renderRoundBody() {
    const r = app.round;
    const st = r.setup ? r.setup.status : null;
    const badge = st === "live" ? `<span class="badge live">Live</span>` : st === "final" ? `<span class="badge final">Final</span>` : "";
    const tabs = [["score", "Score"], ["board", "Individual"]];
    if (r.pairs && r.pairs.length) tabs.push(["pairs", "Pairs"]);
    if (r.canManage) tabs.push(["setup", "Setup"]);
    view.innerHTML = `
      <div class="round-head">
        <div class="row"><h1>${esc(r.event.name)}</h1><span class="spacer"></span>${badge}</div>
        <div class="muted small">${esc(r.course ? r.course.name : r.event.venue || "")}${r.tee ? " · " + esc(r.tee.name) + " tees" : ""} · ${fmtDate(r.event.event_date)}</div>
      </div>
      <div class="tabs" role="tablist">
        ${tabs.map(([k, l]) => `<button role="tab" data-action="tab" data-tab="${k}" aria-selected="${r.tab === k}">${l}</button>`).join("")}
      </div>
      <div id="round-body"></div>`;
    const body = $("#round-body");
    if (r.tab === "score") {
      body.innerHTML = scoreView(r);
      if (store.get("gps-on", false) && r.geo && r.geo.size && window.HoleMaps) window.HoleMaps.startGps();
    }
    else if (r.tab === "setup" && r.canManage) { body.innerHTML = setupView(r); wireSetup(r); }
    else if (r.tab === "pairs" && r.pairs.length) body.innerHTML = notReady(r) || pairsTable(r);
    else body.innerHTML = boardView(r);
  }

  function notReady(r) {
    if (!r.setup || !r.tee || r.holes.length !== 18) {
      return `<div class="card empty">
        <p>This round hasn't been set up for scoring yet.</p>
        ${r.canManage ? `<button class="btn" data-action="tab" data-tab="setup">Set it up</button>` : `<p class="small">The committee will open it on the day.</p>`}
      </div>`;
    }
    return null;
  }

  // ---------- score entry ----------

  function groupsOf(r) {
    const groups = new Map();
    r.players.forEach(p => {
      if (p.group == null) return;
      if (!groups.has(p.group)) groups.set(p.group, []);
      groups.get(p.group).push(p);
    });
    return [...groups.entries()].sort((a, b) => a[0] - b[0]);
  }

  function selectedPlayers(r) {
    if (!r.groupKey) return [];
    if (r.groupKey === "me") return r.me ? [r.me] : [];
    if (r.groupKey.startsWith("g")) {
      const n = Number(r.groupKey.slice(1));
      return r.players.filter(p => p.group === n);
    }
    const ids = store.get("custom-" + r.id, []);
    return r.players.filter(p => ids.includes(p.id));
  }

  function canScore(r) {
    if (r.canManage) return true;
    return r.setup && r.setup.status === "live" && !!r.me;
  }

  function scoreView(r) {
    const ci = checkinCard(r);
    const nr = notReady(r);
    if (nr) return ci + nr;
    if (!canScore(r)) {
      const why = r.setup.status === "final" ? "This round is finished — scores are locked."
        : r.setup.status === "setup" ? "Scoring opens when the committee starts the round."
        : "Only players on this round can enter scores.";
      return ci + `<div class="card empty"><p>${why}</p><button class="btn ghost" data-action="tab" data-tab="board">See the leaderboard</button></div>`;
    }

    const groups = groupsOf(r);
    const picker = `
      <div class="group-picker">
        ${r.me ? `<button data-action="group" data-key="me" aria-selected="${r.groupKey === "me"}">Just me</button>` : ""}
        ${groups.map(([n, ps]) => `<button data-action="group" data-key="g${n}" aria-selected="${r.groupKey === "g" + n}">Group ${n}${ps.some(p => r.me && p.id === r.me.id) ? " ★" : ""}</button>`).join("")}
        <button data-action="custom-group" aria-selected="${r.groupKey === "custom"}">Pick players</button>
      </div>`;

    const players = selectedPlayers(r);
    if (!players.length) {
      return ci + personalSummary(r) + picker + `<div class="card empty"><p>Choose the group you're marking for, or just your own card.</p>
        <p class="small muted">One phone can score the whole group — nobody else needs the app. If two phones put in different numbers, everyone's told and it's flagged to agree.</p></div>`;
    }

    const h = r.holes[r.hole - 1];
    const strip = r.holes.map(x => {
      const done = players.every(p => { const s = p.scores[x.hole]; return s && (s.strokes != null || s.picked_up); });
      const disputed = players.some(p => { const s = p.scores[x.hole]; return s && s.disputed; });
      return `<button data-action="hole" data-hole="${x.hole}" class="${x.hole === r.hole ? "current" : done ? "done" : ""}${disputed ? " disputed" : ""}">${x.hole}</button>`;
    }).join("");

    const cards = players.map(p => {
      const sc = p.scores[h.hole];
      const lock = locked(r, p.id);
      const shots = S.shotsOnHole(p.ph, h.stroke_index, 18);
      const sum = S.summarise(r.holes, p.scores, p.ph);
      let valClass = "val", valText = "–";
      if (sc && sc.disputed) valClass += " disputed";
      if (sc && sc.picked_up) { valClass += " pu"; valText = "P/U"; }
      else if (sc && sc.strokes != null) {
        const diff = sc.strokes - h.par;
        valClass += diff < 0 ? " under" : diff > 0 ? " over" : " set";
        valText = sc.strokes;
      }
      const pts = sc ? S.stablefordPoints(h.par, sc.strokes, shots, sc.picked_up) : null;
      const dots = shots > 0 ? `<span class="shots" aria-label="${shots} shot${shots > 1 ? "s" : ""}">${"<i></i>".repeat(Math.min(shots, 4))}</span>`
        : shots < 0 ? `<span class="shots" aria-label="gives a shot back"><i class="minus"></i></span>` : "";
      return `
        <div class="score-card">
          <div class="score-name">
            <strong>${esc(p.name)}${dots}</strong>
            <div class="sub">PH ${p.ph == null ? "?" : p.ph} · ${sum.points} pts thru ${sum.thru}${pts != null ? ` · <span class="pts">${pts} here</span>` : ""}</div>
            ${lock ? `<div class="sub"><span class="tick">✓</span> Card submitted</div>` : `<div class="mini-actions">
              <button data-action="pickup" data-player="${p.id}">Pick up</button>
              ${myEntry(r, p.id, h.hole) ? `<button data-action="clear" data-player="${p.id}">Clear</button>` : ""}
            </div>`}
          </div>
          <div class="stepper">
            <button data-action="minus" data-player="${p.id}" aria-label="One fewer for ${esc(p.name)}" ${lock ? "disabled" : ""}>−</button>
            <button class="${valClass}" data-action="tap-val" data-player="${p.id}" aria-label="Score for ${esc(p.name)}" ${lock ? "disabled" : ""}>${valText}</button>
            <button data-action="plus" data-player="${p.id}" aria-label="One more for ${esc(p.name)}" ${lock ? "disabled" : ""}>+</button>
          </div>
          ${disputeBox(r, p, h.hole)}
        </div>`;
    }).join("");

    return `
      ${ci}
      ${personalSummary(r)}
      ${picker}
      ${disputeBanner(r, players)}
      <div class="hole-strip">${strip}</div>
      <div class="hole-head">
        <div class="num"><small>HOLE</small>${h.hole}</div>
        <div class="facts">
          <div>Par<b>${h.par}</b></div>
          <div>SI<b>${h.stroke_index}</b></div>
          ${h.yards ? `<div>Yds<b>${h.yards}</b></div>` : ""}
        </div>
      </div>
      ${gpsBar(r, h.hole)}
      <div class="card">${cards}</div>
      <div class="hole-nav">
        <button class="btn ghost" data-action="prev-hole" ${r.hole === 1 ? "disabled" : ""}>← Hole ${r.hole - 1 || ""}</button>
        <button class="btn" data-action="next-hole">${r.hole === 18 ? "Review & submit" : "Hole " + (r.hole + 1) + " →"}</button>
      </div>`;
  }

  function locked(r, playerId) {
    return r.submitted.has(playerId) && !app.committee;
  }

  function setStroke(playerId, next) {
    const r = app.round;
    if (locked(r, playerId)) { toast("That card's been submitted — ask the committee to change it.", true); return; }
    const h = r.holes[r.hole - 1];
    const row = { event_id: r.id, player_id: playerId, hole: h.hole, ts: Date.now() };
    if (next === "clear") {
      row.clear = true;
      removeEntry(r, playerId, h.hole, app.user.id);
    } else {
      if (next === "pickup") { row.strokes = null; row.picked_up = true; }
      else { row.strokes = Math.max(1, Math.min(20, next)); row.picked_up = false; }
      applyEntry(r, { ...row, entered_by: app.user.id, updated_at: new Date().toISOString() });
    }
    recomputeCell(r, playerId, h.hole);
    queueScore(row);
    buildPlayers(r);
    renderRoundBody();
  }

  // Steppers start from this phone's own number, so pressing + on a
  // disputed hole changes your entry, not somebody else's.
  function currentStroke(playerId) {
    const r = app.round;
    const mine = myEntry(r, playerId, r.hole);
    if (mine) return mine.strokes;
    const sc = r.scores[playerId] && r.scores[playerId][r.hole];
    return sc && sc.strokes != null ? sc.strokes : null;
  }

  // ---------- distances ----------

  // The strip under the hole header: live yards to the middle of the
  // green, and the button that opens the satellite view.
  function gpsBar(r, hole) {
    const g = r.geo && r.geo.get(hole);
    const mapped = g && g.green_lat != null;
    if (!mapped) {
      return app.committee && r.course
        ? `<div class="gps-bar muted small">Hole ${hole} isn't on the map yet. <a href="#/course-map/${r.course.id}">Map the holes</a></div>` : "";
    }
    const on = store.get("gps-on", false);
    return `<div class="gps-bar">
      <span id="gps-yds" class="gps-yds">${on ? gpsText(r, hole) : `<button class="mv-link" data-action="gps-on">Show yardage to the green</button>`}</span>
      <span class="spacer"></span>
      <button class="btn ghost" style="min-height:36px" data-action="hole-map">Map</button>
    </div>`;
  }

  function gpsText(r, hole) {
    const HM = window.HoleMaps;
    const g = r.geo && r.geo.get(hole);
    if (!HM || !g) return "";
    const d = HM.toGreen(g);
    if (HM.gps.error) return `<span class="small muted">${esc(HM.gps.error)}</span>`;
    if (!d) return `<span class="small muted">Finding you…</span>`;
    if (d.off) return `<span class="small muted">Not on the course — yardage shows when you are</span>`;
    return `<b>${d.yards}</b> yds <span class="small muted">to the middle · ±${d.acc}</span>`;
  }

  // Keep the yardage ticking over without redrawing the whole screen.
  if (window.HoleMaps) {
    window.HoleMaps.onGps(() => {
      const el = document.getElementById("gps-yds");
      if (el && app.round && store.get("gps-on", false)) el.innerHTML = gpsText(app.round, app.round.hole);
    });
  }

  // ---------- checking in on the day ----------

  const isToday = r => r.event.event_date === londonToday();

  // Who this phone can check in: your tee group (or everyone, before the
  // draw is set). The committee checks people in from Setup as well.
  function checkinGroup(r) {
    if (!r.me) return app.committee ? selectedPlayers(r) : [];
    if (r.me.group == null) {
      const drawSet = r.players.some(p => p.group != null);
      return drawSet ? [r.me] : r.players;
    }
    return r.players.filter(p => p.group === r.me.group);
  }

  function checkinCard(r) {
    if (r.checkinsOff || !isToday(r) || (r.setup && r.setup.status === "final")) return "";
    const group = checkinGroup(r);
    if (!group.length) return "";
    const here = group.filter(p => r.checkins.has(p.id));
    const label = r.me && r.me.group != null ? `Group ${r.me.group}` : "Your group";
    if (here.length === group.length && !r.showCheckin) {
      return `<div class="card small row checkin-done"><span class="tick">✓</span>
        <span>${group.length === 1 ? "You're checked in." : `${label}: all ${group.length} checked in.`}</span>
        <span class="spacer"></span><button class="mv-link" data-action="show-checkin">Change</button></div>`;
    }
    const me = r.me;
    return `<div class="card checkin-card">
      <h2 style="margin-bottom:4px">Check in</h2>
      <p class="small muted" style="margin:0 0 10px">${r.arrived && me && !r.checkins.has(me.id) ? "Welcome — tap to say you're here and ready to play. " : ""}Anyone in the group can check the others in, so nobody needs the app.</p>
      ${group.map(p => {
        const inNow = r.checkins.has(p.id);
        return `<div class="row checkin-row">
          <div><strong>${esc(p.name)}</strong>${me && p.id === me.id ? ' <span class="muted small">(you)</span>' : ""}
            <div class="thru">${p.ph == null ? "" : "Plays off " + p.ph}</div></div>
          <span class="spacer"></span>
          <button class="btn ${inNow ? "ghost" : "gold"}" style="min-height:40px" data-action="checkin" data-player="${p.id}" data-here="${inNow ? 0 : 1}">${inNow ? "✓ Here" : "Check in"}</button>
        </div>`;
      }).join("")}
      ${group.length > 1 && here.length < group.length ? `<button class="btn block" style="margin-top:10px" data-action="checkin-all">Check in all ${group.length}</button>` : ""}
      ${r.showCheckin ? `<button class="mv-link" style="margin-top:8px" data-action="hide-checkin">Done</button>` : ""}
    </div>`;
  }

  async function setCheckin(r, ids, here) {
    for (const id of ids) {
      const { error } = await client.rpc("check_in", { p_event: r.id, p_player: id, p_here: here });
      if (error) { toast(error.message, true); return; }
      if (here) r.checkins.set(id, { player_id: id, checked_in_by: app.user.id }); else r.checkins.delete(id);
    }
    if (here && ids.length) toast(ids.length > 1 ? `${ids.length} checked in` : "Checked in");
    renderRoundBody();
  }

  // Committee view: who's here, and who isn't yet.
  function checkinsSetupCard(r) {
    if (r.checkinsOff || !r.players.length) return "";
    const here = r.players.filter(p => r.checkins.has(p.id));
    const missing = r.players.filter(p => !r.checkins.has(p.id));
    const today = isToday(r);
    return `<div class="card">
      <h2>Check-in</h2>
      <p class="small" style="margin:0"><b>${here.length} of ${r.players.length}</b> checked in${today ? "" : " — players can check in on the day, from the fixture page or the app"}.</p>
      ${missing.length ? `<div style="margin-top:8px">${missing.map(p => `<div class="row checkin-row"><span>${esc(p.name)}${p.group ? ` <span class="muted small">Grp ${p.group}</span>` : ""}</span><span class="spacer"></span>
        <button class="btn ghost" style="min-height:34px" data-action="checkin" data-player="${p.id}" data-here="1">Check in</button></div>`).join("")}</div>` : ""}
    </div>`;
  }

  // ---------- personal card ----------

  function personalSummary(r) {
    const me = r.me;
    if (!me || !r.holes.length) return "";
    const board = S.stablefordBoard(r.holes, r.players);
    const mine = board.find(x => x.player.id === me.id);
    if (!mine) return "";
    const started = board.filter(x => x.sum.thru > 0).length;
    const pairs = r.pairs && r.pairs.length ? S.pairsBoard(r.holes, r.pairs) : [];
    const myPairs = pairs.filter(x => (me.pairs || []).includes(x.pair.number));
    const ds = disputesFor(r, [me]).length;
    return `<div class="card me-card">
      <div class="row" style="gap:16px">
        <div><div class="big">${mine.sum.points}</div><div class="thru">Your points</div></div>
        <div><div class="big">${mine.sum.thru ? (mine.tied ? "T" : "") + mine.pos : "–"}</div><div class="thru">of ${started || r.players.length}</div></div>
        <div><div class="big">${thruText(mine.sum)}</div><div class="thru">Played</div></div>
        <span class="spacer"></span>
        <button class="btn ghost" style="min-height:36px" data-action="open-card" data-player="${me.id}">My card</button>
      </div>
      ${myPairs.length ? `<div class="small muted" style="margin-top:8px">${myPairs.map(x => `Pair ${x.pair.number}: <b>${x.points}</b> pts${x.started ? ` · ${x.tied ? "T" : ""}${x.pos} of ${pairs.length}` : ""}`).join(" · ")}</div>` : ""}
      ${r.submitted.has(me.id) ? `<div class="small" style="margin-top:6px"><span class="tick">✓</span> Your card is submitted</div>` : ""}
      ${ds ? `<div class="small" style="margin-top:6px;color:var(--bad)">⚠ ${ds} disputed hole${ds > 1 ? "s" : ""} on your card</div>` : ""}
    </div>`;
  }

  // ---------- disputes in the group ----------

  function disputeBanner(r, players) {
    const ds = disputesFor(r, players);
    if (!ds.length) return "";
    return `<div class="card dispute-banner">
      <strong>⚠ ${ds.length} disputed score${ds.length > 1 ? "s" : ""}</strong>
      <p class="small" style="margin:4px 0 8px">Two phones put in different numbers. Keep playing — agree ${ds.length > 1 ? "them" : "it"} before the card is submitted.</p>
      ${ds.map(d => `<button class="dispute-row" data-action="hole" data-hole="${d.hole}">
        <span>Hole ${d.hole} · ${esc(d.player.name)}</span>
        <span class="muted small">${d.entries.map(e => `${esc(entrant(r, e.entered_by))} ${scoreText(e)}`).join(" · ")}${d.sc.escalated ? " · committee asked" : ""}</span>
      </button>`).join("")}
    </div>`;
  }

  function disputeBox(r, p, hole) {
    const sc = p.scores[hole];
    if (!sc || !sc.disputed) return "";
    const list = entriesFor(r, p.id, hole);
    const mine = myEntry(r, p.id, hole);
    const others = [];
    list.forEach(e => { if (!sameScore(e, mine) && !others.some(o => sameScore(o, e))) others.push(e); });
    return `<div class="dispute-box">
      <div><b>Disputed:</b> ${list.map(e => `${esc(entrant(r, e.entered_by))} ${scoreText(e)}`).join(" · ")}</div>
      <div class="mini-actions">
        ${mine ? others.map(e => `<button data-action="accept" data-player="${p.id}" data-hole="${hole}" data-strokes="${e.strokes == null ? "" : e.strokes}" data-pu="${e.picked_up ? 1 : 0}">Agree ${scoreText(e)}</button>`).join("") : `<span class="small muted">The phones that entered it need to agree.</span>`}
        ${sc.escalated ? `<span class="small muted">Committee asked</span>` : `<button data-action="ask-committee" data-player="${p.id}" data-hole="${hole}">Ask the committee</button>`}
      </div>
    </div>`;
  }

  // ---------- submitting cards ----------

  function cardStatus(r, p) {
    const sum = S.summarise(r.holes, p.scores, p.ph);
    const disputes = disputesFor(r, [p]).length;
    const missing = r.holes.length - sum.thru;
    if (r.submitted.has(p.id)) return { key: "submitted", text: "Submitted", ok: false, sum };
    if (disputes) return { key: "disputed", text: `${disputes} disputed hole${disputes > 1 ? "s" : ""}`, ok: false, sum };
    if (missing) return { key: "missing", text: `${missing} hole${missing > 1 ? "s" : ""} to go`, ok: false, sum };
    return { key: "ready", text: "Ready to submit", ok: true, sum };
  }

  function submitSheet(r) {
    const players = selectedPlayers(r);
    const rows = players.map(p => ({ p, st: cardStatus(r, p) }));
    const ready = rows.filter(x => x.st.ok);
    openSheet(`
      <h2>Submit cards</h2>
      <p class="small muted">Check each card, then submit it. A card with a disputed hole can't go in until it's agreed — or the committee settles it.</p>
      <div class="card">${rows.map(({ p, st }) => `
        <div class="row submit-row">
          <div><strong>${esc(p.name)}</strong><div class="thru">${st.sum.points} pts · ${st.key === "submitted" ? '<span class="tick">✓ Submitted</span>' : st.key === "disputed" ? `<span style="color:var(--bad)">⚠ ${esc(st.text)}</span>` : esc(st.text)}</div></div>
          <span class="spacer"></span>
          <button class="btn ghost" style="min-height:36px" data-action="open-card" data-player="${p.id}">Card</button>
          ${st.ok ? `<button class="btn" style="min-height:36px" data-action="submit-card" data-player="${p.id}">Submit</button>` : ""}
        </div>`).join("")}</div>
      ${ready.length > 1 ? `<button class="btn gold block" data-action="submit-all">Submit all ${ready.length} ready cards</button>` : ""}`);
  }

  async function submitCards(r, ids) {
    for (const id of ids) {
      const { error } = await client.rpc("submit_card", { p_event: r.id, p_player: id });
      if (error) { toast(error.message, true); await reloadRound(true); return; }
    }
    toast(ids.length > 1 ? `${ids.length} cards submitted` : "Card submitted");
    await reloadRound(true);
    if (!$("#sheet").hidden) submitSheet(app.round);
  }

  function customGroupSheet(r) {
    const chosen = new Set(store.get("custom-" + r.id, []));
    openSheet(`
      <h2>Who are you scoring?</h2>
      <p class="small muted">Tick up to four.</p>
      <div class="stack" id="custom-list">
        ${r.players.map(p => `<label class="check-chip" style="display:flex;border-radius:10px;">
          <input type="checkbox" value="${p.id}" ${chosen.has(p.id) ? "checked" : ""}> ${esc(p.name)}
          <span class="spacer"></span><span class="muted small">${p.group ? "Grp " + p.group : ""}</span></label>`).join("")}
      </div>
      <button class="btn block" style="margin-top:14px" data-action="save-custom">Score these players</button>`);
  }

  function scorecardSheet(r, playerId, editing) {
    const p = r.players.find(x => x.id === playerId);
    if (!p) return;
    const sum = S.summarise(r.holes, p.scores, p.ph);
    const st = cardStatus(r, p);
    const canEdit = editing && app.committee;
    const half = (from, to, label) => {
      const hs = r.holes.slice(from, to);
      const cell = (h, f) => `<td>${f(h)}</td>`;
      const parT = hs.reduce((t, h) => t + h.par, 0);
      const grossT = hs.reduce((t, h) => { const x = sum.holes[h.hole]; return x && x.played && !x.picked_up ? t + x.strokes : t; }, 0);
      const ptsT = hs.reduce((t, h) => { const x = sum.holes[h.hole]; return x && x.played ? t + x.points : t; }, 0);
      const scoreCell = x => {
        const s = sum.holes[x.hole];
        const sc = p.scores[x.hole] || {};
        if (canEdit) {
          // A disputed hole starts empty, showing what the phones said, so
          // the committee picks a number rather than waving one through.
          if (sc.disputed) {
            const said = [...new Set(entriesFor(r, p.id, x.hole).map(scoreText))].join("/");
            return `<input class="sc-edit disputed" data-hole="${x.hole}" data-was="" data-disputed="1" value="" placeholder="${esc(said)}" inputmode="numeric" maxlength="2" aria-label="Hole ${x.hole}, disputed: ${esc(said)}">`;
          }
          const v = !s.played ? "" : s.picked_up ? "P" : s.strokes;
          return `<input class="sc-edit" data-hole="${x.hole}" data-was="${v}" value="${v}" inputmode="numeric" maxlength="2" aria-label="Hole ${x.hole}">`;
        }
        const txt = !s.played ? "" : s.picked_up ? "P" : `<span class="${parClass(s.strokes - x.par)}">${s.strokes}</span>`;
        return sc.disputed ? `<span class="sc-disputed" title="Disputed">${txt}⚠</span>` : txt;
      };
      return `
        <tr><th>Hole</th>${hs.map(h => `<th style="text-align:center">${h.hole}</th>`).join("")}<th class="tot">${label}</th></tr>
        <tr><th>Par</th>${hs.map(h => cell(h, x => x.par)).join("")}<td class="tot">${parT}</td></tr>
        <tr><th>SI</th>${hs.map(h => cell(h, x => x.stroke_index)).join("")}<td class="tot"></td></tr>
        <tr><th>Shots</th>${hs.map(h => cell(h, x => sum.holes[x.hole].shots || "")).join("")}<td class="tot"></td></tr>
        <tr><th>Score</th>${hs.map(h => cell(h, scoreCell)).join("")}<td class="tot">${grossT || ""}</td></tr>
        <tr><th>Pts</th>${hs.map(h => cell(h, x => { const s = sum.holes[x.hole]; return s.played ? s.points : ""; })).join("")}<td class="tot">${ptsT}</td></tr>`;
    };
    const live = r.setup && r.setup.status === "live";
    const actions = [];
    if (canEdit) {
      actions.push(`<p class="small muted">Type a score, <b>P</b> for a pick-up, or leave it blank to clear the hole. Saving settles any dispute on the holes you change.</p>
        <button class="btn gold block" data-action="save-card-edits" data-player="${p.id}">Save changes</button>
        <button class="btn ghost block" style="margin-top:8px" data-action="open-card" data-player="${p.id}">Cancel</button>`);
    } else {
      if (st.ok && live && canScore(r)) actions.push(`<button class="btn gold block" data-action="submit-card" data-player="${p.id}">Submit ${esc(p.name.split(" ")[0])}'s card</button>`);
      if (st.key === "disputed") actions.push(`<p class="status-msg err small">⚠ ${esc(st.text)} — agree ${st.text.startsWith("1 ") ? "it" : "them"} on the Score screen, or ask the committee, before this card can be submitted.</p>`);
      if (app.committee) {
        actions.push(`<button class="btn ghost block" style="margin-top:8px" data-action="edit-card" data-player="${p.id}">Change scores (committee)</button>`);
        if (r.submitted.has(p.id)) actions.push(`<button class="btn ghost block" style="margin-top:8px" data-action="reopen-card" data-player="${p.id}">Reopen card</button>`);
      }
    }
    openSheet(`
      <h2>${esc(p.name)}</h2>
      <p class="small muted">Index ${p.index == null ? "?" : p.index} · plays off ${p.ph == null ? "?" : p.ph} · thru ${sum.thru}${r.submitted.has(p.id) ? ' · <span class="tick">✓ submitted</span>' : ""}${partnersOf(r, p).map(x => `<br>Pair ${x.number}${x.others.length ? " with " + x.others.map(o => esc(o.name)).join(" & ") : ""}`).join("")}</p>
      <div class="row" style="gap:18px;margin-bottom:12px;">
        <div><div class="big">${sum.points}</div><div class="thru">Points</div></div>
        <div><div class="big">${sum.gross == null ? (sum.pickups ? "NR" : "–") : sum.gross}</div><div class="thru">Gross</div></div>
        <div><div class="big ${parClass(sum.netToPar)}">${toPar(sum.netToPar)}</div><div class="thru">Net to par</div></div>
      </div>
      <div class="card sc-wrap"><table class="sc">${half(0, 9, "Out")}</table></div>
      <div class="card sc-wrap"><table class="sc">${half(9, 18, "In")}</table></div>
      ${actions.join("")}`);
  }

  // Committee changes from the scorecard: each changed hole is settled
  // at the new number (or cleared), whatever the phones said.
  async function saveCardEdits(r, playerId) {
    const inputs = [...document.querySelectorAll("#sheet-body .sc-edit")];
    const changes = [];
    for (const el of inputs) {
      const v = el.value.trim().toUpperCase();
      if (v === el.dataset.was.toUpperCase()) continue; // unchanged (a disputed hole left empty stays disputed)
      const hole = Number(el.dataset.hole);
      if (v === "") changes.push({ hole, strokes: null, pu: false });
      else if (v === "P") changes.push({ hole, strokes: null, pu: true });
      else if (/^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 20) changes.push({ hole, strokes: Number(v), pu: false });
      else { toast(`Hole ${hole}: type a number, P, or leave it blank.`, true); el.focus(); return; }
    }
    if (!changes.length) { scorecardSheet(r, playerId); return; }
    for (const c of changes) {
      const { error } = await client.rpc("settle_score", { p_event: r.id, p_player: playerId, p_hole: c.hole, p_strokes: c.strokes, p_picked_up: c.pu });
      if (error) { toast(error.message, true); return; }
    }
    toast(`${changes.length} hole${changes.length > 1 ? "s" : ""} updated`);
    await reloadRound(true);
    scorecardSheet(app.round, playerId);
  }

  // ---------- leaderboards ----------

  function boardView(r) {
    const nr = notReady(r);
    if (nr) return nr;
    const formats = (r.setup.formats || ["stableford"]).filter(f => FORMAT_LABELS[f]);
    if (!formats.length) formats.push("stableford");
    if (!r.board || !formats.includes(r.board)) r.board = formats[0] || "stableford";
    const sub = formats.length > 1 ? `<div class="subtabs">${formats.map(f =>
      `<button data-action="board" data-board="${f}" aria-selected="${r.board === f}">${FORMAT_LABELS[f]}</button>`).join("")}</div>` : "";
    let body = "";
    if (!r.players.length) body = `<div class="card empty">Nobody's on this round yet.</div>`;
    else if (r.board === "medal") body = medalTable(r);
    else if (r.board === "skins") body = skinsTable(r);
    else body = stablefordTable(r);
    return sub + body;
  }

  // ⚠ on a player with a disputed hole, ✓ once their card is in.
  function flags(r, p) {
    const d = disputesFor(r, [p]).length;
    return (d ? ` <span class="flag-disputed" title="${d} disputed hole${d > 1 ? "s" : ""}">⚠</span>` : "") +
      (r.submitted.has(p.id) ? ' <span class="tick" title="Card submitted">✓</span>' : "");
  }

  const posCell = pos => pos == null ? "" : `<span class="medal ${pos <= 3 ? "p" + pos : ""}">${pos}</span>`;
  const thruText = sum => sum.complete ? "F" : sum.thru ? "Thru " + sum.thru : "–";
  const meClass = p => app.round.me && p.id === app.round.me.id ? "me" : "";

  function stablefordTable(r) {
    const rows = S.stablefordBoard(r.holes, r.players);
    return `<div class="card"><table class="board">
      <thead><tr><th></th><th>Player</th><th class="num">Thru</th><th class="num">Pts</th></tr></thead>
      <tbody>${rows.map(x => `
        <tr data-player="${x.player.id}" class="${meClass(x.player)}">
          <td class="pos">${x.sum.thru ? posCell(x.pos) : ""}</td>
          <td><strong>${esc(x.player.name)}</strong>${flags(r, x.player)}<div class="thru">PH ${x.player.ph == null ? "?" : x.player.ph} · Out ${x.sum.front} · In ${x.sum.back}</div></td>
          <td class="num thru">${thruText(x.sum)}</td>
          <td class="num"><span class="big">${x.sum.points}</span></td>
        </tr>`).join("")}</tbody></table>
      <p class="small muted" style="margin:10px 0 0">Ties on a finished card go to countback: last 9, 6, 3, then 1.</p></div>`;
  }

  function medalTable(r) {
    const gross = !!r.gross;
    const rows = S.medalBoard(r.holes, r.players, gross);
    return `
      <div class="subtabs">
        <button data-action="gross" data-gross="0" aria-selected="${!gross}">Net</button>
        <button data-action="gross" data-gross="1" aria-selected="${gross}">Gross</button>
      </div>
      <div class="card"><table class="board">
      <thead><tr><th></th><th>Player</th><th class="num">Thru</th><th class="num">${gross ? "Gross" : "Net"}</th><th class="num">To par</th></tr></thead>
      <tbody>${rows.map(x => `
        <tr data-player="${x.player.id}" class="${meClass(x.player)}">
          <td class="pos">${posCell(x.pos)}</td>
          <td><strong>${esc(x.player.name)}</strong><div class="thru">PH ${x.player.ph == null ? "?" : x.player.ph}</div></td>
          <td class="num thru">${thruText(x.sum)}</td>
          <td class="num">${x.nr ? "NR" : x.sum.thru ? (gross ? x.sum.gross : x.sum.net) : "–"}</td>
          <td class="num"><span class="big ${parClass(x.score)}">${x.nr ? "NR" : x.sum.thru ? toPar(x.score) : "–"}</span></td>
        </tr>`).join("")}</tbody></table>
      <p class="small muted" style="margin:10px 0 0">A pick-up is a no return (NR) in medal.</p></div>`;
  }

  function skinsTable(r) {
    const mode = r.setup.skins_mode || "net";
    const sk = S.skins(r.holes, r.players, mode);
    const tiles = sk.results.map(x => {
      if (x.status === "won") return `<div class="skin won"><b>${x.hole}</b>${esc(x.winner.name.split(" ")[0])}${x.value > 1 ? " ×" + x.value : ""}</div>`;
      if (x.status === "carried") return `<div class="skin carried"><b>${x.hole}</b>Carry ${x.value}</div>`;
      return `<div class="skin"><b>${x.hole}</b>–</div>`;
    }).join("");
    const winners = sk.board.filter(b => b.skins > 0);
    return `
      <div class="card">
        <p class="small muted" style="margin-top:0">${mode === "net" ? "Net" : "Gross"} skins across the whole field. A hole is decided once everyone's scored it; ties carry over.</p>
        <div class="skin-holes">${tiles}</div>
        ${sk.carry ? `<p class="small"><b>${sk.carry}</b> skin${sk.carry > 1 ? "s" : ""} carrying.</p>` : ""}
        ${winners.length ? `<table class="board"><tbody>${winners.map(w => `
          <tr data-player="${w.player.id}" class="${meClass(w.player)}"><td><strong>${esc(w.player.name)}</strong><div class="thru">Holes ${w.holes.join(", ")}</div></td>
          <td class="num"><span class="big">${w.skins}</span></td></tr>`).join("")}</tbody></table>` : `<p class="small muted">No skins won yet.</p>`}
      </div>`;
  }

  function pairsTable(r) {
    const rows = S.pairsBoard(r.holes, r.pairs || []);
    const doubled = r.players.filter(p => (p.pairs || []).length > 1);
    const mine = r.me ? new Set((r.me.pairs || [])) : new Set();
    return `
      <div class="card"><table class="board">
      <thead><tr><th></th><th>Pair</th><th class="num">Thru</th><th class="num">Pts</th></tr></thead>
      <tbody>${rows.map(x => `
        <tr data-pair="${x.pair.number}" class="${mine.has(x.pair.number) ? "me" : ""}">
          <td class="pos">${x.started ? posCell(x.pos) : ""}</td>
          <td><strong>${x.pair.players.map(p => esc(p.name)).join(" & ")}</strong>
            <div class="thru">Pair ${x.pair.number} · ${x.pair.players.map((p, i) => esc(p.name.split(" ")[0]) + " " + x.sums[i].points).join(" + ")}${x.pair.players.length < 2 ? " · needs a partner" : ""}</div></td>
          <td class="num thru">${x.complete ? "F" : x.thru ? "Thru " + x.thru : "–"}</td>
          <td class="num"><span class="big">${x.points}</span></td></tr>`).join("")}</tbody></table>
      <p class="small muted" style="margin:10px 0 0">Both players' Stableford points added together. Ties on finished cards go to countback on the pair's combined last 9, 6, 3, then 1.${doubled.length ? ` ${doubled.map(p => esc(p.name)).join(", ")} ${doubled.length > 1 ? "are" : "is"} in two pairs and count${doubled.length > 1 ? "" : "s"} for both.` : ""}</p></div>`;
  }

  function pairSheet(r, number) {
    const pair = (r.pairs || []).find(x => x.number === number);
    if (!pair) return;
    const sums = pair.players.map(p => S.summarise(r.holes, p.scores, p.ph));
    const half = (from, to, label) => {
      const hs = r.holes.slice(from, to);
      const cell = (h, i) => { const s = sums[i].holes[h.hole]; return `<td>${s && s.played ? s.points : ""}</td>`; };
      const tot = (i) => hs.reduce((t, h) => { const s = sums[i].holes[h.hole]; return s && s.played ? t + s.points : t; }, 0);
      const comb = h => sums.reduce((t, sm) => { const s = sm.holes[h.hole]; return s && s.played ? t + s.points : t; }, 0);
      return `
        <tr><th>Hole</th>${hs.map(h => `<th style="text-align:center">${h.hole}</th>`).join("")}<th class="tot">${label}</th></tr>
        ${pair.players.map((p, i) => `<tr><th>${esc(p.name.split(" ")[0])}</th>${hs.map(h => cell(h, i)).join("")}<td class="tot">${tot(i)}</td></tr>`).join("")}
        <tr><th>Pair</th>${hs.map(h => `<td><b>${comb(h) || ""}</b></td>`).join("")}<td class="tot">${pair.players.reduce((t, _, i) => t + tot(i), 0)}</td></tr>`;
    };
    openSheet(`
      <h2>Pair ${pair.number}</h2>
      <p class="small muted">${pair.players.map((p, i) => `${esc(p.name)} (PH ${p.ph == null ? "?" : p.ph}) ${sums[i].points} pts thru ${sums[i].thru}`).join("<br>")}</p>
      <div class="big" style="margin-bottom:10px">${sums.reduce((t, s) => t + s.points, 0)} pts</div>
      <div class="card sc-wrap"><table class="sc">${half(0, 9, "Out")}</table></div>
      <div class="card sc-wrap"><table class="sc">${half(9, 18, "In")}</table></div>`);
  }

  // ---------- setup (committee) ----------

  let setupCache = null; // courses + tees for the dropdown

  async function loadCourses() {
    const [{ data: courses }, { data: tees }, { data: holes }] = await Promise.all([
      client.from("courses").select("*").order("name"),
      client.from("course_tees").select("*").order("name"),
      client.from("course_holes").select("tee_id, par"),
    ]);
    const parByTee = new Map();
    const countByTee = new Map();
    (holes || []).forEach(h => {
      parByTee.set(h.tee_id, (parByTee.get(h.tee_id) || 0) + h.par);
      countByTee.set(h.tee_id, (countByTee.get(h.tee_id) || 0) + 1);
    });
    setupCache = {
      courses: courses || [],
      tees: (tees || []).map(t => ({ ...t, par: parByTee.get(t.id) || null, holeCount: countByTee.get(t.id) || 0 })),
    };
    return setupCache;
  }

  // The yellow tee at the course matching the fixture's venue, so the
  // committee rarely has to pick one. "Sherfield Oaks Golf Club" matches
  // a course saved as "Sherfield Oaks", and so on.
  function defaultTee(venue) {
    if (!venue || !setupCache) return null;
    const core = v => String(v || "").toLowerCase().replace(/golf|club|course|complex|country|&|the|\s+/g, " ").replace(/\s+/g, " ").trim();
    const want = core(venue);
    if (!want) return null;
    const course = setupCache.courses.find(c => { const have = core(c.name); return have && (have === want || have.includes(want) || want.includes(have)); });
    if (!course) return null;
    const tees = setupCache.tees.filter(t => t.course_id === course.id && t.holeCount === 18);
    const tee = tees.find(t => t.name.toLowerCase() === DEFAULT_TEE) || (tees.length === 1 ? tees[0] : null);
    return tee ? { ...tee, courseName: course.name } : null;
  }

  function setupView(r) {
    if (!setupCache) { loadCourses().then(() => { if (app.round && app.round.tab === "setup") renderRoundBody(); }); return `<div class="loading">Loading courses…</div>`; }
    const s = r.setup || { handicap_method: "whs", allowance: DEFAULT_ALLOWANCE, formats: ["stableford", "medal", "skins"], skins_mode: "net", status: "setup" };
    const guessed = !s.tee_id ? defaultTee(r.event.venue) : null;
    const chosenTee = s.tee_id || (guessed && guessed.id);
    const teeRow = setupCache.tees.find(t => t.id === chosenTee);
    if (!r.tee && teeRow && (!r.previewTee || r.previewTee.id !== teeRow.id)) { r.previewTee = teeRow; buildPlayers(r); }
    const teeOpts = setupCache.courses.map(c => {
      const ts = setupCache.tees.filter(t => t.course_id === c.id);
      return `<optgroup label="${esc(c.name)}">${ts.map(t =>
        `<option value="${t.id}" ${chosenTee === t.id ? "selected" : ""}>${esc(t.name)}${t.par ? " · par " + t.par : ""}${t.holeCount !== 18 ? " (incomplete)" : ""}</option>`).join("")}</optgroup>`;
    }).join("");
    const fmts = new Set(s.formats || []);

    const editing = !!r.editHcp && app.committee;
    const hcpRows = r.players.map(p => {
      const h = r.hcps.get(p.id) || {};
      const who = `<td>${esc(p.name)}${p.guest ? ' <span class="muted small">guest</span>' : ""}<div class="thru">${p.group ? "Group " + p.group : "No group"}${(p.pairs || []).length ? " · Pair " + p.pairs.join(" & ") : ""}</div></td>`;
      if (!editing) {
        return `<tr>${who}
          <td>${p.index == null ? "?" : p.index}</td>
          <td class="muted">${p.ch == null ? "–" : p.ch}</td>
          <td class="ph">${p.ph == null ? "?" : p.ph}${p.overridden ? '<div class="thru">set by hand</div>' : ""}</td></tr>`;
      }
      return `<tr>${who}
        <td><input type="number" step="0.1" inputmode="decimal" data-hcp="index" data-player="${p.id}" value="${h.handicap_index != null ? h.handicap_index : (p.index != null ? p.index : "")}" aria-label="Index for ${esc(p.name)}"></td>
        <td><input type="number" step="1" inputmode="numeric" data-hcp="override" data-player="${p.id}" value="${h.playing_handicap != null ? h.playing_handicap : ""}" placeholder="auto" aria-label="Playing handicap override for ${esc(p.name)}"></td>
        <td class="ph">${p.ph == null ? "?" : p.ph}</td>
      </tr>`;
    }).join("");


    const missingPh = r.players.filter(p => p.ph == null).length;
    const statusBtns = s.status === "setup" || !r.setup
      ? `<button class="btn gold block" data-action="go-live">Start the round — open scoring</button>`
      : s.status === "live"
        ? `<button class="btn block" data-action="finalise">Finish round & copy points to Results</button>
           <button class="btn ghost block" data-action="set-status" data-status="setup" style="margin-top:8px">Pause scoring</button>`
        : `<button class="btn ghost block" data-action="set-status" data-status="live">Reopen scoring</button>
           <button class="btn ghost block" data-action="finalise" style="margin-top:8px">Copy points to Results again</button>`;

    return `
      <form id="setup-form" class="card">
        <h2>Course & format</h2>
        <label class="field">Course and tee
          <select name="tee_id" required>
            <option value="">Choose…</option>${teeOpts}
          </select>
        </label>
        ${guessed ? `<p class="status-msg ok small" style="margin:-4px 0 10px">Picked ${esc(guessed.courseName)} ${esc(guessed.name)} tees from the fixture — save to confirm.</p>` : ""}
        ${!chosenTee ? `<p class="status-msg err small" style="margin:-4px 0 10px">No course loaded for ${esc(r.event.venue || "this venue")} yet — <a href="#/courses">add it under Courses</a>.</p>` : ""}
        ${teeRow && (!teeRow.slope || teeRow.course_rating == null) ? `<p class="status-msg err small" style="margin:-4px 0 10px">This tee has no ${!teeRow.slope && teeRow.course_rating == null ? "slope or course rating" : !teeRow.slope ? "slope" : "course rating"} yet, so handicaps won't adjust for the course. <a href="#/course/${teeRow.id}">Add it from the card</a>.</p>` : ""}
        <p class="small" style="margin:-4px 0 12px"><a href="#/courses">Add or correct a course</a></p>
        <label class="field">Handicaps
          <select name="handicap_method">
            <option value="whs" ${s.handicap_method === "whs" ? "selected" : ""}>Full WHS — index, slope and course rating</option>
            <option value="profile" ${s.handicap_method === "profile" ? "selected" : ""}>Handicap on file, no slope</option>
            <option value="manual" ${s.handicap_method === "manual" ? "selected" : ""}>Committee sets each one</option>
          </select>
        </label>
        <label class="field">Allowance %
          <input type="number" name="allowance" min="0" max="100" step="1" value="${s.allowance}">
        </label>
        <div class="field" style="margin-bottom:12px">Individual formats
          <div class="checks" style="margin-top:6px">
            ${Object.entries(FORMAT_LABELS).map(([k, l]) => `<label class="check-chip"><input type="checkbox" name="formats" value="${k}" ${fmts.has(k) ? "checked" : ""}> ${l}</label>`).join("")}
          </div>
        </div>
        <label class="field">Skins
          <select name="skins_mode">
            <option value="net" ${s.skins_mode === "net" ? "selected" : ""}>Net</option>
            <option value="gross" ${s.skins_mode === "gross" ? "selected" : ""}>Gross</option>
          </select>
        </label>
        <button class="btn block" type="submit">Save setup</button>
        <div id="setup-status" class="status-msg" hidden></div>
      </form>

      <div class="card">
        <h2>Round status</h2>
        <p class="small muted">${r.setup ? `Currently <b>${esc(s.status)}</b>.` : "Not set up yet."} While live, anyone on the round can score.</p>
        ${missingPh ? `<p class="status-msg err">${missingPh} player${missingPh > 1 ? "s have" : " has"} no playing handicap yet.</p>` : ""}
        ${statusBtns}
      </div>

      ${checkinsSetupCard(r)}
      ${r.setup && r.setup.status !== "setup" ? disputesCard(r) + cardsCard(r) : ""}

      <div class="card">
        <h2>Pairs</h2>
        ${pairsSetupSummary(r)}
      </div>

      <div class="card">
        <div class="row"><h2 style="margin:0">Playing handicaps</h2><span class="spacer"></span>
          ${app.committee ? `<button class="btn ghost" style="min-height:36px" data-action="toggle-hcp-edit">${editing ? "Done" : "Adjust"}</button>` : ""}</div>
        <p class="small muted">Worked out automatically for ${teeRow ? esc(teeRow.name) + " tees" : "the chosen tee"}: index × slope ÷ 113 + (course rating − par), then ${esc(String(s.allowance))}%. Indexes come from the player list on the <a href="../admin.html">admin page</a>; only the committee can change them.
          ${editing ? "Change an index for this round, or type a playing handicap to set it by hand — clear it to go back to automatic." : ""}</p>
        ${r.unlinked.length ? `<div class="status-msg err">${r.unlinked.length} member${r.unlinked.length > 1 ? "s aren't" : " isn't"} on the player list yet, so can't be scored:
          ${r.unlinked.map(u => `<div class="row" style="margin-top:6px"><span>${esc(u.name)}</span><span class="spacer"></span>
          <button class="btn ghost" style="min-height:34px" data-action="link-player" data-profile="${u.profile_id}">Add</button></div>`).join("")}</div>` : ""}
        <table class="hcp-table">
          <thead><tr><th>Player</th><th>Index</th><th>${editing ? "Set PH" : "Course"}</th><th>Plays off</th></tr></thead>
          <tbody>${hcpRows || `<tr><td colspan="4" class="muted">Nobody registered yet.</td></tr>`}</tbody>
        </table>
      </div>`;
  }

  // Every disputed hole in the round, the ones a group has asked about
  // first. The committee picks the score; that settles it.
  function disputesCard(r) {
    const ds = disputesFor(r, r.players).sort((a, b) => (b.sc.escalated - a.sc.escalated) || a.hole - b.hole);
    if (!ds.length) return `<div class="card"><h2>Disputes</h2><p class="small muted" style="margin:0">None — every score in the round is agreed.</p></div>`;
    return `<div class="card" id="disputes">
      <h2>Disputes <span class="badge live" style="animation:none">${ds.length}</span></h2>
      <p class="small muted">Different phones put in different numbers. Pick the right score to settle it — or tap the player's card to type a different one.</p>
      ${ds.map(d => {
        const options = [];
        d.entries.forEach(e => { if (!options.some(o => sameScore(o, e))) options.push(e); });
        return `<div class="settle-row">
          <div><strong>${esc(d.player.name)} · hole ${d.hole}</strong>${d.sc.escalated ? ' <span class="badge">Group asked</span>' : ""}
            <div class="thru">${d.entries.map(e => `${esc(entrant(r, e.entered_by))} put ${scoreText(e)}`).join(" · ")}</div></div>
          <div class="mini-actions">
            ${options.map(e => `<button data-action="settle" data-player="${d.player.id}" data-hole="${d.hole}" data-strokes="${e.strokes == null ? "" : e.strokes}" data-pu="${e.picked_up ? 1 : 0}">Settle at ${scoreText(e)}</button>`).join("")}
            <button data-action="open-card" data-player="${d.player.id}">Card</button>
          </div>
        </div>`;
      }).join("")}
    </div>`;
  }

  function cardsCard(r) {
    const scored = r.players.filter(p => Object.keys(p.scores || {}).length);
    const done = r.players.filter(p => r.submitted.has(p.id));
    const waiting = scored.filter(p => !r.submitted.has(p.id));
    return `<div class="card">
      <h2>Cards</h2>
      <p class="small" style="margin:0"><b>${done.length} of ${r.players.length}</b> submitted.</p>
      ${waiting.length ? `<p class="small muted" style="margin:6px 0 0">Not in yet: ${waiting.map(p => `<a href="#" data-action="open-card" data-player="${p.id}">${esc(p.name)}</a> (${esc(cardStatus(r, p).text.toLowerCase())})`).join(", ")}.</p>` : ""}
    </div>`;
  }

  function pairsSetupSummary(r) {
    const pairs = r.pairs || [];
    if (!pairs.length) {
      return `<p class="small muted" style="margin:0">No pairs draw for this round. Set one under <b>Pairs draw</b> on the <a href="../admin.html">admin page</a> and the Pairs leaderboard appears here by itself.</p>`;
    }
    const short = pairs.filter(x => x.players.length < 2);
    const crowded = pairs.filter(x => x.players.length > 2);
    const unpaired = r.players.filter(p => !(p.pairs || []).length);
    const doubled = r.players.filter(p => (p.pairs || []).length > 1);
    const notes = [];
    if (doubled.length) notes.push(`${doubled.map(p => esc(p.name)).join(", ")} ${doubled.length > 1 ? "are" : "is"} in two pairs and count${doubled.length > 1 ? "" : "s"} for both.`);
    if (short.length) notes.push(`<span style="color:var(--bad)">Pair ${short.map(x => x.number).join(", ")} only ${short.length > 1 ? "have" : "has"} one player.</span>`);
    if (crowded.length) notes.push(`<span style="color:var(--bad)">Pair ${crowded.map(x => x.number).join(", ")} ${crowded.length > 1 ? "have" : "has"} more than two players.</span>`);
    if (unpaired.length) notes.push(`Not in a pair: ${unpaired.map(p => esc(p.name)).join(", ")}.`);
    return `<p class="small" style="margin:0">${pairs.length} pair${pairs.length > 1 ? "s" : ""} from the draw on the <a href="../admin.html">admin page</a>, scored as both players' points added together.</p>
      ${notes.length ? `<p class="small muted" style="margin:8px 0 0">${notes.join("<br>")}</p>` : ""}`;
  }

  // Saves the setup form. Returns true when it saved.
  async function saveSetup(r, form) {
      const f = new FormData(form);
      const st = $("#setup-status");
      const row = {
        event_id: r.id,
        tee_id: f.get("tee_id") || null,
        handicap_method: f.get("handicap_method"),
        allowance: f.get("allowance") === "" ? DEFAULT_ALLOWANCE : Number(f.get("allowance")),
        formats: f.getAll("formats"),
        skins_mode: f.get("skins_mode"),
        updated_at: new Date().toISOString(),
      };
      if (!row.formats.length) row.formats = ["stableford"];
      if (!r.setup) row.status = "setup";
      if (!row.tee_id) { st.hidden = false; st.className = "status-msg err"; st.textContent = "Choose a course and tee first."; return false; }
      const tee = setupCache.tees.find(t => t.id === row.tee_id);
      if (tee && tee.holeCount !== 18) { st.hidden = false; st.className = "status-msg err"; st.textContent = "That tee doesn't have all 18 holes yet — finish it under Courses."; return false; }
      st.hidden = false; st.className = "status-msg"; st.textContent = "Saving…";
      const { error } = await client.from("event_scoring").upsert(row, { onConflict: "event_id" });
      if (error) { st.className = "status-msg err"; st.textContent = error.message; return false; }
      return true;
  }

  function wireSetup(r) {
    const form = $("#setup-form");
    if (!form) return;
    form.addEventListener("submit", async e => {
      e.preventDefault();
      if (await saveSetup(r, form)) { toast("Setup saved"); await reloadRound(); }
    });

    view.querySelectorAll("[data-hcp]").forEach(input => {
      input.addEventListener("change", async () => {
        const pid = input.dataset.player;
        const existing = r.hcps.get(pid) || {};
        const p = r.players.find(x => x.id === pid);
        const row = {
          event_id: r.id, player_id: pid,
          handicap_index: existing.handicap_index != null ? existing.handicap_index : (p ? p.index : null),
          playing_handicap: existing.playing_handicap != null ? existing.playing_handicap : null,
        };
        const v = input.value.trim();
        if (input.dataset.hcp === "index") row.handicap_index = v === "" ? null : Number(v);
        else row.playing_handicap = v === "" ? null : Math.round(Number(v));
        const { error } = await client.from("event_handicaps").upsert(row, { onConflict: "event_id,player_id" });
        if (error) { toast(error.message, true); return; }
        r.hcps.set(pid, row);
        buildPlayers(r);
        const cell = input.closest("tr").querySelector(".ph");
        const np = r.players.find(x => x.id === pid);
        if (cell && np) cell.textContent = np.ph == null ? "?" : np.ph;
      });
    });
  }

  async function goLive(r) {
    // Starting the round saves whatever's on the setup form first.
    const form = $("#setup-form");
    if (form) {
      if (!(await saveSetup(r, form))) return;
      await reloadRound();
      r = app.round;
    }
    if (!r.setup || !r.tee) { toast("Choose a course and tee first.", true); return; }
    // Snapshot everyone's index so a profile edit mid-round can't move scores.
    const rows = r.players.filter(p => !r.hcps.has(p.id)).map(p => ({
      event_id: r.id, player_id: p.id, handicap_index: p.index, playing_handicap: null,
    }));
    if (rows.length) {
      const { error } = await client.from("event_handicaps").insert(rows);
      if (error) { toast(error.message, true); return; }
    }
    await setStatus(r, "live");
  }

  async function setStatus(r, status) {
    const { error } = await client.from("event_scoring").update({ status, updated_at: new Date().toISOString() }).eq("event_id", r.id);
    if (error) { toast(error.message, true); return; }
    toast(status === "live" ? "Round is live — scoring open" : status === "final" ? "Round finished" : "Scoring paused");
    await reloadRound();
  }

  // The outright pairs winner, written the way the admin page writes it
  // ("Name & Name"). A tie that countback can't split is left to the committee.
  function pairWinner(r) {
    const rows = S.pairsBoard(r.holes, r.pairs || []).filter(x => x.started && x.pair.players.length > 1);
    if (!rows.length) return {};
    const top = rows.filter(x => x.pos === 1);
    if (top.length > 1) return { tied: top.map(x => x.pair.players.map(p => p.name).join(" & ")).join(" v ") };
    return { name: top[0].pair.players.map(p => p.name).join(" & "), points: top[0].points };
  }

  async function finalise(r) {
    const scored = r.players.map(p => ({ p, sum: S.summarise(r.holes, p.scores, p.ph) })).filter(x => x.sum.thru > 0);
    if (!scored.length) { toast("No scores to copy yet.", true); return; }
    const disputed = disputesFor(r, r.players).length;
    if (disputed) {
      toast(`Settle the ${disputed} disputed score${disputed > 1 ? "s" : ""} first — they're listed under Disputes.`, true);
      const d = $("#disputes"); if (d) d.scrollIntoView({ behavior: "smooth" });
      return;
    }
    const incomplete = scored.filter(x => !x.sum.complete).length;
    const unsubmitted = scored.filter(x => !r.submitted.has(x.p.id)).length;
    const pw = pairWinner(r);
    const msg = `Copy Stableford points for ${scored.length} player${scored.length > 1 ? "s" : ""} into Results for ${r.event.name}?` +
      (incomplete ? `\n\n${incomplete} card${incomplete > 1 ? "s aren't" : " isn't"} finished — they'll go in with the points so far.` : "") +
      (unsubmitted ? `\n\n${unsubmitted} card${unsubmitted > 1 ? "s haven't" : " hasn't"} been submitted by the group.` : "") +
      (pw.name ? `\n\nWinning pair: ${pw.name} (${pw.points} pts).` : pw.tied ? `\n\nThe pairs are tied after countback (${pw.tied}), so the winning pair is left for you to fill in on the admin page.` : "") +
      `\n\nThis replaces any results already entered for these players on this round.`;
    if (!confirm(msg)) return;
    const rows = scored.map(({ p, sum }) => ({
      event_id: r.id, player_id: p.id, handicap: p.ph, gross_score: sum.gross, points: sum.points,
    }));
    const { error } = await client.from("results").upsert(rows, { onConflict: "event_id,player_id" });
    if (error) { toast(error.message, true); return; }
    await client.from("events").update({ results_entered: true }).eq("id", r.id);
    if (pw.name) {
      // Only the winning pair is written: every other prize on the round stays as the committee left it.
      const pz = await client.from("event_prizes").upsert(
        { event_id: r.id, winning_pair: pw.name, updated_at: new Date().toISOString() }, { onConflict: "event_id" });
      if (pz.error) toast("Results saved, but the winning pair didn't: " + pz.error.message, true);
    }
    if (r.setup.status !== "final") await setStatus(r, "final");
    else toast("Results updated");
  }

  // ---------- courses (committee) ----------

  async function renderCourses() {
    if (!app.committee) { view.innerHTML = `<div class="card empty">Courses are managed by the committee.</div>`; return; }
    view.innerHTML = `<div class="loading">Loading courses…</div>`;
    const { courses, tees } = await loadCourses();
    const { data: geoRows } = await client.from("course_hole_geo").select("course_id, tee_lat, green_lat");
    courses.forEach(c => { c.mapped = (geoRows || []).filter(g => g.course_id === c.id && g.tee_lat != null && g.green_lat != null).length; });
    view.innerHTML = `
      <h1>Courses</h1>
      ${courses.map(c => `
        <div class="card">
          <h2>${esc(c.name)}</h2>
          ${c.address ? `<p class="small muted" style="margin-top:-6px">${esc(c.address)}</p>` : ""}
          <div class="stack">
            ${tees.filter(t => t.course_id === c.id).map(t => `
              <a class="row" href="#/course/${t.id}" style="text-decoration:none;color:inherit;padding:8px 0;border-top:1px solid var(--line)">
                <span style="width:16px;height:16px;border-radius:50%;border:1px solid var(--line);background:${esc(t.colour || "#ccc")}"></span>
                <strong>${esc(t.name)}</strong>
                <span class="muted small">${t.par ? "Par " + t.par : ""}${t.course_rating ? " · CR " + t.course_rating : ""}${t.slope ? " · Slope " + t.slope : ""}</span>
                <span class="spacer"></span>${t.holeCount !== 18 ? `<span class="badge">${t.holeCount}/18</span>` : "›"}
              </a>`).join("")}
          </div>
          <button class="btn ghost block" style="margin-top:10px" data-action="new-tee" data-course="${c.id}">Add a tee</button>
          <a class="btn ghost block" style="margin-top:8px" href="#/course-map/${c.id}">Map the holes${c.mapped ? ` (${c.mapped}/18 done)` : ""}</a>
        </div>`).join("")}
      <form id="new-course" class="card">
        <h2>Add a course</h2>
        <label class="field">Name<input name="name" required placeholder="e.g. Hurtmore Golf Club"></label>
        <label class="field">Address<input name="address"></label>
        <button class="btn block" type="submit">Add course</button>
      </form>`;
    $("#new-course").addEventListener("submit", async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const { error } = await client.from("courses").insert({ name: f.get("name").trim(), address: f.get("address").trim() || null });
      if (error) { toast(error.message, true); return; }
      toast("Course added");
      renderCourses();
    });
  }

  // ---------- mapping the holes (committee) ----------

  async function renderCourseMap(courseId) {
    if (!app.committee) { view.innerHTML = `<div class="card empty">Courses are managed by the committee.</div>`; return; }
    view.innerHTML = `<div class="loading">Loading…</div>`;
    const [{ data: course }, { data: rows }, { data: tees }] = await Promise.all([
      client.from("courses").select("*").eq("id", courseId).maybeSingle(),
      client.from("course_hole_geo").select("*").eq("course_id", courseId),
      client.from("course_tees").select("id, name").eq("course_id", courseId),
    ]);
    if (!course) { view.innerHTML = `<div class="card status-msg err">Couldn't find that course.</div>`; return; }
    const yellow = (tees || []).find(t => t.name.toLowerCase() === DEFAULT_TEE) || (tees || [])[0];
    const { data: holes } = yellow ? await client.from("course_holes").select("hole, par, yards").eq("tee_id", yellow.id) : { data: [] };
    const card = new Map((holes || []).map(h => [h.hole, h]));
    const geo = new Map((rows || []).map(g => [g.hole, g]));
    const done = h => { const g = geo.get(h); return g && g.tee_lat != null && g.green_lat != null; };

    view.innerHTML = `
      <p class="small"><a href="#/courses">← Courses</a></p>
      <h1>${esc(course.name)}</h1>
      <p class="small muted">Tap the map to drop the tee, then the middle of the green. Drag a pin to move it. Every round here uses these.</p>
      <div class="hole-strip" id="pe-holes">${Array.from({ length: 18 }, (_, i) => `<button data-pe-hole="${i + 1}" class="${i === 0 ? "current" : done(i + 1) ? "done" : ""}">${i + 1}</button>`).join("")}</div>
      <div class="row" style="margin-bottom:8px">
        <div class="subtabs" style="margin:0">
          <button data-pe-mode="tee" aria-selected="true">Placing: tee</button>
          <button data-pe-mode="green" aria-selected="false">Placing: green</button>
        </div>
        <span class="spacer"></span>
        <span class="small" id="pe-yds"></span>
      </div>
      <div id="pe-host" class="pe-host"><div class="loading">Loading the satellite view…</div></div>
      <div class="row" style="margin-top:10px;gap:8px">
        <button class="btn ghost" id="pe-import">Import from OpenStreetMap</button>
        <span class="spacer"></span>
        <span class="small muted" id="pe-count">${[...Array(18)].filter((_, i) => done(i + 1)).length}/18 mapped</span>
      </div>
      <div id="pe-status" class="status-msg" hidden></div>`;

    const status = (msg, cls) => { const el = $("#pe-status"); el.hidden = !msg; el.className = "status-msg " + (cls || ""); el.textContent = msg || ""; };
    const refreshStrip = (current) => {
      document.querySelectorAll("[data-pe-hole]").forEach(b => {
        const h = Number(b.dataset.peHole);
        b.className = h === current ? "current" : done(h) ? "done" : "";
      });
      $("#pe-count").textContent = `${[...Array(18)].filter((_, i) => done(i + 1)).length}/18 mapped`;
    };
    const saveTimers = new Map();
    const saveHole = (hole, g) => {
      clearTimeout(saveTimers.get(hole));
      saveTimers.set(hole, setTimeout(async () => {
        const row = { course_id: courseId, hole, tee_lat: g.tee_lat ?? null, tee_lng: g.tee_lng ?? null,
                      green_lat: g.green_lat ?? null, green_lng: g.green_lng ?? null, updated_at: new Date().toISOString() };
        const { error } = await client.from("course_hole_geo").upsert(row, { onConflict: "course_id,hole" });
        if (error) status("Couldn't save hole " + hole + ": " + error.message, "err");
      }, 400));
    };

    let editor;
    try {
      editor = await window.HoleMaps.pinEditor({
        el: $("#pe-host"), course, geo,
        onSaveHole: (hole, g) => { saveHole(hole, g); refreshStrip(hole); },
        onSaveCentre: async (lat, lng) => { await client.from("courses").update({ lat, lng }).eq("id", courseId); course.lat = lat; course.lng = lng; },
        onModeChange: m => document.querySelectorAll("[data-pe-mode]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.peMode === m))),
        onHoleChange: (hole, g, yds) => {
          const c = card.get(hole);
          $("#pe-yds").innerHTML = yds ? `Tee to green <b>${yds}</b> yds${c && c.yards ? ` · card ${c.yards}` : ""}` : c ? `Par ${c.par}${c.yards ? ` · ${c.yards} yds` : ""}` : "";
        },
        onHoleDone: hole => { if (hole < 18) { editor.setHole(hole + 1); refreshStrip(hole + 1); } else status("All 18 holes mapped. Nice work.", "ok"); },
      });
    } catch (e) { $("#pe-host").innerHTML = `<div class="loading">${esc(e.message)}</div>`; return; }

    document.querySelectorAll("[data-pe-hole]").forEach(b => b.addEventListener("click", () => {
      const h = Number(b.dataset.peHole); editor.setHole(h); refreshStrip(h);
    }));
    document.querySelectorAll("[data-pe-mode]").forEach(b => b.addEventListener("click", () => editor.setMode(b.dataset.peMode)));
    $("#pe-import").addEventListener("click", async () => {
      const c = course.lat != null ? { lat: course.lat, lng: course.lng } : editor.centre();
      status("Looking for this course on OpenStreetMap…");
      try {
        const found = await window.HoleMaps.importFromOsm(c.lat, c.lng);
        if (!found.size) { status("This course hasn't been drawn on OpenStreetMap, so the pins need placing by hand.", "err"); return; }
        let added = 0;
        found.forEach((g, hole) => { if (!done(hole)) { geo.set(hole, g); saveHole(hole, g); added++; } });
        editor.refresh(); refreshStrip(1); editor.setHole(1);
        status(`Found ${found.size} hole${found.size > 1 ? "s" : ""} on OpenStreetMap${added < found.size ? ` — kept your ${found.size - added} already placed` : ""}. Check each one: the green pin goes in the middle of the green.`, "ok");
      } catch (e) { status(e.message, "err"); }
    });
  }

  async function newTee(courseId) {
    const name = prompt("Tee name (e.g. White, Yellow, Red)");
    if (!name) return;
    const { data, error } = await client.from("course_tees").insert({ course_id: courseId, name: name.trim() }).select().single();
    if (error) { toast(error.message, true); return; }
    location.hash = "#/course/" + data.id;
  }

  async function renderTeeEditor(teeId) {
    if (!app.committee) { view.innerHTML = `<div class="card empty">Courses are managed by the committee.</div>`; return; }
    view.innerHTML = `<div class="loading">Loading…</div>`;
    const [{ data: tee, error }, { data: holes }] = await Promise.all([
      client.from("course_tees").select("*, courses(name)").eq("id", teeId).maybeSingle(),
      client.from("course_holes").select("*").eq("tee_id", teeId).order("hole"),
    ]);
    if (error || !tee) { view.innerHTML = `<div class="card status-msg err">Couldn't find that tee.</div>`; return; }
    const byHole = new Map((holes || []).map(h => [h.hole, h]));
    const rows = Array.from({ length: 18 }, (_, i) => {
      const h = byHole.get(i + 1) || {};
      return `<tr><td>${i + 1}</td>
        <td><input type="number" inputmode="numeric" name="par-${i + 1}" min="3" max="6" value="${h.par || ""}" required></td>
        <td><input type="number" inputmode="numeric" name="si-${i + 1}" min="1" max="18" value="${h.stroke_index || ""}" required></td>
        <td><input type="number" inputmode="numeric" name="yds-${i + 1}" min="50" max="750" value="${h.yards || ""}"></td></tr>`;
    }).join("");
    view.innerHTML = `
      <p class="small"><a href="#/courses">← Courses</a></p>
      <form id="tee-form" class="card">
        <h1>${esc(tee.courses ? tee.courses.name : "")}</h1>
        <div class="row" style="gap:10px">
          <label class="field" style="flex:2">Tee<input name="name" value="${esc(tee.name)}" required></label>
          <label class="field" style="flex:1">Colour<input name="colour" type="color" value="${esc(tee.colour || "#ffffff")}"></label>
        </div>
        <div class="row" style="gap:10px">
          <label class="field" style="flex:1">Course rating<input name="course_rating" type="number" step="0.1" inputmode="decimal" value="${tee.course_rating || ""}"></label>
          <label class="field" style="flex:1">Slope<input name="slope" type="number" step="1" inputmode="numeric" value="${tee.slope || ""}"></label>
        </div>
        <p class="small muted">Both are on the scorecard or England Golf's course listing. Without them, Full WHS falls back to the plain index.</p>
        <table class="holes-editor">
          <thead><tr><th>Hole</th><th>Par</th><th>SI</th><th>Yards</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="small" id="tee-par" style="margin:10px 0"></p>
        <button class="btn block" type="submit">Save tee</button>
        <div id="tee-status" class="status-msg" hidden></div>
      </form>`;
    const form = $("#tee-form");
    const showPar = () => {
      let out = 0, inn = 0;
      for (let i = 1; i <= 18; i++) { const v = Number(form["par-" + i].value) || 0; if (i <= 9) out += v; else inn += v; }
      $("#tee-par").textContent = `Out ${out} · In ${inn} · Par ${out + inn}`;
    };
    form.addEventListener("input", showPar);
    showPar();
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const st = $("#tee-status");
      const hs = Array.from({ length: 18 }, (_, i) => ({
        tee_id: teeId, hole: i + 1,
        par: Number(form["par-" + (i + 1)].value),
        stroke_index: Number(form["si-" + (i + 1)].value),
        yards: form["yds-" + (i + 1)].value ? Number(form["yds-" + (i + 1)].value) : null,
      }));
      const errs = S.validateCourseHoles(hs);
      st.hidden = false;
      if (errs.length) { st.className = "status-msg err"; st.innerHTML = errs.map(esc).join("<br>"); return; }
      st.className = "status-msg"; st.textContent = "Saving…";
      const f = new FormData(form);
      const t = await client.from("course_tees").update({
        name: f.get("name").trim(), colour: f.get("colour"),
        course_rating: f.get("course_rating") ? Number(f.get("course_rating")) : null,
        slope: f.get("slope") ? Number(f.get("slope")) : null,
      }).eq("id", teeId);
      if (t.error) { st.className = "status-msg err"; st.textContent = t.error.message; return; }
      const h = await client.from("course_holes").upsert(hs, { onConflict: "tee_id,hole" });
      if (h.error) { st.className = "status-msg err"; st.textContent = h.error.message; return; }
      setupCache = null;
      st.className = "status-msg ok"; st.textContent = "Saved.";
    });
  }

  // ---------- event delegation ----------

  document.addEventListener("click", async e => {
    const el = e.target.closest("[data-action]");
    if (!el) {
      const tr = e.target.closest("tr[data-player]");
      if (tr && app.round) { scorecardSheet(app.round, tr.dataset.player); return; }
      const pr = e.target.closest("tr[data-pair]");
      if (pr && app.round) pairSheet(app.round, Number(pr.dataset.pair));
      return;
    }
    const r = app.round;
    const a = el.dataset.action;
    switch (a) {
      case "close-sheet": closeSheet(); break;
      case "hide-tip": store.set("hide-install-tip", true); el.closest(".install-tip").remove(); break;
      case "tab": r.tab = el.dataset.tab; savePrefs(); renderRoundBody(); window.scrollTo(0, 0); break;
      case "board": r.board = el.dataset.board; savePrefs(); renderRoundBody(); break;
      case "gross": r.gross = el.dataset.gross === "1"; renderRoundBody(); break;
      case "group": r.groupKey = el.dataset.key; savePrefs(); renderRoundBody(); break;
      case "custom-group": customGroupSheet(r); break;
      case "save-custom": {
        const ids = [...document.querySelectorAll("#custom-list input:checked")].map(i => i.value).slice(0, 4);
        store.set("custom-" + r.id, ids);
        r.groupKey = "custom"; savePrefs(); closeSheet(); renderRoundBody();
        break;
      }
      case "hole": r.hole = Number(el.dataset.hole); savePrefs(); renderRoundBody(); break;
      case "prev-hole": r.hole = Math.max(1, r.hole - 1); savePrefs(); renderRoundBody(); break;
      case "next-hole":
        if (r.hole === 18) submitSheet(r);
        else { r.hole += 1; savePrefs(); renderRoundBody(); }
        break;
      case "tap-val": {
        const cur = currentStroke(el.dataset.player);
        if (cur == null) setStroke(el.dataset.player, r.holes[r.hole - 1].par);
        break;
      }
      case "plus": { const cur = currentStroke(el.dataset.player); setStroke(el.dataset.player, cur == null ? r.holes[r.hole - 1].par : cur + 1); break; }
      case "minus": { const cur = currentStroke(el.dataset.player); setStroke(el.dataset.player, cur == null ? r.holes[r.hole - 1].par - 1 : cur - 1); break; }
      case "pickup": setStroke(el.dataset.player, "pickup"); break;
      case "clear": setStroke(el.dataset.player, "clear"); break;
      case "go-live": goLive(r); break;
      case "open-card": e.preventDefault(); scorecardSheet(r, el.dataset.player); break;
      case "edit-card": scorecardSheet(r, el.dataset.player, true); break;
      case "save-card-edits": saveCardEdits(r, el.dataset.player); break;
      case "submit-card": submitCards(r, [el.dataset.player]); break;
      case "submit-all": submitCards(r, selectedPlayers(r).filter(p => cardStatus(r, p).ok).map(p => p.id)); break;
      case "reopen-card": {
        const { error } = await client.from("card_submissions").delete().eq("event_id", r.id).eq("player_id", el.dataset.player);
        if (error) toast(error.message, true); else { toast("Card reopened"); await reloadRound(true); scorecardSheet(app.round, el.dataset.player); }
        break;
      }
      case "accept": {
        const { error } = await client.rpc("accept_score", { p_event: r.id, p_player: el.dataset.player, p_hole: Number(el.dataset.hole),
          p_strokes: el.dataset.strokes === "" ? null : Number(el.dataset.strokes), p_picked_up: el.dataset.pu === "1" });
        if (error) toast(error.message, true); else { toast("Agreed"); await reloadRound(true); }
        break;
      }
      case "ask-committee": {
        const { error } = await client.rpc("ask_committee", { p_event: r.id, p_player: el.dataset.player, p_hole: Number(el.dataset.hole) });
        if (error) toast(error.message, true); else { toast("The committee's been told — they'll settle it from the scorecard."); await reloadRound(true); }
        break;
      }
      case "settle": {
        const { error } = await client.rpc("settle_score", { p_event: r.id, p_player: el.dataset.player, p_hole: Number(el.dataset.hole),
          p_strokes: el.dataset.strokes === "" ? null : Number(el.dataset.strokes), p_picked_up: el.dataset.pu === "1" });
        if (error) toast(error.message, true); else { toast("Settled"); await reloadRound(); }
        break;
      }
      case "checkin": setCheckin(r, [el.dataset.player], el.dataset.here === "1"); break;
      case "checkin-all": setCheckin(r, checkinGroup(r).filter(p => !r.checkins.has(p.id)).map(p => p.id), true); break;
      case "show-checkin": r.showCheckin = true; renderRoundBody(); break;
      case "hide-checkin": r.showCheckin = false; renderRoundBody(); break;
      case "toggle-hcp-edit": r.editHcp = !r.editHcp; renderRoundBody(); break;
      case "set-status": setStatus(r, el.dataset.status); break;
      case "finalise": finalise(r); break;
      case "link-player": {
        const { error } = await client.rpc("link_member_player", { p_profile: el.dataset.profile });
        if (error) toast(error.message, true); else { toast("Added to the player list"); reloadRound(); }
        break;
      }
      case "new-tee": newTee(el.dataset.course); break;
      case "gps-on": store.set("gps-on", true); window.HoleMaps.startGps(); renderRoundBody(); break;
      case "hole-map":
        window.HoleMaps.openHoleMap({
          course: r.course, holes: r.holes, geo: r.geo, hole: r.hole,
          onClose: hole => { store.set("gps-on", true); if (app.round) { app.round.hole = hole; savePrefs(); renderRoundBody(); } },
        });
        break;
    }
  });

  $("#menu-btn").addEventListener("click", () => { $("#menu").hidden = !$("#menu").hidden; });
  document.addEventListener("click", e => {
    if (!e.target.closest("#menu") && !e.target.closest("#menu-btn")) $("#menu").hidden = true;
  });
  $("#signout-btn").addEventListener("click", async () => {
    await client.auth.signOut();
    $("#menu").hidden = true;
    app.user = null;
    route();
  });

  // ---------- router ----------

  async function route() {
    closeSheet();
    const hash = location.hash || "#/";
    const parts = hash.slice(2).split("/");
    if (!(parts[0] === "round" && app.round && app.round.id === parts[1])) { unsubscribe(); app.round = null; }
    if (!app.user) return renderSignIn();
    if (!app.approved) return renderNotApproved();
    if (parts[0] === "round" && parts[1]) return renderRound(parts[1], parts[2] === "start");
    if (parts[0] === "courses") return renderCourses();
    if (parts[0] === "course" && parts[1]) return renderTeeEditor(parts[1]);
    if (parts[0] === "course-map" && parts[1]) return renderCourseMap(parts[1]);
    return renderHome();
  }

  window.addEventListener("hashchange", route);

  client.auth.onAuthStateChange((evt) => {
    if (evt === "SIGNED_OUT") { app.user = null; route(); }
  });

  (async function start() {
    updateSyncPill();
    try { await loadUser(); }
    catch (e) { /* offline at launch — fall through to sign in */ }
    route();
    flushQueue();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  })();
})();
