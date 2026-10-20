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

  const QUEUE_KEY = "falkners-score-queue";
  const FORMAT_LABELS = { stableford: "Stableford", medal: "Medal", skins: "Skins", pairs: "Pairs" };

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
  // Every score goes into the queue first, then out to the database.
  // No signal on the 14th? It waits on the phone and goes when it can.

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
      const ups = q.filter(r => !r.clear).map(({ event_id, player_id, hole, strokes, picked_up }) =>
        ({ event_id, player_id, hole, strokes, picked_up }));
      if (ups.length) {
        const { error } = await client.from("hole_scores").upsert(ups, { onConflict: "event_id,player_id,hole" });
        if (error) throw error;
      }
      for (const c of clears) {
        const { error } = await client.from("hole_scores").delete()
          .eq("event_id", c.event_id).eq("player_id", c.player_id).eq("hole", c.hole);
        if (error) throw error;
      }
      // Only drop what we sent — anything added meanwhile stays.
      const sent = new Set(q.map(r => r.event_id + r.player_id + r.hole + (r.ts || "")));
      setQueue(queue().filter(r => !sent.has(r.event_id + r.player_id + r.hole + (r.ts || ""))));
    } catch (err) {
      // A permission error won't fix itself by retrying: say so.
      if (err && (err.code === "42501" || /row-level security/i.test(err.message || ""))) {
        toast("Scores couldn't be saved — the round may not be live, or you're not on it.", true);
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
    const [ev, setup, field, hcps, scores, manage] = await Promise.all([
      client.from("events").select("*").eq("id", eventId).maybeSingle(),
      client.from("event_scoring").select("*").eq("event_id", eventId).maybeSingle(),
      client.rpc("scoring_field", { target: eventId }),
      client.from("event_handicaps").select("*").eq("event_id", eventId),
      client.from("hole_scores").select("player_id, hole, strokes, picked_up, updated_at").eq("event_id", eventId),
      client.rpc("can_manage_round", { target: eventId }),
    ]);
    const err = ev.error || setup.error || field.error || hcps.error || scores.error;
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

    const r = {
      id: eventId,
      event: ev.data,
      setup: setup.data,
      tee, course, holes,
      field: field.data || [],
      hcps: new Map((hcps.data || []).map(h => [h.player_id, h])),
      scores: {},
      canManage: !!manage.data,
    };
    (scores.data || []).forEach(s => applyScore(r, s));
    buildPlayers(r);
    return r;
  }

  function applyScore(r, s) {
    if (!r.scores[s.player_id]) r.scores[s.player_id] = {};
    r.scores[s.player_id][s.hole] = { strokes: s.strokes, picked_up: s.picked_up };
  }

  // Overlay anything still waiting to send, so your own phone always
  // shows what you entered even before it reaches the server.
  function overlayQueue(r) {
    queue().filter(q => q.event_id === r.id).forEach(q => {
      if (q.clear) { if (r.scores[q.player_id]) delete r.scores[q.player_id][q.hole]; }
      else applyScore(r, q);
    });
  }

  function parTotal(r) { return r.holes.reduce((t, h) => t + h.par, 0); }

  function buildPlayers(r) {
    overlayQueue(r);
    const setup = r.setup || {};
    const par = parTotal(r);
    r.players = r.field.filter(f => f.player_id).map(f => {
      const h = r.hcps.get(f.player_id) || {};
      const index = h.handicap_index != null ? Number(h.handicap_index) : (f.handicap != null ? Number(f.handicap) : null);
      const ph = S.playingHandicap({
        method: setup.handicap_method || "whs",
        allowance: setup.allowance != null ? setup.allowance : 95,
        index, override: h.playing_handicap, tee: r.tee, par,
      });
      return {
        id: f.player_id, profileId: f.profile_id, name: f.name, index, ph,
        guest: f.is_guest, group: f.tee_group, pair: f.pair_group,
        scores: r.scores[f.player_id] || {},
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    r.unlinked = r.field.filter(f => !f.player_id);
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
        } else applyScore(app.round, payload.new);
        refreshRound();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "event_scoring", filter: `event_id=eq.${r.id}` }, () => reloadRound())
      .subscribe();
    // Belt and braces: phones drop sockets when the screen locks.
    app.pollTimer = setInterval(() => { if (document.visibilityState === "visible") reloadRound(true); }, 30000);
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
    const keep = { tab: app.round.tab, hole: app.round.hole, board: app.round.board, groupKey: app.round.groupKey, gross: app.round.gross };
    try {
      const r = await loadRound(app.round.id);
      Object.assign(r, keep);
      app.round = r;
      if (!(quiet && keep.tab === "setup")) renderRoundBody();
    } catch (e) { if (!quiet) toast(e.message, true); }
  }

  // ---------- round page ----------

  async function renderRound(eventId) {
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
    const tabs = [["score", "Score"], ["board", "Leaderboard"]];
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
    if (r.tab === "score") body.innerHTML = scoreView(r);
    else if (r.tab === "setup" && r.canManage) { body.innerHTML = setupView(r); wireSetup(r); }
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
    const nr = notReady(r);
    if (nr) return nr;
    if (!canScore(r)) {
      const why = r.setup.status === "final" ? "This round is finished — scores are locked."
        : r.setup.status === "setup" ? "Scoring opens when the committee starts the round."
        : "Only players on this round can enter scores.";
      return `<div class="card empty"><p>${why}</p><button class="btn ghost" data-action="tab" data-tab="board">See the leaderboard</button></div>`;
    }

    const groups = groupsOf(r);
    const picker = `
      <div class="group-picker">
        ${groups.map(([n, ps]) => `<button data-action="group" data-key="g${n}" aria-selected="${r.groupKey === "g" + n}">Group ${n}${ps.some(p => r.me && p.id === r.me.id) ? " ★" : ""}</button>`).join("")}
        <button data-action="custom-group" aria-selected="${r.groupKey === "custom"}">Pick players</button>
      </div>`;

    const players = selectedPlayers(r);
    if (!players.length) {
      return picker + `<div class="card empty"><p>Choose the group you're marking for.</p>
        <p class="small muted">Only one phone per group needs to score — but anyone in the group can.</p></div>`;
    }

    const h = r.holes[r.hole - 1];
    const strip = r.holes.map(x => {
      const done = players.every(p => { const s = p.scores[x.hole]; return s && (s.strokes != null || s.picked_up); });
      return `<button data-action="hole" data-hole="${x.hole}" class="${x.hole === r.hole ? "current" : done ? "done" : ""}">${x.hole}</button>`;
    }).join("");

    const cards = players.map(p => {
      const sc = p.scores[h.hole];
      const shots = S.shotsOnHole(p.ph, h.stroke_index, 18);
      const sum = S.summarise(r.holes, p.scores, p.ph);
      let valClass = "val", valText = "–";
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
            <div class="mini-actions">
              <button data-action="pickup" data-player="${p.id}">Pick up</button>
              ${sc ? `<button data-action="clear" data-player="${p.id}">Clear</button>` : ""}
            </div>
          </div>
          <div class="stepper">
            <button data-action="minus" data-player="${p.id}" aria-label="One fewer for ${esc(p.name)}">−</button>
            <button class="${valClass}" data-action="tap-val" data-player="${p.id}" aria-label="Score for ${esc(p.name)}">${valText}</button>
            <button data-action="plus" data-player="${p.id}" aria-label="One more for ${esc(p.name)}">+</button>
          </div>
        </div>`;
    }).join("");

    return `
      ${picker}
      <div class="hole-strip">${strip}</div>
      <div class="hole-head">
        <div class="num"><small>HOLE</small>${h.hole}</div>
        <div class="facts">
          <div>Par<b>${h.par}</b></div>
          <div>SI<b>${h.stroke_index}</b></div>
          ${h.yards ? `<div>Yds<b>${h.yards}</b></div>` : ""}
        </div>
      </div>
      <div class="card">${cards}</div>
      <div class="hole-nav">
        <button class="btn ghost" data-action="prev-hole" ${r.hole === 1 ? "disabled" : ""}>← Hole ${r.hole - 1 || ""}</button>
        <button class="btn" data-action="next-hole">${r.hole === 18 ? "Card" : "Hole " + (r.hole + 1) + " →"}</button>
      </div>`;
  }

  function setStroke(playerId, next) {
    const r = app.round;
    const h = r.holes[r.hole - 1];
    const row = { event_id: r.id, player_id: playerId, hole: h.hole, ts: Date.now() };
    if (next === "clear") {
      row.clear = true;
      if (r.scores[playerId]) delete r.scores[playerId][h.hole];
    } else if (next === "pickup") {
      row.strokes = null; row.picked_up = true;
      applyScore(r, row);
    } else {
      row.strokes = Math.max(1, Math.min(20, next)); row.picked_up = false;
      applyScore(r, row);
    }
    queueScore(row);
    buildPlayers(r);
    renderRoundBody();
  }

  function currentStroke(playerId) {
    const r = app.round;
    const sc = r.scores[playerId] && r.scores[playerId][r.hole];
    return sc && sc.strokes != null ? sc.strokes : null;
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

  function scorecardSheet(r, playerId) {
    const p = r.players.find(x => x.id === playerId);
    if (!p) return;
    const sum = S.summarise(r.holes, p.scores, p.ph);
    const half = (from, to, label) => {
      const hs = r.holes.slice(from, to);
      const cell = (h, f) => `<td>${f(h)}</td>`;
      const parT = hs.reduce((t, h) => t + h.par, 0);
      const grossT = hs.reduce((t, h) => { const x = sum.holes[h.hole]; return x && x.played && !x.picked_up ? t + x.strokes : t; }, 0);
      const ptsT = hs.reduce((t, h) => { const x = sum.holes[h.hole]; return x && x.played ? t + x.points : t; }, 0);
      return `
        <tr><th>Hole</th>${hs.map(h => `<th style="text-align:center">${h.hole}</th>`).join("")}<th class="tot">${label}</th></tr>
        <tr><th>Par</th>${hs.map(h => cell(h, x => x.par)).join("")}<td class="tot">${parT}</td></tr>
        <tr><th>SI</th>${hs.map(h => cell(h, x => x.stroke_index)).join("")}<td class="tot"></td></tr>
        <tr><th>Shots</th>${hs.map(h => cell(h, x => sum.holes[x.hole].shots || "")).join("")}<td class="tot"></td></tr>
        <tr><th>Score</th>${hs.map(h => cell(h, x => { const s = sum.holes[x.hole]; return !s.played ? "" : s.picked_up ? "P" : `<span class="${parClass(s.strokes - x.par)}">${s.strokes}</span>`; })).join("")}<td class="tot">${grossT || ""}</td></tr>
        <tr><th>Pts</th>${hs.map(h => cell(h, x => { const s = sum.holes[x.hole]; return s.played ? s.points : ""; })).join("")}<td class="tot">${ptsT}</td></tr>`;
    };
    openSheet(`
      <h2>${esc(p.name)}</h2>
      <p class="small muted">Index ${p.index == null ? "?" : p.index} · plays off ${p.ph == null ? "?" : p.ph} · thru ${sum.thru}</p>
      <div class="row" style="gap:18px;margin-bottom:12px;">
        <div><div class="big">${sum.points}</div><div class="thru">Points</div></div>
        <div><div class="big">${sum.gross == null ? (sum.pickups ? "NR" : "–") : sum.gross}</div><div class="thru">Gross</div></div>
        <div><div class="big ${parClass(sum.netToPar)}">${toPar(sum.netToPar)}</div><div class="thru">Net to par</div></div>
      </div>
      <div class="card sc-wrap"><table class="sc">${half(0, 9, "Out")}</table></div>
      <div class="card sc-wrap"><table class="sc">${half(9, 18, "In")}</table></div>`);
  }

  // ---------- leaderboards ----------

  function boardView(r) {
    const nr = notReady(r);
    if (nr) return nr;
    const formats = (r.setup.formats || ["stableford"]).filter(f => FORMAT_LABELS[f]);
    if (formats.includes("pairs") && !r.players.some(p => p.pair != null)) formats.splice(formats.indexOf("pairs"), 1);
    if (!r.board || !formats.includes(r.board)) r.board = formats[0] || "stableford";
    const sub = formats.length > 1 ? `<div class="subtabs">${formats.map(f =>
      `<button data-action="board" data-board="${f}" aria-selected="${r.board === f}">${FORMAT_LABELS[f]}</button>`).join("")}</div>` : "";
    let body = "";
    if (!r.players.length) body = `<div class="card empty">Nobody's on this round yet.</div>`;
    else if (r.board === "medal") body = medalTable(r);
    else if (r.board === "skins") body = skinsTable(r);
    else if (r.board === "pairs") body = pairsTable(r);
    else body = stablefordTable(r);
    return sub + body;
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
          <td><strong>${esc(x.player.name)}</strong><div class="thru">PH ${x.player.ph == null ? "?" : x.player.ph} · Out ${x.sum.front} · In ${x.sum.back}</div></td>
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
    const byPair = new Map();
    r.players.forEach(p => {
      if (p.pair == null) return;
      if (!byPair.has(p.pair)) byPair.set(p.pair, []);
      byPair.get(p.pair).push(p);
    });
    const rows = S.pairsBoard(r.holes, [...byPair.entries()].map(([number, players]) => ({ number, players })));
    const key = r.pairsKey || "combined";
    rows.sort((a, b) => b[key] - a[key] || a.pair.number - b.pair.number);
    return `
      <div class="subtabs">
        <button data-action="pairs-key" data-key="combined" aria-selected="${key === "combined"}">Combined</button>
        <button data-action="pairs-key" data-key="betterBall" aria-selected="${key === "betterBall"}">Better ball</button>
      </div>
      <div class="card"><table class="board">
      <thead><tr><th></th><th>Pair</th><th class="num">Thru</th><th class="num">Pts</th></tr></thead>
      <tbody>${rows.map((x, i) => `
        <tr><td class="pos">${posCell(i + 1)}</td>
          <td><strong>${x.pair.players.map(p => esc(p.name)).join(" & ")}</strong><div class="thru">Pair ${x.pair.number} · ${key === "combined" ? "better ball " + x.betterBall : "combined " + x.combined}</div></td>
          <td class="num thru">${x.thru >= 18 ? "F" : "Thru " + x.thru}</td>
          <td class="num"><span class="big">${x[key]}</span></td></tr>`).join("")}</tbody></table></div>`;
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

  function setupView(r) {
    if (!setupCache) { loadCourses().then(() => { if (app.round && app.round.tab === "setup") renderRoundBody(); }); return `<div class="loading">Loading courses…</div>`; }
    const s = r.setup || { handicap_method: "whs", allowance: 95, formats: ["stableford", "medal", "skins"], skins_mode: "net", status: "setup" };
    const teeOpts = setupCache.courses.map(c => {
      const ts = setupCache.tees.filter(t => t.course_id === c.id);
      return `<optgroup label="${esc(c.name)}">${ts.map(t =>
        `<option value="${t.id}" ${s.tee_id === t.id ? "selected" : ""}>${esc(t.name)}${t.par ? " · par " + t.par : ""}${t.holeCount !== 18 ? " (incomplete)" : ""}</option>`).join("")}</optgroup>`;
    }).join("");
    const fmts = new Set(s.formats || []);

    const hcpRows = r.players.map(p => {
      const h = r.hcps.get(p.id) || {};
      return `<tr>
        <td>${esc(p.name)}${p.guest ? ' <span class="muted small">guest</span>' : ""}<div class="thru">${p.group ? "Group " + p.group : "No group"}${p.pair ? " · Pair " + p.pair : ""}</div></td>
        <td><input type="number" step="0.1" inputmode="decimal" data-hcp="index" data-player="${p.id}" value="${h.handicap_index != null ? h.handicap_index : (p.index != null ? p.index : "")}" aria-label="Index for ${esc(p.name)}"></td>
        <td><input type="number" step="1" inputmode="numeric" data-hcp="override" data-player="${p.id}" value="${h.playing_handicap != null ? h.playing_handicap : ""}" placeholder="–" aria-label="Override for ${esc(p.name)}"></td>
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
        <div class="field" style="margin-bottom:12px">Formats
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

      <div class="card">
        <h2>Playing handicaps</h2>
        <p class="small muted">Index is snapshotted when the round starts. Type an override to fix anyone's playing handicap.</p>
        ${r.unlinked.length ? `<div class="status-msg err">${r.unlinked.length} member${r.unlinked.length > 1 ? "s aren't" : " isn't"} on the player list yet, so can't be scored:
          ${r.unlinked.map(u => `<div class="row" style="margin-top:6px"><span>${esc(u.name)}</span><span class="spacer"></span>
          <button class="btn ghost" style="min-height:34px" data-action="link-player" data-profile="${u.profile_id}">Add</button></div>`).join("")}</div>` : ""}
        <table class="hcp-table">
          <thead><tr><th>Player</th><th>Index</th><th>Override</th><th>PH</th></tr></thead>
          <tbody>${hcpRows || `<tr><td colspan="4" class="muted">Nobody registered yet.</td></tr>`}</tbody>
        </table>
      </div>`;
  }

  function wireSetup(r) {
    const form = $("#setup-form");
    if (!form) return;
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const st = $("#setup-status");
      const f = new FormData(form);
      const row = {
        event_id: r.id,
        tee_id: f.get("tee_id") || null,
        handicap_method: f.get("handicap_method"),
        allowance: Number(f.get("allowance") || 100),
        formats: f.getAll("formats"),
        skins_mode: f.get("skins_mode"),
        updated_at: new Date().toISOString(),
      };
      if (!row.formats.length) row.formats = ["stableford"];
      if (!r.setup) row.status = "setup";
      const tee = setupCache.tees.find(t => t.id === row.tee_id);
      if (tee && tee.holeCount !== 18) { st.hidden = false; st.className = "status-msg err"; st.textContent = "That tee doesn't have all 18 holes yet — finish it under Courses."; return; }
      st.hidden = false; st.className = "status-msg"; st.textContent = "Saving…";
      const { error } = await client.from("event_scoring").upsert(row, { onConflict: "event_id" });
      if (error) { st.className = "status-msg err"; st.textContent = error.message; return; }
      toast("Setup saved");
      await reloadRound();
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
    if (!r.setup || !r.tee) { toast("Save a course and tee first.", true); return; }
    // Snapshot everyone's index so a profile edit mid-round can't move scores.
    const rows = r.players.filter(p => !r.hcps.has(p.id)).map(p => ({
      event_id: r.id, player_id: p.id, handicap_index: p.index, playing_handicap: null,
    }));
    if (rows.length) {
      const { error } = await client.from("event_handicaps").upsert(rows, { onConflict: "event_id,player_id" });
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

  async function finalise(r) {
    const scored = r.players.map(p => ({ p, sum: S.summarise(r.holes, p.scores, p.ph) })).filter(x => x.sum.thru > 0);
    if (!scored.length) { toast("No scores to copy yet.", true); return; }
    const incomplete = scored.filter(x => !x.sum.complete).length;
    const msg = `Copy Stableford points for ${scored.length} player${scored.length > 1 ? "s" : ""} into Results for ${r.event.name}?` +
      (incomplete ? `\n\n${incomplete} card${incomplete > 1 ? "s aren't" : " isn't"} finished — they'll go in with the points so far.` : "") +
      `\n\nThis replaces any results already entered for these players on this round.`;
    if (!confirm(msg)) return;
    const rows = scored.map(({ p, sum }) => ({
      event_id: r.id, player_id: p.id, handicap: p.ph, gross_score: sum.gross, points: sum.points,
    }));
    const { error } = await client.from("results").upsert(rows, { onConflict: "event_id,player_id" });
    if (error) { toast(error.message, true); return; }
    await client.from("events").update({ results_entered: true }).eq("id", r.id);
    if (r.setup.status !== "final") await setStatus(r, "final");
    else toast("Results updated");
  }

  // ---------- courses (committee) ----------

  async function renderCourses() {
    if (!app.committee) { view.innerHTML = `<div class="card empty">Courses are managed by the committee.</div>`; return; }
    view.innerHTML = `<div class="loading">Loading courses…</div>`;
    const { courses, tees } = await loadCourses();
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
      if (tr && app.round) scorecardSheet(app.round, tr.dataset.player);
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
      case "pairs-key": r.pairsKey = el.dataset.key; renderRoundBody(); break;
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
        if (r.hole === 18) { const ps = selectedPlayers(r); if (ps[0]) scorecardSheet(r, ps[0].id); }
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
      case "set-status": setStatus(r, el.dataset.status); break;
      case "finalise": finalise(r); break;
      case "link-player": {
        const { error } = await client.rpc("link_member_player", { p_profile: el.dataset.profile });
        if (error) toast(error.message, true); else { toast("Added to the player list"); reloadRound(); }
        break;
      }
      case "new-tee": newTee(el.dataset.course); break;
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
    if (parts[0] === "round" && parts[1]) return renderRound(parts[1]);
    if (parts[0] === "courses") return renderCourses();
    if (parts[0] === "course" && parts[1]) return renderTeeEditor(parts[1]);
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
