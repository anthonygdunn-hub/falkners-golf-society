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

  // ---------- text size ----------
  const TEXT_SIZES = [["normal", "Normal", "Aa"], ["lg", "Large", "Aa"], ["xl", "Extra large", "Aa"]];
  function applyTextSize(size) {
    document.documentElement.classList.remove("text-lg", "text-xl");
    if (size === "lg" || size === "xl") document.documentElement.classList.add("text-" + size);
  }
  applyTextSize(store.get("text-size", "normal"));
  function textSizeSheet() {
    const cur = store.get("text-size", "normal");
    openSheet(`<h2>Text size</h2><p class="small muted">Makes the writing bigger all through the app, on this phone.</p>
      ${TEXT_SIZES.map(([k, l, a], i) => `<button class="ts-opt${cur === k ? " on" : ""}" data-action="set-text-size" data-size="${k}"><b style="font-size:${[1, 1.25, 1.5][i]}rem">${a}</b><span>${l}</span>${cur === k ? '<span class="spacer"></span><span class="tick">✓</span>' : ""}</button>`).join("")}
      <button class="btn ghost block" style="margin-top:6px" data-action="close-sheet">Done</button>`);
  }

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
    app.guest = null;
    if (!app.user) { app.approved = false; app.committee = false; return; }
    const [appr, comm] = await Promise.all([
      client.rpc("is_approved_member"),
      client.rpc("is_committee"),
    ]);
    app.approved = !!appr.data;
    app.committee = !!comm.data;
    // A friend invited to a member's private game: one game, nothing else.
    if (!app.approved && app.user.is_anonymous) {
      const { data: g } = await client.rpc("my_guest_game");
      app.guest = g && g[0] ? { eventId: g[0].event_id, playerId: g[0].player_id, until: g[0].expires_at } : { ended: true };
      document.body.classList.add("guest-mode");
    } else document.body.classList.remove("guest-mode");
    if (app.approved) loadAvatars().then(() => { if (!app.round) return; refreshRound(); });
    if (app.approved) loadMyBag().catch(() => {});
    $("#menu-btn").hidden = false;
    $("#menu-courses").hidden = !app.approved;
    if ($("#menu-handicaps")) $("#menu-handicaps").hidden = !app.committee;
  }

  function renderSignIn(msg) {
    $("#menu-btn").hidden = true;
    hideTabbar();
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

  // ---------- a friend joining a member's private game ----------
  // The link in their email or message: #/join/<token>. They enter the
  // email the invite went to (if it went by email) and the 6-digit code,
  // and get a guest login for that one game until the end of its day.
  async function renderJoin(token) {
    $("#menu-btn").hidden = true;
    hideTabbar();
    view.innerHTML = `<div class="loading">Opening your invite…</div>`;
    if (app.user && app.approved) {
      view.innerHTML = `<div class="card"><h1>You're a member</h1><p>This invite is for a friend who isn't in the society. You're signed in already, so open the game from your home screen.</p><a class="btn block" href="#/">Go to my games</a></div>`;
      return;
    }
    const { data, error } = await client.rpc("guest_invite_info", { p_token: token });
    const inv = data && data[0];
    if (error || !inv) { view.innerHTML = `<div class="card"><h1>Invite not found</h1><p>That link doesn't match an invite. Ask whoever invited you to send a new one.</p></div>`; return; }
    if (inv.expired) { view.innerHTML = `<div class="card"><h1>This invite has closed</h1><p>It's either past the day of the game, or the code was entered wrongly too many times. Ask ${esc(inv.organiser)} for a new one.</p></div>`; return; }
    view.innerHTML = `
      <div class="join-hero">
        <img src="icons/icon-192.png" alt="" width="64" height="64">
        <div class="join-kicker">The Falkners Arms Golf Society</div>
        <h1>Hi ${esc(String(inv.guest_name).trim().split(/\s+/)[0])}</h1>
        <p>${esc(inv.organiser)} has added you to <b>${esc(inv.game_name)}</b>${inv.venue ? ` at ${esc(inv.venue)}` : ""} on ${fmtDate(inv.event_date, { weekday: "long", day: "numeric", month: "long" })}.</p>
      </div>
      <form id="join-form" class="card">
        ${inv.needs_email ? `<label class="field">Your email<input type="email" name="email" autocomplete="email" required placeholder="The address the invite went to"></label>` : ""}
        <label class="field">Your code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="6 digits" class="code-input"></label>
        <button class="btn gold block" type="submit">Open my scorecard</button>
        <div id="join-status" class="status-msg" hidden></div>
        <p class="small muted" style="margin:12px 0 0">No account needed. This works for this game only, until the end of the day. Your ${inv.needs_email ? "email address is" : "details are"} deleted after the game.</p>
      </form>`;
    $("#join-form").addEventListener("submit", async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const st = $("#join-status");
      const say = (m, bad) => { st.hidden = false; st.className = "status-msg" + (bad ? " err" : ""); st.textContent = m; };
      say("Checking…");
      if (!app.user) {
        const { error: se } = await client.auth.signInAnonymously();
        if (se) { say(/anonymous/i.test(se.message) ? "Guest logins aren't switched on yet — tell the member who invited you." : se.message, true); return; }
      }
      const { data: ev, error: re } = await client.rpc("redeem_guest_invite", { p_token: token, p_code: String(f.get("code") || "").trim(), p_email: String(f.get("email") || "") });
      if (re) { say(re.message, true); return; }
      if (!ev) { say(inv.needs_email ? "That code or email doesn't match the invite. Check them and try again." : "That code doesn't match. Check it and try again.", true); return; }
      await loadUser();
      location.hash = "#/round/" + ev;
    });
  }

  function renderGuestEnded() {
    hideTabbar();
    view.innerHTML = `<div class="card"><h1>Thanks for playing</h1><p>Your guest access has finished. The scores stay with the member who invited you.</p>
      <p class="small">Fancy joining the society? <a href="../join.html">Find out more</a>.</p>
      <button class="btn ghost block" data-action="guest-signout">Close</button></div>`;
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
    const me = app.user.id;
    const [{ data: events, error }, { data: setups }, { data: prof }, { data: mine }, practiceRes] = await Promise.all([
      client.from("events").select("id, name, venue, event_date, tee_time, format, hidden, is_trip").eq("hidden", false).order("event_date"),
      client.from("event_scoring").select("event_id, status"),
      client.from("profiles").select("display_name").eq("id", me).maybeSingle(),
      client.from("players").select("id").eq("profile_id", me),
      // Practice rounds and private games aren't on the website; the app
      // fetches the ones you can see.
      client.rpc("my_games"),
    ]);
    if (error) { view.innerHTML = `<div class="card status-msg err">Couldn't load rounds: ${esc(error.message)}</div>`; return; }
    const games = practiceRes && !practiceRes.error ? (practiceRes.data || []) : [];
    const practice = games.filter(e => e.is_practice);
    const privateGames = games.filter(e => e.is_private);
    app.practiceOn = !!(practiceRes && !practiceRes.error);
    const myPlayers = (mine || []).map(p => p.id);
    // Rounds you're down to play, by your account or your name on the player list.
    const [byProfile, byPlayer, myResults] = await Promise.all([
      client.from("attendance").select("event_id, status").eq("profile_id", me),
      myPlayers.length ? client.from("attendance").select("event_id, status").in("player_id", myPlayers) : Promise.resolve({ data: [] }),
      myPlayers.length ? client.from("results").select("event_id, points, gross_score").in("player_id", myPlayers) : Promise.resolve({ data: [] }),
    ]);
    const playing = new Set([...(byProfile.data || []), ...(byPlayer.data || [])].filter(a => !a.status || a.status === "playing").map(a => a.event_id));

    const status = new Map((setups || []).map(s => [s.event_id, s.status]));
    const today = londonToday();
    const live = events.filter(e => status.get(e.id) === "live");
    const upcoming = events.filter(e => e.event_date >= today && status.get(e.id) !== "live");
    const past = events.filter(e => e.event_date < today && status.get(e.id) !== "live").reverse();

    const first = prof && prof.display_name ? String(prof.display_name).trim().split(/\s+/)[0] : "";
    const hour = Number(new Date().toLocaleTimeString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/London" }));
    const hello = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";

    view.innerHTML = `
      <a class="hello" href="#/me" aria-label="My profile">
        <div><div class="hello-hi">${hello}${first ? ", " + esc(first) : ""}</div>
        <div class="hello-sub">The Falkners Arms Golf Society · <span class="hello-link">My profile ›</span></div></div>
        ${avatar(prof && prof.display_name || "Me", me, "hello-av me")}
      </a>
      ${installTip()}
      ${pushTip()}
      ${heroCard(live[0] || upcoming[0], status, playing, today)}
      ${lastScoreCard(myResults.data || [], events)}
      <div class="card" id="season-card"><div class="loading" style="padding:12px">Loading the Order of Merit…</div></div>
      ${live.length > 1 ? `<div class="section-label">Live now</div>${live.slice(1).map(e => roundItem(e, status, playing)).join("")}` : ""}
      ${(live.length ? upcoming : upcoming.slice(1)).length ? `<div class="section-label">Coming up</div>${(live.length ? upcoming : upcoming.slice(1)).map(e => roundItem(e, status, playing)).join("")}` : ""}
      ${app.practiceOn ? `<div class="section-label">Private games</div>
        ${privateGames.map(e => roundItem(e, status, playing)).join("")}
        <button class="btn ghost block practice-new" data-action="private-new">＋ New private game</button>
        <p class="small muted practice-note">Up to 4 players: members and friends. Never counts for the Order of Merit or your handicap; the results go on your profile.</p>` : ""}
      ${practice.length || (app.committee && app.practiceOn) ? `<div class="section-label">Practice rounds</div>
        ${practice.map(e => roundItem(e, status, playing)).join("")}
        ${app.committee && app.practiceOn ? `<button class="btn ghost block practice-new" data-action="practice-new">＋ New practice round</button>
          <p class="small muted practice-note">Score from anywhere — no GPS needed. Practice rounds never reach the website, the Order of Merit, records or handicaps.</p>` : ""}` : ""}
      ${past.length ? `<div class="section-label">Played</div>${past.slice(0, 4).map(e => roundItem(e, status, playing)).join("")}
        ${past.length > 4 ? `<details class="more-rounds"><summary>All ${past.length} played rounds</summary>${past.slice(4).map(e => roundItem(e, status, playing)).join("")}</details>` : ""}` : ""}`;
    loadLastScoreRank(myResults.data || [], events, myPlayers);
    const heroEv = live[0] || upcoming[0];
    if (heroEv && window.FalknersWeather) window.FalknersWeather.forRound({ venue: heroEv.venue, date: heroEv.event_date, time: heroEv.tee_time }).then(f => {
      const slot = document.getElementById("hero-wx");
      if (f && slot) slot.innerHTML = `<div class="hero-wx">${f.first.w.icon} <b>${f.first.temp}°C</b> ${esc(f.text)} · ${f.maxRain}% rain · wind ${f.maxWind} mph</div>`;
    }).catch(() => {});
    seasonCard();
  }

  function badgeFor(st) {
    return st === "live" ? `<span class="badge live">Live</span>`
      : st === "final" ? `<span class="badge final">Final</span>`
      : st === "setup" ? `<span class="badge">Preview</span>` : "";
  }

  function roundItem(e, status, playing) {
    const d = new Date(e.event_date + "T12:00:00");
    return `
      <a class="card round-item" href="${e.is_trip ? "#/ryder/" : "#/round/"}${e.id}">
        <div class="round-date"><b>${d.getDate()}</b><span>${d.toLocaleDateString("en-GB", { month: "short" })}</span></div>
        <div class="round-meta">
          <strong>${esc(e.name)}${e.is_practice ? ' <span class="badge practice">Practice</span>' : e.is_private ? ' <span class="badge private">Private</span>' : ""}</strong>
          <span class="muted small">${esc(e.venue || "Venue TBC")}${e.tee_time ? " · " + esc(e.tee_time.slice(0, 5)) : ""}${playing.has(e.id) ? (e.event_date < londonToday() ? ' · <span class="playing">You played</span>' : ' · <span class="playing">You\'re playing</span>') : ""}</span>
        </div>
        ${badgeFor(status.get(e.id))}
        <span class="chev" aria-hidden="true">›</span>
      </a>`;
  }

  function daysAway(iso, today) {
    const n = Math.round((new Date(iso + "T12:00:00") - new Date(today + "T12:00:00")) / 864e5);
    return n === 0 ? "Today" : n === 1 ? "Tomorrow" : n < 0 ? "" : `In ${n} days`;
  }

  // The round that matters right now, big, with the one button you need.
  function heroCard(e, status, playing, today) {
    if (!e) return `<div class="card empty">No rounds scheduled yet.</div>`;
    const st = status.get(e.id);
    const isLive = st === "live";
    const onDay = e.event_date === today;
    const youre = playing.has(e.id);
    let cta;
    if (e.is_trip) cta = `<a class="btn gold block" href="#/ryder/${e.id}">Teams &amp; matches</a>`;
    else if (isLive && youre) cta = `<a class="btn gold block" href="#/round/${e.id}/start">Score now</a>`;
    else if (isLive) cta = `<a class="btn gold block" href="#/round/${e.id}">Live leaderboard</a>`;
    else if (onDay && youre && st) cta = `<a class="btn gold block" href="#/round/${e.id}/start">Start round</a>`;
    else if (st) cta = `<a class="btn gold block" href="#/round/${e.id}">View round</a>`;
    else cta = `<a class="btn ghost-light block" href="#/round/${e.id}">Round details</a>`;
    const when = isLive ? "Live now" : daysAway(e.event_date, today);
    return `<div class="hero">
      <div class="hero-top"><span class="hero-when">${esc(when || fmtDate(e.event_date))}</span>${badgeFor(st)}</div>
      <div class="hero-name">${esc(e.name)}</div>
      <div class="hero-venue">${esc(e.venue || "Venue TBC")}</div>
      <div class="hero-facts">
        <div><span>Date</span><b>${fmtDate(e.event_date)}</b></div>
        ${e.tee_time ? `<div><span>First tee</span><b>${esc(e.tee_time.slice(0, 5))}</b></div>` : ""}
        <div><span>You</span><b>${youre ? "Playing" : "Not entered"}</b></div>
      </div>
      <div id="hero-wx"></div>
      ${cta}
      ${youre ? "" : `<a class="hero-link" href="../fixtures.html">Register on the website ›</a>`}
    </div>`;
  }

  function lastScoreCard(results, events) {
    const byId = new Map(events.map(e => [e.id, e]));
    const rs = results.filter(x => byId.has(x.event_id) && x.points != null)
      .sort((a, b) => byId.get(b.event_id).event_date.localeCompare(byId.get(a.event_id).event_date));
    if (!rs.length) return "";
    const last = rs[0], ev = byId.get(last.event_id);
    const best = rs.reduce((m, x) => Math.max(m, x.points), 0);
    return `<a class="card last-card" href="#/round/${ev.id}">
      <div class="lc-col"><div class="big">${last.points}</div><div class="thru">pts last time</div></div>
      <div class="lc-col"><div class="big" id="last-rank">–</div><div class="thru">position</div></div>
      <div class="lc-col"><div class="big">${best}</div><div class="thru">best this season</div></div>
      <div class="lc-what small muted">${esc(ev.name)} · ${esc(ev.venue || "")}</div>
    </a>`;
  }

  async function loadLastScoreRank(results, events, myPlayers) {
    const el = document.getElementById("last-rank");
    if (!el) return;
    const byId = new Map(events.map(e => [e.id, e]));
    const rs = results.filter(x => byId.has(x.event_id) && x.points != null)
      .sort((a, b) => byId.get(b.event_id).event_date.localeCompare(byId.get(a.event_id).event_date));
    if (!rs.length) return;
    const { data } = await client.from("results").select("player_id, points").eq("event_id", rs[0].event_id);
    if (!data || !data.length) return;
    const above = data.filter(x => x.points != null && x.points > rs[0].points).length;
    const level = data.filter(x => x.points === rs[0].points && !myPlayers.includes(x.player_id)).length;
    const pos = above + 1;
    const sfx = n => (n % 100 >= 11 && n % 100 <= 13) ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
    const node = document.getElementById("last-rank");
    if (node) node.innerHTML = `${level ? "T" : ""}${pos}<small>${sfx(pos)}</small> <span class="of">/${data.length}</span>`;
  }


  // ---------- the season: Order of Merit ----------
  // Same table and the same rules as the website's leaderboard page
  // (buildLeaderboard in js/site-data.js), so the two never disagree.

  async function loadSeason() {
    const [res, set] = await Promise.all([
      client.from("results").select("*, players(name, handicap, profile_id), events(name, event_date)"),
      client.from("league_settings").select("counting_rounds").maybeSingle(),
    ]);
    if (res.error) throw res.error;
    const countingRounds = set.data ? set.data.counting_rounds : null;
    const table = typeof buildLeaderboard === "function" ? buildLeaderboard(res.data || [], { countingRounds }) : [];
    return { table, results: res.data || [], countingRounds };
  }

  function seasonRow(e, i, mine) {
    const mv = e.move == null || e.move === 0 ? "" : `<span class="move ${e.move > 0 ? "up" : "down"}">${e.move > 0 ? "▲" : "▼"}${Math.abs(e.move)}</span>`;
    return `<tr class="${mine ? "me" : ""}" data-stats="${e.playerId}">
      <td class="pos"><span class="medal ${i < 3 ? "p" + (i + 1) : ""}">${i + 1}</span>${mv}</td>
      <td class="av">${avatar(e.name, e.profileId, mine ? "me" : "")}</td>
      <td><strong>${esc(e.name)}</strong><div class="thru">${e.rounds} round${e.rounds === 1 ? "" : "s"}${e.countedRounds < e.rounds ? ` · best ${e.countedRounds} count` : ""}</div></td>
      <td class="num"><span class="big">${e.totalPoints}</span></td></tr>`;
  }

  async function renderSeason() {
    view.innerHTML = `<div class="loading">Loading the Order of Merit…</div>`;
    let d;
    try { d = await loadSeason(); } catch (e) { view.innerHTML = `<div class="card status-msg err">${esc(e.message)}</div>`; return; }
    const me = app.user.id;
    const top = d.table[0];
    view.innerHTML = `
      <a class="back-link" href="#/">‹ Home</a>
      <h1>Order of Merit</h1>
      <p class="small muted" style="margin-top:-4px">Stableford points across the season${d.countingRounds ? ` · best ${d.countingRounds} rounds count` : ""}. Arrows show the move since the last round.</p>
      ${top ? leaderCard("Leading the season", esc(top.name), top.totalPoints, "pts", `${top.rounds} rounds`) : ""}
      <div class="card board-card"><table class="board"><thead><tr><th></th><th colspan="2">Player</th><th class="num">Pts</th></tr></thead>
        <tbody>${d.table.map((e, i) => seasonRow(e, i, e.profileId === me)).join("") || `<tr><td colspan="4" class="muted">No results yet.</td></tr>`}</tbody></table>
        <p class="small muted" style="margin:10px 0 0">Tap a player for their stats.</p></div>`;
  }

  async function seasonCard() {
    const el = document.getElementById("season-card");
    if (!el) return;
    try {
      const d = await loadSeason();
      if (!d.table.length) { el.remove(); return; }
      const me = app.user.id;
      const i = d.table.findIndex(e => e.profileId === me);
      const rows = d.table.slice(0, 3).map((e, n) => seasonRow(e, n, e.profileId === me)).join("") + (i > 2 ? seasonRow(d.table[i], i, true) : "");
      el.innerHTML = `<div class="row"><h2 style="margin:0">Order of Merit</h2><span class="spacer"></span><a class="mv-link" href="#/season">Full table ›</a></div>
        <table class="board" style="margin-top:6px"><tbody>${rows}</tbody></table>`;
    } catch (e) { el.remove(); }
  }

  // ---------- a player's stats ----------

  // Every round behind a society handicap, newest first, with the cards
  // that currently count marked.
  function hcHistoryCard(list, p) {
    const withDiff = list.filter(x => x.differential != null);
    const last = withDiff.slice(-20);
    const w = S.whsIndex(last.map(x => Number(x.differential)));
    const counting = new Set(w ? last.slice().sort((a, b) => Number(a.differential) - Number(b.differential)).slice(0, w.used).map(x => x.id || x.event_id) : []);
    const tag = x => x.source === "points" ? '<span class="hc-src pts">from points</span>' : x.source === "manual" ? '<span class="hc-src man">committee</span>' : '<span class="hc-src card">app card</span>';
    return `<div class="card"><h2>Handicap history</h2>
      <p class="small muted" style="margin-top:-4px">${w ? `Best ${w.used} of the last ${w.of} differentials${w.adjust ? ` ${w.adjust}` : ""} = <b>${w.index}</b>.` : `${withDiff.length} of 3 cards needed for a calculated handicap.`} Cards that count are marked ★. Rounds before the app are worked out from Stableford points, so they're a close estimate rather than exact.</p>
      ${list.slice().reverse().map(x => `<div class="hc-hist">
        <div class="hc-h-when"><b>${esc(x.events ? x.events.name : x.source === "manual" ? "Committee" : "Round")}</b><span class="thru">${fmtDate(hcDate(x).slice(0, 10))}</span></div>
        <div class="hc-h-mid">${tag(x)}${x.differential != null ? `<span class="hc-diff">${counting.has(x.id || x.event_id) ? "★ " : ""}${Number(x.differential).toFixed(1)}</span>` : ""}
          ${x.note ? `<div class="thru">${esc(x.note)}</div>` : ""}</div>
        <div class="hc-h-val">${x.new_index != null ? `${x.old_index != null ? `<span class="muted">${x.old_index} →</span> ` : ""}<b>${x.new_index}</b>` : ""}${Number(x.cut) > 0 ? `<div class="thru">−${x.cut} next round</div>` : ""}</div>
      </div>`).join("")}</div>`;
  }

  // ---------- statistics (the member themselves, and the committee) ----------

  // Every hole they've scored in the app: society rounds and private
  // games (practice rounds left out), with par, putts and fairway.
  async function loadHoleRecords(pid) {
    const [hs, st, evs, mg] = await Promise.all([
      client.from("hole_scores").select("event_id, hole, strokes, picked_up").eq("player_id", pid),
      client.from("hole_stats").select("event_id, hole, putts, fairway").eq("player_id", pid),
      client.from("events").select("id, name, venue, event_date"),
      client.rpc("my_games"),
    ]);
    const evById = new Map([...(evs.data || []), ...((mg && mg.data) || []).filter(e => !e.is_practice)].map(e => [e.id, e]));
    const scores = (hs.data || []).filter(h => evById.has(h.event_id));
    const evIds = [...new Set(scores.map(h => h.event_id))];
    const { data: setups } = evIds.length ? await client.from("event_scoring").select("event_id, tee_id").in("event_id", evIds) : { data: [] };
    const teeIds = [...new Set((setups || []).map(x => x.tee_id).filter(Boolean))];
    const { data: ch } = teeIds.length ? await client.from("course_holes").select("tee_id, hole, par").in("tee_id", teeIds) : { data: [] };
    const teeOfEv = new Map((setups || []).map(x => [x.event_id, x.tee_id]));
    const parOf = new Map((ch || []).map(h => [h.tee_id + ":" + h.hole, h.par]));
    const statOf = new Map((st.data || []).map(x => [x.event_id + ":" + x.hole, x]));
    return scores.map(h => {
      const par = parOf.get(teeOfEv.get(h.event_id) + ":" + h.hole);
      const sx = statOf.get(h.event_id + ":" + h.hole) || {};
      return par ? { ev: evById.get(h.event_id), par, strokes: h.picked_up ? null : h.strokes, putts: sx.putts ?? null, fairway: sx.fairway || null } : null;
    }).filter(Boolean);
  }

  function statSummary(recs) {
    const t = { birdie: 0, par: 0, bogey: 0, double: 0, n: 0 };
    const byPar = { 3: [], 4: [], 5: [] };
    const fw = { hit: 0, left: 0, right: 0, n: 0 };
    let gir = 0, girN = 0, putts = 0, puttN = 0, puttsGir = 0, scr = 0, scrN = 0;
    recs.forEach(r => {
      t.n++;
      if (r.strokes == null) { t.double++; return; }
      const d = r.strokes - r.par;
      if (d <= -1) t.birdie++; else if (d === 0) t.par++; else if (d === 1) t.bogey++; else t.double++;
      if (byPar[r.par]) byPar[r.par].push(r.strokes - r.par);
      if (r.fairway && r.par >= 4) { fw.n++; fw[r.fairway]++; }
      if (r.putts != null) {
        putts += r.putts; puttN++; girN++;
        const hit = r.strokes - r.putts <= r.par - 2;
        if (hit) { gir++; puttsGir += r.putts; } else { scrN++; if (d <= 0) scr++; }
      }
    });
    const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    return { t, byPar: { 3: mean(byPar[3]), 4: mean(byPar[4]), 5: mean(byPar[5]) }, fw, gir, girN, putts: puttN ? putts / puttN : null, puttN, puttsGir: gir ? puttsGir / gir : null, scr, scrN };
  }
  const pct = (a, b) => b ? Math.round(a / b * 100) : null;

  // A ring of coloured segments, like the one in a scoring app.
  function ring(parts, size = 76) {
    const total = parts.reduce((s, p) => s + p.v, 0);
    const r = 28, c = 2 * Math.PI * r;
    let off = 0;
    const segs = total ? parts.filter(p => p.v > 0).map(p => { const len = p.v / total * c; const s = `<circle r="${r}" cx="38" cy="38" fill="none" stroke="${p.col}" stroke-width="12" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-off}" transform="rotate(-90 38 38)"/>`; off += len; return s; }).join("") : "";
    return `<svg class="st-ring" width="${size}" height="${size}" viewBox="0 0 76 76" aria-hidden="true"><circle r="${r}" cx="38" cy="38" fill="none" stroke="#e6e9ef" stroke-width="12"/>${segs}</svg>`;
  }
  // Average over par on 3s, 4s and 5s as bars from -1 to +3.
  function parBars(bp) {
    const x = v => 8 + (Math.max(-1, Math.min(3, v)) + 1) / 4 * 64;
    const rows = [[3, "#2f6fd6"], [4, "#e8c547"], [5, "#d64541"]];
    return `<svg class="st-ring" width="80" height="76" viewBox="0 0 80 76" aria-hidden="true">
      ${[-1, 0, 1, 2, 3].map(v => `<line x1="${x(v)}" x2="${x(v)}" y1="12" y2="74" stroke="#9aa3b5" stroke-width="${v === 0 ? 1.2 : .6}"/><text x="${x(v)}" y="9" font-size="7" text-anchor="middle" fill="#57617A">${v === 0 ? "E" : v > 0 ? "+" + v : v}</text>`).join("")}
      ${rows.map(([p, col], i) => bp[p] == null ? "" : `<rect x="${x(Math.min(0, bp[p]))}" y="${16 + i * 19}" width="${Math.max(2, Math.abs(x(bp[p]) - x(0)))}" height="14" fill="${col}"/>`).join("")}</svg>`;
  }
  function puttBars(s) {
    const w = v => v == null ? 0 : Math.min(1, v / 4) * 64;
    return `<svg class="st-ring" width="80" height="76" viewBox="0 0 80 76" aria-hidden="true">
      ${[1, 2, 3, 4].map(v => `<line x1="${8 + v * 16}" x2="${8 + v * 16}" y1="12" y2="74" stroke="#9aa3b5" stroke-width=".6"/><text x="${8 + v * 16}" y="9" font-size="7" text-anchor="middle" fill="#57617A">${v}</text>`).join("")}
      <rect x="8" y="24" width="${w(s.putts)}" height="14" fill="#e8923a"/><rect x="8" y="46" width="${w(s.puttsGir)}" height="14" fill="#2f6fd6"/></svg>`;
  }

  const STAT_ROWS = [
    { key: "scoring", title: "Scoring", ok: s => s.t.n, art: s => ring([{ v: s.t.birdie, col: "#d64541" }, { v: s.t.par, col: "#2f6fd6" }, { v: s.t.bogey, col: "#4f9d55" }, { v: s.t.double, col: "#6b7280" }]),
      vals: s => [[pct(s.t.birdie, s.t.n) + "%", "Birdie+", "#d64541"], [pct(s.t.par, s.t.n) + "%", "Pars", "#2f6fd6"], [pct(s.t.bogey, s.t.n) + "%", "Bogeys", "#4f9d55"], [pct(s.t.double, s.t.n) + "%", "2 Bogeys+", "#6b7280"]],
      base: s => `${s.t.n} holes · pick-ups count as 2 bogeys+`, trend: s => s.t.n ? Math.round((s.t.birdie + s.t.par) / s.t.n * 100) : null, trendLabel: "% pars or better" },
    { key: "pars", title: "Pars", ok: s => s.t.n - s.t.double >= 0 && (s.byPar[3] != null || s.byPar[4] != null), art: s => parBars(s.byPar),
      vals: s => [[3, "#2f6fd6"], [4, "#c9a227"], [5, "#d64541"]].map(([p, col]) => [s.byPar[p] == null ? "–" : (p + s.byPar[p]).toFixed(1), "Par " + p, col]),
      base: () => "Average score on each, pick-ups left out", trend: s => { const v = [3, 4, 5].map(p => s.byPar[p]).filter(x => x != null); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null; }, trendLabel: "average over par per hole", lowGood: true },
    { key: "fairways", title: "Fairways", ok: s => s.fw.n, art: s => ring([{ v: s.fw.hit, col: "#4f9d55" }, { v: s.fw.left, col: "#d64541" }, { v: s.fw.right, col: "#e8923a" }]),
      vals: s => [[pct(s.fw.hit, s.fw.n) + "%", "Hit", "#4f9d55"], [pct(s.fw.left, s.fw.n) + "%", "Left", "#d64541"], [pct(s.fw.right, s.fw.n) + "%", "Right", "#e8923a"]],
      base: s => `${s.fw.n} par 4s and 5s with the fairway logged`, trend: s => pct(s.fw.hit, s.fw.n), trendLabel: "% fairways hit" },
    { key: "gir", title: "Greens in Regulation", ok: s => s.girN, art: s => ring([{ v: s.gir, col: "#4f9d55" }, { v: s.girN - s.gir, col: "#e6e9ef" }]),
      vals: s => [[pct(s.gir, s.girN) + "%", "Hit", "#4f9d55"], [pct(s.girN - s.gir, s.girN) + "%", "Miss", "#9aa3b5"]],
      base: s => `${s.girN} holes with putts logged`, trend: s => pct(s.gir, s.girN), trendLabel: "% greens hit" },
    { key: "scramble", title: "Scrambling", ok: s => s.scrN, art: s => ring([{ v: s.scr, col: "#7b4fc9" }, { v: s.scrN - s.scr, col: "#e6e9ef" }]),
      vals: s => [[pct(s.scr, s.scrN) + "%", "Saved par or better", "#7b4fc9"]],
      base: s => `${s.scrN} missed greens`, trend: s => pct(s.scr, s.scrN), trendLabel: "% par saves after missing the green" },
    { key: "putting", title: "Putting", ok: s => s.puttN, art: s => puttBars(s),
      vals: s => [[s.putts == null ? "–" : s.putts.toFixed(2), "Per hole", "#e8923a"], [s.puttsGir == null ? "–" : s.puttsGir.toFixed(2), "Per green hit", "#2f6fd6"]],
      base: s => `${s.puttN} holes with putts logged · ${s.putts == null ? "–" : (s.putts * 18).toFixed(1)} per 18`, trend: s => s.putts == null ? null : +(s.putts * 18).toFixed(1), trendLabel: "putts per 18", lowGood: true },
  ];

  const statsView = { pid: null, recs: null, name: "" };
  async function renderStatistics(playerId) {
    view.innerHTML = `<div class="loading">Loading statistics…</div>`;
    let pid = playerId;
    if (!pid) {
      const { data } = await client.from("players").select("id").eq("profile_id", app.user.id).is("guest_event_id", null).limit(1);
      pid = data && data[0] ? data[0].id : null;
    }
    const { data: p } = pid ? await client.from("players").select("id, name, profile_id").eq("id", pid).maybeSingle() : { data: null };
    if (!p) { view.innerHTML = `<a class="back-link" href="#/me">‹ My profile</a><div class="card empty"><p>You're not on the player list yet, so there are no statistics.</p></div>`; return; }
    const isMe = p.profile_id === app.user.id;
    if (!isMe && !app.committee) { view.innerHTML = `<a class="back-link" href="#/stats/${p.id}">‹ ${esc(p.name)}</a><div class="card empty"><p>Statistics are private to each member.</p></div>`; return; }
    const recs = await loadHoleRecords(p.id);
    Object.assign(statsView, { pid: p.id, recs, name: p.name });
    const s = statSummary(recs);
    const rounds = new Set(recs.map(r => r.ev.id)).size;
    const back = isMe ? `<a class="back-link" href="#/me">‹ My profile</a>` : `<a class="back-link" href="#/stats/${p.id}">‹ ${esc(p.name)}</a>`;
    if (!recs.length) { view.innerHTML = `${back}<h1>Statistics</h1><div class="card empty"><p>Statistics start from the first round scored in the app.</p></div>`; return; }
    view.innerHTML = `${back}
      <h1 style="margin-bottom:2px">Statistics${isMe ? "" : ` · ${esc(p.name)}`}</h1>
      <p class="small muted" style="margin-top:0">${rounds} round${rounds === 1 ? "" : "s"} · ${recs.length} holes · society rounds and private games${isMe ? " · only you and the committee see these" : ""}</p>
      <div class="card st-list">${STAT_ROWS.map(row => { const ok = row.ok(s); return `
        <button type="button" class="st-row" data-action="stat-trend" data-key="${row.key}" ${ok ? "" : "disabled"}>
          <span class="st-art">${row.art(s)}</span>
          <span class="st-body"><b class="st-title">${row.title}</b>
            ${ok ? `<span class="st-vals">${row.vals(s).map(([v, l, col]) => `<span><em><i style="border-color:${col}"></i>${v}</em><small>${l}</small></span>`).join("")}</span>
            <small class="st-base">${row.base(s)}</small>` : `<small class="st-base">Nothing logged yet${row.key === "fairways" || row.key === "gir" || row.key === "putting" || row.key === "scramble" ? ": add putts and fairways on the number pad when you score" : ""}</small>`}</span>
          ${ok ? `<span class="ci-chev">›</span>` : ""}
        </button>`; }).join("")}</div>`;
  }

  function statTrend(key) {
    const row = STAT_ROWS.find(r => r.key === key); if (!row || !statsView.recs) return;
    const byEv = new Map();
    statsView.recs.forEach(r => { if (!byEv.has(r.ev.id)) byEv.set(r.ev.id, { ev: r.ev, recs: [] }); byEv.get(r.ev.id).recs.push(r); });
    const pts = [...byEv.values()].sort((a, b) => a.ev.event_date.localeCompare(b.ev.event_date))
      .map(x => ({ ev: x.ev, v: row.trend(statSummary(x.recs)) })).filter(x => x.v != null);
    const W = 320, H = 150, pad = 26;
    let chart = `<p class="small muted">Not enough rounds yet to show a trend.</p>`;
    if (pts.length) {
      const vs = pts.map(x => x.v), lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
      const X = i => pts.length === 1 ? W / 2 : pad + i * (W - pad * 2) / (pts.length - 1), Y = v => H - 22 - (v - lo) / span * (H - 50);
      chart = `<svg class="st-trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(row.title)} by round">
        <polyline fill="none" stroke="#1B3A6C" stroke-width="2.5" points="${pts.map((x, i) => X(i) + "," + Y(x.v)).join(" ")}"/>
        ${pts.map((x, i) => `<circle cx="${X(i)}" cy="${Y(x.v)}" r="4" fill="#B8923C"/><text x="${X(i)}" y="${Y(x.v) - 9}" font-size="10" text-anchor="middle" fill="#10233F">${x.v}</text><text x="${X(i)}" y="${H - 6}" font-size="8.5" text-anchor="middle" fill="#57617A">${esc(fmtDate(x.ev.event_date, { day: "numeric", month: "short" }))}</text>`).join("")}</svg>`;
    }
    openSheet(`<h2>${esc(row.title)}</h2><p class="small muted" style="margin-top:-4px">Round by round: ${row.trendLabel}${row.lowGood ? " (lower is better)" : ""}.</p>${chart}
      <div class="st-trend-list">${pts.slice().reverse().map(x => `<div class="row"><span>${esc(x.ev.name)}<span class="thru"> · ${esc(fmtDate(x.ev.event_date))}</span></span><span class="spacer"></span><b>${x.v}</b></div>`).join("")}</div>
      <button class="btn ghost block" style="margin-top:10px" data-action="close-sheet">Done</button>`);
  }

  async function renderStats(playerId) {
    view.innerHTML = `<div class="loading">Loading stats…</div>`;
    let pid = playerId;
    if (!pid) {
      const { data } = await client.from("players").select("id").eq("profile_id", app.user.id).limit(1);
      pid = data && data[0] ? data[0].id : null;
      if (!pid) { view.innerHTML = `<a class="back-link" href="#/">‹ Home</a><div class="card empty"><p>You're not on the player list yet, so there are no stats to show.</p><p class="small">The committee links your account to your name on the admin page.</p></div>`; return; }
    }
    const [pl, res, hs, st, evs] = await Promise.all([
      client.from("players").select("id, name, handicap, profile_id").eq("id", pid).maybeSingle(),
      client.from("results").select("event_id, player_id, points, gross_score"),
      client.from("hole_scores").select("event_id, hole, strokes, picked_up").eq("player_id", pid),
      client.from("hole_stats").select("event_id, hole, putts, fairway").eq("player_id", pid),
      client.from("events").select("id, name, venue, event_date, tee_time, hidden"),
    ]);
    if (!pl.data) { view.innerHTML = `<div class="card status-msg err">Couldn't find that player.</div>`; return; }
    const p = pl.data;
    // The working behind their society handicap, open to every member.
    const [hr, hx] = await Promise.all([
      client.from("handicap_reviews").select("*, events(name, event_date)").eq("player_id", pid),
      client.from("players").select("official_index, hcp_cut, hcp_cut_note").eq("id", pid).maybeSingle(),
    ]);
    const hcHistory = hr.error ? null : (hr.data || []).slice().sort((a, b) => hcDate(a).localeCompare(hcDate(b)));
    // Private games: the ones this viewer is allowed to see.
    const [gr, mg] = await Promise.all([
      client.from("game_results").select("event_id, points, gross, position, field").eq("player_id", pid),
      client.rpc("my_games"),
    ]);
    const bagItems = await loadBag(pid);
    const gameById = new Map(((mg && mg.data) || []).filter(e => e.is_private).map(e => [e.id, e]));
    const privateRows = ((gr && gr.data) || []).filter(x => gameById.has(x.event_id))
      .sort((a, b) => gameById.get(b.event_id).event_date.localeCompare(gameById.get(a.event_id).event_date));
    const hcExtra = hx.error ? {} : (hx.data || {});
    const evById = new Map((evs.data || []).map(e => [e.id, e]));
    const all = res.data || [];
    const mine = all.filter(x => x.player_id === pid && x.points != null && evById.has(x.event_id))
      .sort((a, b) => evById.get(a.event_id).event_date.localeCompare(evById.get(b.event_id).event_date));
    const posIn = x => { const f = all.filter(y => y.event_id === x.event_id && y.points != null); return { pos: f.filter(y => Number(y.points) > Number(x.points)).length + 1, of: f.length }; };
    // Pars for every round they've a card on.
    const evIds = [...new Set((hs.data || []).map(h => h.event_id))];
    const { data: setups } = evIds.length ? await client.from("event_scoring").select("event_id, tee_id").in("event_id", evIds) : { data: [] };
    const teeIds = [...new Set((setups || []).map(x => x.tee_id).filter(Boolean))];
    const { data: ch } = teeIds.length ? await client.from("course_holes").select("tee_id, hole, par").in("tee_id", teeIds) : { data: [] };
    const teeOfEv = new Map((setups || []).map(x => [x.event_id, x.tee_id]));
    const parOf = new Map((ch || []).map(h => [h.tee_id + ":" + h.hole, h.par]));
    const statOf = new Map((st.data || []).map(x => [x.event_id + ":" + x.hole, x]));
    const tally = { eagle: 0, birdie: 0, par: 0, bogey: 0, double: 0, worse: 0, pu: 0 };
    const byPar = { 3: [], 4: [], 5: [] };
    let putts = 0, puttHoles = 0, fwHit = 0, fwTotal = 0, gir = 0, girHoles = 0;
    (hs.data || []).forEach(h => {
      const par = parOf.get(teeOfEv.get(h.event_id) + ":" + h.hole);
      if (!par) return;
      if (h.picked_up || h.strokes == null) { tally.pu++; return; }
      const d = h.strokes - par;
      if (d <= -2) tally.eagle++; else if (d === -1) tally.birdie++; else if (d === 0) tally.par++; else if (d === 1) tally.bogey++; else if (d === 2) tally.double++; else tally.worse++;
      if (byPar[par]) byPar[par].push(h.strokes);
      const sx = statOf.get(h.event_id + ":" + h.hole);
      if (sx && sx.putts != null) { putts += sx.putts; puttHoles++; girHoles++; if (h.strokes - sx.putts <= par - 2) gir++; }
      if (sx && sx.fairway && par >= 4) { fwTotal++; if (sx.fairway === "hit") fwHit++; }
    });
    const holes = Object.values(tally).reduce((a, b) => a + b, 0);
    const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : "–";
    const pts = mine.map(x => Number(x.points));
    const best = pts.length ? Math.max(...pts) : null;
    const mean = pts.length ? (pts.reduce((a, b) => a + b, 0) / pts.length).toFixed(1) : "–";
    const maxP = Math.max(40, ...pts);
    const chart = pts.length ? `<svg class="pts-chart" viewBox="0 0 ${Math.max(pts.length * 40, 240)} 120" aria-label="Points by round">
      ${pts.map((v, i) => `<rect x="${i * 40 + 8}" y="${110 - (v / maxP) * 100}" width="24" height="${(v / maxP) * 100}" rx="4" fill="${v === best ? "#B8923C" : "#1B3A6C"}"/>
        <text x="${i * 40 + 20}" y="${104 - (v / maxP) * 100}" text-anchor="middle" font-size="11" fill="#57617A">${v}</text>`).join("")}</svg>` : "";
    const isMe = p.profile_id === app.user.id;
    // Where they stand on the season table, same as the website's leaderboard.
    let oom = null;
    try { const d = await loadSeason(); const i = d.table.findIndex(e => e.playerId === pid); if (i >= 0) oom = { pos: i + 1, of: d.table.length, pts: d.table[i].totalPoints, move: d.table[i].move }; } catch (e) { /* table not available */ }
    // Their fixtures: coming up, and whether they're down to play.
    let fixtures = "";
    if (isMe) {
      const today = londonToday();
      const [a1, a2, sc] = await Promise.all([
        client.from("attendance").select("event_id, status").eq("profile_id", app.user.id),
        client.from("attendance").select("event_id, status").eq("player_id", pid),
        client.from("event_scoring").select("event_id, status"),
      ]);
      const playing = new Set([...(a1.data || []), ...(a2.data || [])].filter(a => !a.status || a.status === "playing").map(a => a.event_id));
      const status = new Map((sc.data || []).map(x => [x.event_id, x.status]));
      const next = (evs.data || []).filter(e => !e.hidden && e.event_date >= today).sort((a, b) => a.event_date.localeCompare(b.event_date));
      fixtures = `<div class="card"><h2>Fixtures</h2>${next.length ? next.map(e => roundItem(e, status, playing).replace('class="card round-item"', 'class="round-item fx-item"')).join("") : `<p class="small muted">No fixtures coming up.</p>`}
        <a class="small" href="../fixtures.html">Register or pay on the website ›</a></div>`;
    }
    const bar = (label, n, cls) => `<div class="dist-row"><span>${label}</span><div class="dist-bar"><i class="${cls}" style="width:${holes ? Math.round(n / holes * 100) : 0}%"></i></div><b>${n}</b></div>`;
    view.innerHTML = `
      <a class="back-link" href="${isMe ? "#/" : "#/season"}">‹ ${isMe ? "Home" : "Order of Merit"}</a>
      <div class="profile-head">${avatar(p.name, p.profile_id, "big-av" + (isMe ? " me" : ""))}<div style="flex:1;min-width:0"><h1 style="margin:0">${esc(p.name)}</h1>
        <div class="small muted">Society handicap ${p.handicap == null ? "?" : p.handicap}${hcExtra.official_index != null ? ` · England Golf ${hcExtra.official_index}` : ""}</div>
        ${Number(hcExtra.hcp_cut) > 0 ? `<div class="hc-pending">${esc(hcExtra.hcp_cut_note || `−${hcExtra.hcp_cut} next round`)} — next round only</div>` : ""}
        ${isMe ? `<label class="mv-link photo-link">${app.avatars.get(app.user.id) ? "Change" : "Add"} profile picture<input type="file" id="avatar-file" accept="image/*" hidden></label>` : ""}</div></div>
      ${oom ? `<a class="card oom-card" href="#/season"><div><div class="lc-label" style="color:var(--ink-soft)">Order of Merit</div>
          <div class="oom-pos">${ordinal(oom.pos)} <small>of ${oom.of}</small>${oom.move ? ` <span class="move ${oom.move > 0 ? "up" : "down"}" style="display:inline">${oom.move > 0 ? "▲" : "▼"}${Math.abs(oom.move)}</span>` : ""}</div></div>
          <div style="text-align:right"><div class="big">${oom.pts}</div><div class="thru">points</div></div></a>` : ""}
      <div class="card last-card" style="margin-top:12px">
        <div class="lc-col"><div class="big">${mine.length}</div><div class="thru">rounds</div></div>
        <div class="lc-col"><div class="big">${mean}</div><div class="thru">average pts</div></div>
        <div class="lc-col"><div class="big">${best == null ? "–" : best}</div><div class="thru">best</div></div>
      </div>
      ${chart ? `<div class="card"><h2>Points by round</h2>${chart}</div>` : ""}
      ${bagItems ? bagCard(bagItems, p, isMe) : ""}
      ${hcHistory && hcHistory.length ? hcHistoryCard(hcHistory, p) : ""}
      ${privateRows.length ? `<div class="card"><h2>Private games</h2><p class="small muted" style="margin-top:-4px">Friendly rounds — they don't count for the Order of Merit or handicaps.</p>
        ${privateRows.map(x => { const e = gameById.get(x.event_id); return `<a class="row stat-round" href="#/round/${e.id}"><div><b>${esc(e.name)}</b><div class="thru">${esc(e.venue || "")} · ${fmtDate(e.event_date)}</div></div><span class="spacer"></span>
          <span class="small muted">${x.position ? `${ordinal(x.position)} of ${x.field}` : ""}${x.gross ? ` · ${x.gross} gross` : ""}</span><span class="big" style="margin-left:12px">${x.points == null ? "–" : x.points}</span></a>`; }).join("")}</div>` : ""}
      ${isMe || app.committee ? `<a class="card st-link" href="${isMe ? "#/me/statistics" : `#/statistics/${p.id}`}"><span class="st-art">${ring([{ v: tally.eagle + tally.birdie, col: "#d64541" }, { v: tally.par, col: "#2f6fd6" }, { v: tally.bogey, col: "#4f9d55" }, { v: tally.double + tally.worse + tally.pu, col: "#6b7280" }], 56)}</span>
        <span class="st-body"><b class="st-title">Statistics</b><small class="st-base">${holes ? `Scoring, par averages, fairways, greens, putting and scrambling · ${holes} holes` : "Start from the first round scored in the app"}</small>${isMe ? "" : `<small class="st-base">Private: you see this as committee</small>`}</span><span class="ci-chev">›</span></a>` : ""}
      ${fixtures}
      <div class="card"><h2>Rounds</h2>${mine.slice().reverse().map(x => { const e = evById.get(x.event_id); const q = posIn(x);
        return `<a class="row stat-round" href="#/round/${e.id}"><div><b>${esc(e.name)}</b><div class="thru">${esc(e.venue || "")} · ${fmtDate(e.event_date)}</div></div><span class="spacer"></span>
          <span class="small muted">${ordinal(q.pos)} of ${q.of}${x.gross_score ? ` · ${x.gross_score} gross` : ""}</span><span class="big" style="margin-left:12px">${x.points}</span></a>`; }).join("") || `<p class="small muted">No results yet.</p>`}</div>
      ${isMe ? `<p class="small muted" style="text-align:center">Change your name or bio on the <a href="../member.html">website</a>.</p>` : ""}`;
  }


  // ---------- phone notifications ----------
  // Round published, results in, a dispute in your group. On an iPhone
  // these only work once the app is on the home screen (iOS 16.4 or later).

  // The public half of the signing key, from the database. The first
  // phone to ask wakes the function, which makes the keys.
  async function vapidKey() {
    let { data } = await client.rpc("push_public_key");
    if (!data) {
      await client.functions.invoke("push-notify", { body: { type: "init" } }).catch(() => null);
      ({ data } = await client.rpc("push_public_key"));
    }
    if (!data) throw new Error("Notifications aren't switched on for the society yet — ask the committee.");
    return data;
  }
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  function b64ToBytes(b64) {
    const pad = "=".repeat((4 - b64.length % 4) % 4);
    const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }
  async function currentSub() {
    if (!pushSupported()) return null;
    // If the service worker never starts (private browsing, blocked), don't hang.
    const ready = Promise.race([navigator.serviceWorker.ready, new Promise(res => setTimeout(() => res(null), 3000))]);
    try { const reg = await ready; return reg ? await reg.pushManager.getSubscription() : null; } catch (e) { return null; }
  }

  async function enablePush() {
    if (!pushSupported()) throw new Error("This phone or browser can't do notifications.");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error(perm === "denied" ? "Notifications are blocked for the app — allow them in your phone's settings." : "Notifications weren't turned on.");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(await vapidKey()) });
    const j = sub.toJSON();
    const { error } = await client.rpc("save_push_subscription", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_agent: navigator.userAgent });
    if (error) throw error;
    store.set("push-on", true);
  }

  async function disablePush() {
    const sub = await currentSub();
    if (sub) {
      await client.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      try { await sub.unsubscribe(); } catch (e) { /* already gone */ }
    }
    store.set("push-on", false);
  }

  async function pushSheet() {
    const pf = platform();
    const sub = await currentSub();
    const on = !!sub && Notification.permission === "granted";
    let body;
    if (pf.ios && !isStandalone()) {
      body = `<p>On an iPhone, notifications only work from the app on your home screen.</p>
        <button class="btn gold block" data-action="install-help">Add it to your home screen</button>
        <p class="small muted">Then open it from there and turn notifications on.</p>`;
    } else if (!pushSupported()) {
      body = `<p>This browser can't do notifications. Try the app in ${pf.ios ? "Safari, added to your home screen" : "Chrome"}.</p>`;
    } else if (Notification.permission === "denied") {
      body = `<p>Notifications are blocked for the app. Turn them on in your phone's settings${pf.ios ? " (Settings → Notifications → Falkners Golf)" : " (Chrome → Site settings → Notifications)"}, then come back here.</p>`;
    } else {
      body = `<p>Get a buzz when:</p>
        <ul class="push-list"><li>the committee publishes a round you're playing</li><li>a score in your group is disputed</li><li>the results are in</li></ul>
        ${on ? `<p class="status-msg ok small">Notifications are on for this phone.</p><button class="btn ghost block" data-action="push-off">Turn them off</button>`
             : `<button class="btn gold block" data-action="push-on">Turn on notifications</button>`}`;
    }
    openSheet(`<h2>Notifications</h2>${body}<button class="btn ghost block" style="margin-top:8px" data-action="close-sheet">Done</button>`);
  }

  function pushTip() {
    if (!pushSupported() || !isStandalone() || store.get("push-on", false) || store.get("hide-push-tip", false)) return "";
    if (Notification.permission !== "default") return "";
    return `<div class="card install-tip"><span class="it-icon" style="display:grid;place-items:center;font-size:1.6rem;background:#fff6e0">🔔</span>
      <div class="it-text"><strong>Turn on notifications</strong><div class="small muted">Know when your round's live</div></div>
      <button class="btn gold" style="min-height:38px" data-action="push-on">Turn on</button>
      <button class="it-x" data-action="hide-push-tip" aria-label="Not now">×</button></div>`;
  }

  // ---------- getting it on the home screen ----------

  let installEvent = null; // Android/Chrome's own install prompt, when offered
  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    installEvent = e;
    const b = document.getElementById("install-now");
    if (b) b.hidden = false;
  });
  window.addEventListener("appinstalled", () => { installEvent = null; store.set("app-installed", true); });

  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  function platform() {
    const ua = navigator.userAgent;
    const ios = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
    return {
      ios,
      android: /android/i.test(ua),
      inApp: /FBAN|FBAV|Instagram|Line\/|WhatsApp|GSA\//i.test(ua),
      iosOther: ios && /CriOS|FxiOS|EdgiOS/i.test(ua),
    };
  }

  function installTip() {
    if (isStandalone() || store.get("app-installed", false)) return "";
    const hidden = store.get("hide-install-tip", 0);
    // Dismissed? Ask again in a fortnight, in case they change their mind.
    if (hidden && (hidden === true || Date.now() - hidden < 14 * 864e5)) return "";
    return `
      <div class="card install-tip">
        <img src="icons/icon-192.png" alt="" class="it-icon">
        <div class="it-text"><strong>Get the app</strong>
          <div class="small muted">Add it to your home screen</div></div>
        <button class="btn gold" style="min-height:38px" data-action="install-help">Show me</button>
        <button class="it-x" data-action="hide-tip" aria-label="Not now">×</button>
      </div>`;
  }

  const SHARE_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>`;
  const DOTS_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`;
  const ADD_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/></svg>`;

  function installSheet() {
    if (isStandalone()) { openSheet(`<h2>You're all set</h2><p>You're already using the app from your home screen.</p><button class="btn block" data-action="close-sheet">Done</button>`); return; }
    const pf = platform();
    const step = (n, html) => `<li class="i-step"><span class="i-num">${n}</span><div>${html}</div></li>`;
    let steps;
    if (pf.inApp) {
      steps = step(1, `This page has opened inside another app (WhatsApp, Facebook or similar), which can't add it to your home screen.`) +
        step(2, `Tap <b>⋯</b> or the compass and choose <b>Open in ${pf.ios ? "Safari" : "Chrome"}</b>, or copy this address into ${pf.ios ? "Safari" : "Chrome"}:<div class="i-url">thefalknersarmsgolfsociety.co.uk/app</div>`) +
        step(3, `Then tap <b>Show me</b> again for the last two steps.`);
    } else if (pf.ios) {
      steps = step(1, `Tap the <b>Share</b> button <span class="i-ico">${SHARE_ICON}</span> ${pf.iosOther ? "at the top right, by the address bar" : "at the bottom of Safari (at the top on an iPad)"}.`) +
        step(2, `Scroll down and tap <b>Add to Home Screen</b> <span class="i-ico">${ADD_ICON}</span>.`) +
        step(3, `Tap <b>Add</b>. The Falkners crest appears on your home screen — open it from there from now on.`);
    } else {
      steps = step(1, `Tap the <b>⋮</b> menu <span class="i-ico">${DOTS_ICON}</span> at the top right of Chrome.`) +
        step(2, `Tap <b>Install app</b> or <b>Add to Home screen</b>.`) +
        step(3, `Tap <b>Install</b>. The Falkners crest appears with your other apps — open it from there from now on.`);
    }
    openSheet(`
      <div class="i-head"><img src="icons/icon-192.png" alt=""><div><h2 style="margin:0">Falkners Golf</h2><div class="small muted">Add it to your home screen</div></div></div>
      ${!pf.ios ? `<button class="btn gold block" id="install-now" data-action="install-now" ${installEvent ? "" : "hidden"}>Install now</button>` : ""}
      <ol class="i-steps">${steps}</ol>
      <p class="small muted">You sign in once with your society website email and password. It works with patchy signal on the course, and scores you enter with no signal send when it's back.</p>
      <button class="btn ghost block" data-action="close-sheet">Done</button>`);
  }

  // ---------- loading a round ----------

  async function loadRound(eventId) {
    const [ev, setup, field, hcps, scores, manage, entries, subs, checks, claims, posts, stats, prizes, admins] = await Promise.all([
      client.from("events").select("*").eq("id", eventId).maybeSingle(),
      client.from("event_scoring").select("*").eq("event_id", eventId).maybeSingle(),
      client.rpc("scoring_field", { target: eventId }),
      client.from("event_handicaps").select("*").eq("event_id", eventId),
      client.from("hole_scores").select("player_id, hole, strokes, picked_up, updated_at, disputed, escalated, settled_by").eq("event_id", eventId),
      client.rpc("can_manage_round", { target: eventId }),
      client.from("score_entries").select("player_id, hole, entered_by, strokes, picked_up, updated_at").eq("event_id", eventId),
      client.from("card_submissions").select("player_id, submitted_by, submitted_at").eq("event_id", eventId),
      client.from("round_checkins").select("player_id, checked_in_by, checked_in_at").eq("event_id", eventId),
      // The extras below are tolerant: if one can't load, the round still opens.
      client.from("contest_claims").select("*").eq("event_id", eventId).order("created_at"),
      client.from("round_posts").select("*").eq("event_id", eventId).order("created_at", { ascending: false }).limit(150),
      client.from("hole_stats").select("player_id, hole, putts, fairway").eq("event_id", eventId),
      client.from("event_prizes").select("*").eq("event_id", eventId).maybeSingle(),
      client.rpc("round_admins", { p_event: eventId }),
    ]);
    // Check-ins are a nice-to-have: if they can't load, the round still opens.
    const err = ev.error || setup.error || field.error || hcps.error || scores.error || entries.error || subs.error;
    if (err) throw err;
    // Practice rounds and private games aren't in the public events list.
    if (!ev.data) { const g = await client.rpc("game_event", { target: eventId }); if (g.data && g.data[0]) ev.data = g.data[0]; }
    if (!ev.data) throw new Error("That round doesn't exist, or it's a private game you're not in.");

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
      claims: claims.error ? [] : claims.data || [],
      contestsOff: !!claims.error,
      posts: posts.error ? [] : posts.data || [],
      feedOff: !!posts.error,
      comments: [], likes: [],
      stats: new Map((stats.error ? [] : stats.data || []).map(x => [cellKey(x.player_id, x.hole), x])),
      prizes: prizes.error ? null : prizes.data,
      admins: admins.error ? null : admins.data || [],
      canManage: !!manage.data,
    };
    if (!r.feedOff && r.posts.length) {
      const ids = r.posts.map(p => p.id);
      const [cm, lk] = await Promise.all([
        client.from("round_post_comments").select("*").in("post_id", ids).order("created_at"),
        client.from("round_post_likes").select("post_id, profile_id").in("post_id", ids),
      ]);
      r.comments = cm.data || []; r.likes = lk.data || [];
    }
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
      .on("postgres_changes", { event: "*", schema: "public", table: "contest_claims", filter: `event_id=eq.${r.id}` }, payload => {
        if (!app.round || app.round.id !== r.id) return;
        const rr = app.round;
        if (payload.eventType === "DELETE") rr.claims = rr.claims.filter(c => c.id !== (payload.old || {}).id);
        else if (!rr.claims.some(c => c.id === payload.new.id)) rr.claims.push(payload.new);
        refreshRound(true);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "round_posts", filter: `event_id=eq.${r.id}` }, payload => {
        if (!app.round || app.round.id !== r.id) return;
        const rr = app.round;
        if (payload.eventType === "DELETE") rr.posts = rr.posts.filter(x => x.id !== (payload.old || {}).id);
        else { rr.posts = rr.posts.filter(x => x.id !== payload.new.id); rr.posts.unshift(payload.new); rr.posts.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))); }
        refreshRound(true);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "round_post_comments" }, payload => {
        if (!app.round) return;
        const rr = app.round;
        if (payload.eventType === "DELETE") rr.comments = rr.comments.filter(x => x.id !== (payload.old || {}).id);
        else if (rr.posts.some(p => p.id === payload.new.post_id) && !rr.comments.some(x => x.id === payload.new.id)) rr.comments.push(payload.new);
        refreshRound(true);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "round_post_likes" }, payload => {
        if (!app.round) return;
        const rr = app.round;
        const o = payload.old || {}, n = payload.new || {};
        if (payload.eventType === "DELETE") rr.likes = rr.likes.filter(x => !(x.post_id === o.post_id && x.profile_id === o.profile_id));
        else if (rr.posts.some(p => p.id === n.post_id) && !rr.likes.some(x => x.post_id === n.post_id && x.profile_id === n.profile_id)) rr.likes.push(n);
        refreshRound(true);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "hole_stats", filter: `event_id=eq.${r.id}` }, payload => {
        if (!app.round) return;
        const n = payload.eventType === "DELETE" ? null : payload.new, o = payload.old || {};
        if (n) app.round.stats.set(cellKey(n.player_id, n.hole), n); else if (o.player_id) app.round.stats.delete(cellKey(o.player_id, o.hole));
      })
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
      if (document.body.classList.contains("presenting")) { if (present.tv) { buildSlides(app.round); drawPresent(); } return; }
      // Don't redraw a form under somebody's thumbs.
      const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && view.contains(document.activeElement);
      if (app.round.tab !== "setup" && !typing) renderRoundBody();
      else updateFeedBadge();
    });
  }

  async function reloadRound(quiet) {
    if (!app.round) return;
    const keep = { hc: app.round.hc, wx: app.round.wx, tab: app.round.tab, hole: app.round.hole, board: app.round.board, groupKey: app.round.groupKey, gross: app.round.gross, editHcp: app.round.editHcp, arrived: app.round.arrived, openComments: app.round.openComments };
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
    const preview = r.setup && r.setup.status === "setup" && !r.canManage;
    r.tab = prefs.tab || ((live || preview) && r.me ? "score" : r.setup ? "board" : (r.canManage ? "setup" : "board"));
    if (app.guest && !["score", "board", "pairs"].includes(r.tab)) r.tab = "score";
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
    // A played round the app didn't score (results typed in on the
    // website): show the results, like the website's results page.
    if (r.event.event_date <= londonToday() && !Object.keys(r.scores).length) {
      const { data: res } = await client.from("results").select("player_id, points, gross_score, handicap, players(name, profile_id)").eq("event_id", eventId);
      if (res && res.length) { r.results = res; r.tab = "results"; }
    }
    app.round = r;
    subscribe(r);
    renderRoundBody();
    // A finished round's handicaps are worked out the first time the
    // committee opens it, whichever tab they're on.
    if (app.committee && r.setup && r.setup.status === "final" && !r.event.is_practice && !r.hc) loadHcReview(r);
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
    if (r.pairs && r.pairs.length) tabs.push(["pairs", "Pairs"]);
    if (!r.feedOff && !app.guest && (r.me || r.canManage)) tabs.push(["feed", "Feed"]);
    if (r.canManage) tabs.push(["setup", "Setup"]);
    if (r.tab === "feed") store.set("feed-seen-" + r.id, r.posts[0] ? r.posts[0].created_at : "");
    if (r.results && r.tab === "results") {
      hideTabbar();
      view.innerHTML = `
      <div class="round-head">
        <a class="back-link" href="#/" aria-label="All rounds">‹ Rounds</a>
        <div class="row"><h1>${esc(r.event.name)}</h1><span class="spacer"></span><span class="badge final">Final</span></div>
        <div class="muted small">${esc(r.event.venue || "")} · ${fmtDate(r.event.event_date)}</div>
      </div>${resultsView(r)}`;
      return;
    }
    view.innerHTML = `
      <div class="round-head">
        <a class="back-link" href="#/" aria-label="All rounds">‹ Rounds</a>
        <div class="row"><h1>${esc(r.event.name)}</h1><span class="spacer"></span>${r.event.is_practice ? '<span class="badge practice">Practice</span>' : r.event.is_private ? '<span class="badge private">Private</span>' : ""}${badge}</div>
        <div class="muted small">${esc(r.course ? r.course.name : r.event.venue || "")}${r.tee ? " · " + esc(r.tee.name) + " tees" : ""} · ${fmtDate(r.event.event_date)}</div>
        ${r.event.is_practice ? `<div class="practice-banner">Practice round — nothing here counts. It doesn't reach the website, the Order of Merit, records or handicaps.</div>` : ""}
        ${r.event.is_private && !app.guest ? `<div class="practice-banner private-banner">Private game${r.event.private_visible ? " · all members can see it" : " · only the players can see it"}. It never counts for the Order of Merit or handicaps; your result goes on your profile.</div>` : ""}
        ${app.guest ? `<div class="practice-banner private-banner">You're a guest in this game until the end of the day. Tap a box to put a score in.</div>` : ""}
        ${r.tab === "score" || r.tab === "setup" ? `<div id="wx-slot">${r.wx ? weatherChip(r.wx) : ""}</div>` : ""}
      </div>
      <div id="round-body" class="${r.anim ? "anim-" + r.anim : ""}"></div>`;
    r.anim = null;
    if (r.wx === undefined && window.FalknersWeather) {
      r.wx = null;
      window.FalknersWeather.forRound({ venue: r.course ? r.course.name : r.event.venue, date: r.event.event_date, time: r.event.tee_time,
        lat: r.course && r.course.lat, lng: r.course && r.course.lng }).then(f => {
        if (!f || !app.round || app.round.id !== r.id) return;
        app.round.wx = f; r.wx = f;
        const slot = document.getElementById("wx-slot");
        if (slot) slot.innerHTML = weatherChip(f);
      }).catch(() => {});
    }
    showTabbar(tabs.map(([k, l]) => `<button role="tab" data-action="tab" data-tab="${k}" aria-selected="${r.tab === k}">${TAB_ICONS[k]}<span>${l}</span>${k === "feed" ? `<i class="tab-badge" id="feed-badge" hidden></i>` : ""}</button>`).join(""));
    updateFeedBadge();
    const body = $("#round-body");
    if (r.tab === "score") {
      body.innerHTML = scoreView(r);
      if (store.get("gps-on", false) && r.geo && r.geo.size && window.HoleMaps) window.HoleMaps.startGps();
    }
    else if (r.tab === "setup" && r.canManage) { body.innerHTML = setupView(r); wireSetup(r); }
    else if (r.tab === "pairs" && r.pairs.length) body.innerHTML = notReady(r) || pairsTable(r);
    else if (r.tab === "feed" && !r.feedOff) body.innerHTML = feedView(r);
    else body.innerHTML = boardView(r);
  }

  const icon = d => `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const TAB_ICONS = {
    score: icon('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>'),
    board: icon('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 6h3a3 3 0 0 1-3 4M7 6H4a3 3 0 0 0 3 4"/>'),
    pairs: icon('<circle cx="8.5" cy="8" r="3"/><circle cx="16" cy="9" r="2.5"/><path d="M3 20c0-3 2.5-5.5 5.5-5.5S14 17 14 20M14.5 14.6c2.8-.4 5.5 1.6 5.5 5.4"/>'),
    feed: icon('<path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12h5"/>'),
    setup: icon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  };

  // The main menu along the bottom of every screen outside a round, with
  // the + button for the things people do most.
  const MAIN_ICONS = {
    play: icon('<path d="M7 21V3l10 4-10 4"/><path d="M4 21h8"/>'),
    season: icon('<path d="M4 6h16M4 12h16M4 18h10"/><circle cx="19" cy="18" r="1.5"/>'),
    records: icon('<circle cx="12" cy="9" r="6"/><path d="M8.5 14 7 21l5-3 5 3-1.5-7"/>'),
    me: icon('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>'),
  };
  function mainTabbar(active) {
    const tabs = [["play", "Play", "#/"], ["season", "Order of Merit", "#/season"], ["records", "Records", "#/records"], ["me", "Profile", "#/me"]];
    showTabbar(tabs.map(([k, l, h]) => `<button role="tab" data-action="main-tab" data-href="${h}" aria-selected="${active === k}">${MAIN_ICONS[k]}<span>${l}</span></button>`).join(""));
    $("#fab").hidden = false;
  }

  function fabSheet() {
    const item = (action, title, sub, ico) => `<button type="button" class="fab-item" data-action="${action}"><span class="fab-ico">${ico}</span><span><b>${title}</b><small>${sub}</small></span></button>`;
    openSheet(`<h2>Quick actions</h2><div class="fab-list">
      ${item("private-new", "New private game", "You and up to 3 others: members or friends", MAIN_ICONS.play)}
      ${item("fab-checkin", "Check in for today's round", "Open today's society round", icon('<path d="M5 12l5 5L20 7"/>'))}
      ${app.committee ? item("practice-new", "Practice round", "Committee: try the app out, nothing counts", icon('<path d="M4 20h16M7 16l4-12 3 8 2-4 3 8"/>')) : ""}
      ${item("fab-bag", "Add to my bag", "A club, glove, shoes or ball", icon('<path d="M14 3 11 15"/><path d="M11 15 5 19c-1 1 0 2 1 2h6c1 0 2-1 1-2z"/>'))}
      ${item("fab-register", "Register for the next round", "Enter on the website", icon('<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>'))}
      ${item("fab-post", "Post to the round feed", "A photo or comment on the live round", TAB_ICONS.feed)}
      ${item("fab-course", "Add a course", "Name and address, then the scorecard", icon('<path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>'))}
    </div><button class="btn ghost block" style="margin-top:10px" data-action="close-sheet">Close</button>`);
  }

  // The society round to check in for: today's, else the next one set up.
  async function fabRound(liveOnly) {
    const today = londonToday();
    const [{ data: evs }, { data: sc }] = await Promise.all([
      client.from("events").select("id, name, event_date").order("event_date"),
      client.from("event_scoring").select("event_id, status"),
    ]);
    const st = new Map((sc || []).map(x => [x.event_id, x.status]));
    const list = (evs || []).filter(e => st.has(e.id));
    if (liveOnly) return list.find(e => st.get(e.id) === "live");
    return list.find(e => e.event_date === today) || list.find(e => e.event_date > today);
  }

  function showTabbar(html) {
    const bar = $("#tabbar");
    if ($("#fab")) $("#fab").hidden = true;
    bar.innerHTML = html;
    bar.hidden = false;
    document.body.classList.add("has-tabbar");
  }
  function hideTabbar() {
    $("#tabbar").hidden = true;
    if ($("#fab")) $("#fab").hidden = true;
    document.body.classList.remove("has-tabbar");
  }

  // A tiny tap on phones that support it, so a score feels entered.
  function buzz(ms) { if (navigator.vibrate) { try { navigator.vibrate(ms || 10); } catch (e) { /* not supported */ } } }

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
    // Before the committee publishes it, players see a preview of the round.
    if (r.setup.status === "setup" && !r.canManage) return ci + previewView(r);
    if (!canScore(r)) {
      const why = r.setup.status === "final" ? "This round is finished — scores are locked."
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
      return ci + picker + `<div class="card empty"><p>Choose the group you're marking for, or just your own card.</p>
        <p class="small muted">One phone can score the whole group — nobody else needs the app. If two phones put in different numbers, everyone's told and it's flagged to agree.</p></div>`;
    }
    const next = nextHole(r, players);
    r.gpsHole = next;
    return `
      ${ci}
      ${picker}
      ${groupBoard(r, players)}
      ${disputeBanner(r, players)}
      ${contestsCard(r)}
      ${gpsBar(r, next)}
      ${scoreGrid(r, players)}
      <div class="grid-actions">
        <button class="btn gold block" data-action="review-cards">Review &amp; submit cards</button>
      </div>`;
  }

  // The first hole the group hasn't finished: where they are on the course.
  function nextHole(r, players) {
    const h = r.holes.find(x => players.some(p => !hasScore(p, x.hole)));
    return h ? h.hole : r.holes.length;
  }

  // The group's own mini leaderboard at the top of the card, with the
  // way through to the whole field and the pairs.
  function groupBoard(r, players) {
    const rows = players.map(p => ({ p, sum: S.summarise(r.holes, p.scores, p.ph) }));
    const circ = (v, cls) => `<span class="gb-c ${cls || ""}">${v}</span>`;
    const tp = n => n == null ? "–" : n === 0 ? "E" : n > 0 ? "+" + n : String(n);
    const tpc = n => n == null || n === 0 ? "" : n < 0 ? "under" : "over";
    const live = r.setup && r.setup.status === "live";
    const label = r.groupKey === "me" ? "Your card" : r.groupKey && r.groupKey.startsWith("g") ? "Group " + r.groupKey.slice(1) : "Your players";
    return `<div class="card group-board">
      <div class="gb-head">
        <span class="gb-title">${esc(label)}${live ? ' <span class="gb-live"><i></i>live</span>' : ""}</span>
        <span>HCP</span><span>Thru</span><span>Gross</span><span>Net</span><span>Pts</span>
      </div>
      ${rows.map(({ p, sum }) => `
        <button class="gb-row${r.me && p.id === r.me.id ? " me" : ""}" data-action="open-card" data-player="${p.id}">
          <span class="gb-name">${avatar(p.name, p.profileId, r.me && p.id === r.me.id ? "me" : "")}<b>${esc(shortName(p.name))}</b>${flags(r, p)}</span>
          <span class="gb-n">${p.ph == null ? "?" : p.ph}</span>
          <span class="gb-n">${sum.thru}</span>
          ${circ(sum.pickups ? "NR" : tp(sum.thru ? sum.grossToPar : null), "dark")}
          ${circ(sum.pickups ? "NR" : tp(sum.thru ? sum.netToPar : null), sum.pickups ? "dark" : tpc(sum.thru ? sum.netToPar : null) || "dark")}
          ${circ(sum.points, "pts")}
        </button>`).join("")}
      <div class="gb-links">
        <button class="btn ghost" data-action="tab" data-tab="board">Full leaderboard ›</button>
        ${r.pairs && r.pairs.length ? `<button class="btn ghost" data-action="tab" data-tab="pairs">Pairs ›</button>` : ""}
      </div>
    </div>`;
  }

  // The whole card on one screen, Golfify style: a row per hole and a
  // column per player. Tap a cell to put the score in.
  function scoreGrid(r, players) {
    const gaps = missingHoles(r, players);
    const cols = `grid-template-columns: 30px 40px 36px 30px repeat(${players.length}, minmax(0, 1fr));`;
    const teeDot = `<span class="tee-dot" style="background:${esc((r.tee && r.tee.colour) || "#f2c94c")}" title="${esc(r.tee ? r.tee.name : "")} tees"></span>`;
    const head = `<div class="sg-row sg-head" style="${cols}">
      ${teeDot}<span>Yds</span><span>SI</span><span>Par</span>
      ${players.map(p => `<span class="sg-who">${avatar(p.name, p.profileId, r.me && p.id === r.me.id ? "me" : "")}</span>`).join("")}
    </div>`;
    const sums = players.map(p => S.summarise(r.holes, p.scores, p.ph));
    const row = h => `<div class="sg-row${gaps.has(h.hole) ? " gap" : ""}" style="${cols}">
      <span class="sg-hole">${h.hole}${contestsOnHole(r, h.hole).map(c => `<i class="sg-tag" title="${esc(c.label)}">${c.id.startsWith("ld") ? "LD" : c.id.startsWith("np2") ? "N2" : "NP"}</i>`).join("")}</span>
      <span class="sg-yds">${h.yards || ""}</span>
      <span class="sg-si">${h.stroke_index}</span>
      <span class="sg-par">${h.par}</span>
      ${players.map((p, i) => {
        const sc = p.scores[h.hole];
        const x = sums[i].holes[h.hole];
        const shots = x.shots;
        const dots = shots > 0 ? `<span class="sg-shots">${"•".repeat(Math.min(shots, 3))}</span>` : shots < 0 ? `<span class="sg-shots minus">+</span>` : "";
        let cls = "sg-cell", txt = "+";
        if (x.played) {
          cls += " set";
          if (x.picked_up) { cls += " pu"; txt = "P"; }
          else { const d = x.strokes - h.par; cls += d < 0 ? " under" : d > 0 ? " over" : " par"; txt = x.strokes; }
        }
        if (sc && sc.disputed) cls += " disputed";
        if (locked(r, p.id)) cls += " locked";
        return `<button class="${cls}" data-action="cell" data-player="${p.id}" data-hole="${h.hole}" aria-label="${esc(p.name)}, hole ${h.hole}: ${x.played ? (x.picked_up ? "pick-up" : x.strokes) : "no score"}">
          ${dots}<span class="sg-val">${txt}</span>${x.played ? `<span class="sg-pts">${x.points}</span>` : ""}</button>`;
      }).join("")}
    </div>`;
    const nine = (from, to) => r.holes.slice(from, to);
    const tot = (label, hs, f) => `<div class="sg-row sg-tot" style="${cols}">
      <span class="sg-label">${label}</span>
      ${players.map((p, i) => `<span class="sg-tv">${f(sums[i], hs)}</span>`).join("")}
    </div>`;
    const grossOf = (sm, hs) => { let t = 0, any = false; hs.forEach(h => { const x = sm.holes[h.hole]; if (x.played && !x.picked_up) { t += x.strokes; any = true; } }); return any ? t : "–"; };
    const ptsOf = (sm, hs) => hs.reduce((t, h) => t + (sm.holes[h.hole].played ? sm.holes[h.hole].points : 0), 0);
    const front = nine(0, 9), back = nine(9, 18);
    return `<div class="card score-grid">
      <div class="sg-sticky">${head}</div>
      ${front.map(row).join("")}
      ${tot("Out", front, (sm, hs) => `${grossOf(sm, hs)}<small>${ptsOf(sm, hs)} pts</small>`)}
      ${back.map(row).join("")}
      ${tot("In", back, (sm, hs) => `${grossOf(sm, hs)}<small>${ptsOf(sm, hs)} pts</small>`)}
      ${tot("Gross", r.holes, (sm) => sm.pickups ? "NR" : sm.thru ? sm.gross : "–")}
      ${tot("Points", r.holes, (sm) => `<b>${sm.points}</b>`)}
      <p class="small muted sg-key">Tap a box to enter a score · dots are shots received · small number is points</p>
    </div>`;
  }

  // The big number pad for one player on one hole.
  function keypadSheet(r, playerId, hole) {
    const p = r.players.find(x => x.id === playerId);
    const h = r.holes.find(x => x.hole === hole);
    if (!p || !h) return;
    if (locked(r, p.id)) { toast("That card's been submitted — ask the committee to change it.", true); return; }
    if (!canScore(r)) { toast("Scoring isn't open on this round.", true); return; }
    const st = r.stats.get(cellKey(playerId, hole)) || {};
    r.kp = { player: playerId, hole, pending: null, putts: st.putts != null ? st.putts : null, fairway: st.fairway || null };
    const statsOn = store.get("stats-on", false);
    const shots = S.shotsOnHole(p.ph, h.stroke_index, 18);
    const sc = p.scores[hole];
    const mine = myEntry(r, p.id, hole);
    const cur = mine ? (mine.picked_up ? "P" : mine.strokes) : sc ? (sc.picked_up ? "P" : sc.strokes) : null;
    const keys = [];
    for (let v = 1; v <= 12; v++) {
      const d = v - h.par;
      keys.push(`<button class="kp-key ${d < 0 ? "k-under" : d > 0 ? "k-over" : "k-par"}${cur === v ? " on" : ""}" data-action="kp" data-val="${v}">${v}<small>${d === -2 ? "Eagle" : d === -1 ? "Birdie" : d === 0 ? "Par" : d === 1 ? "Bogey" : d === 2 ? "Double" : ""}</small></button>`);
    }
    openSheet(`
      <div class="kp-title">${esc(p.name)} – Hole ${hole}</div>
      <div class="kp-facts">Par ${h.par} · SI ${h.stroke_index}${h.yards ? ` · ${h.yards} yds` : ""} · ${shots > 0 ? `<b>${shots} shot${shots > 1 ? "s" : ""}</b>` : shots < 0 ? "<b>gives a shot back</b>" : "no shot"}</div>
      ${sc && sc.disputed ? `<div class="kp-dispute">${disputeBox(r, p, hole)}</div>` : ""}
      <div class="kp-grid${statsOn ? " compact" : ""}">${keys.join("")}
        <button class="kp-key k-pu${cur === "P" ? " on" : ""}" data-action="kp" data-val="P">P/U<small>Pick up</small></button>
        <button class="kp-key k-clear" data-action="kp-clear" ${mine ? "" : "disabled"}>Clear</button>
        <button class="kp-key k-ok" data-action="kp-ok" aria-label="Confirm score" ${cur == null ? "disabled" : ""}>✓</button>
      </div>
      ${statsOn ? `<div class="kp-stats">
        <div class="kps-row"><span>Putts</span>${[0, 1, 2, 3, 4].map(n => `<button class="kps-chip${r.kp.putts === n ? " on" : ""}" data-action="kp-putts" data-val="${n}">${n === 4 ? "4+" : n}</button>`).join("")}</div>
        ${h.par >= 4 ? `<div class="kps-row"><span>Fairway</span>${[["left", "← Left"], ["hit", "Hit"], ["right", "Right →"]].map(([k, l]) => `<button class="kps-chip wide${r.kp.fairway === k ? " on" : ""}" data-action="kp-fw" data-val="${k}">${l}</button>`).join("")}</div>` : ""}
      </div>` : ""}
      <button class="mv-link kp-stats-toggle" data-action="kp-stats-toggle">${statsOn ? "Hide putts & fairways" : "Add putts & fairways (optional)"}</button>`);
    r.kp.pending = cur;
  }

  const warnedGaps = new Set();

  // Putts and fairways are optional and separate from the score, so a
  // missing one never holds a card up.
  async function saveHoleStats(r, playerId, hole, putts, fairway) {
    const key = cellKey(playerId, hole);
    if (putts == null && fairway == null) {
      r.stats.delete(key);
      await client.from("hole_stats").delete().eq("event_id", r.id).eq("player_id", playerId).eq("hole", hole);
      return;
    }
    const row = { event_id: r.id, player_id: playerId, hole, putts, fairway, entered_by: app.user.id, updated_at: new Date().toISOString() };
    r.stats.set(key, row);
    const { error } = await client.from("hole_stats").upsert(row, { onConflict: "event_id,player_id,hole" });
    if (error) toast("Putts and fairway didn't save: " + error.message, true);
  }

  // After a score: on to the next player on this hole, then close.
  function afterKeypad(r, playerId, hole) {
    const players = selectedPlayers(r);
    const idx = players.findIndex(p => p.id === playerId);
    const nextP = players.slice(idx + 1).find(p => !hasScore(p, hole) && !locked(r, p.id));
    if (nextP) { keypadSheet(r, nextP.id, hole); return; }
    closeSheet();
    // Walking off a contest hole: who's in front? Asked once per group.
    const cs = contestsOnHole(r, hole).filter(c => !confirmedOf(r, c));
    if (cs.length && players.every(p => hasScore(p, hole)) && r.setup && r.setup.status === "live") {
      const k = `stake-asked-${r.id}-${r.groupKey}-${cs[0].id}`;
      if (!store.get(k, false)) { store.set(k, true); stakeSheet(r, cs[0].id, true); return; }
    }
    // A hole behind with somebody missing? Say so once, with the way back.
    const gaps = [...missingHoles(r, players)].filter(x => x < hole);
    const key = gaps.join(",");
    if (gaps.length && !warnedGaps.has(r.id + key)) {
      warnedGaps.add(r.id + key);
      const g = gaps[0];
      const who = players.filter(p => !hasScore(p, g));
      missingSheet(r, who, g, null);
    }
  }

  // "Anthony Dunn" -> "Anthony D." so names fit beside the figures.
  function shortName(name) {
    const w = String(name || "").trim().split(/\s+/);
    return w.length > 1 ? `${w[0]} ${w[w.length - 1][0]}.` : w[0] || "";
  }

  // Profile pictures from the website, by account. Cached on the phone
  // so they show with no signal.
  app.avatars = new Map(Object.entries(store.get("avatars", {})));
  async function loadAvatars() {
    const { data, error } = await client.rpc("member_directory");
    if (error || !data) return;
    const m = {};
    data.forEach(x => { if (x.avatar_url) m[x.id] = x.avatar_url; });
    app.avatars = new Map(Object.entries(m));
    store.set("avatars", m);
  }
  function avatar(name, profileId, cls) {
    const url = profileId && app.avatars.get(profileId);
    return `<span class="avatar${cls ? " " + cls : ""}${url ? " has-img" : ""}">${url ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.parentNode.classList.remove('has-img');this.remove()">` : ""}<i>${initials(name)}</i></span>`;
  }

  function initials(name) {
    const w = String(name || "?").trim().split(/\s+/);
    return esc(((w[0] || "?")[0] + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase());
  }

  const hasScore = (p, hole) => { const s = p.scores[hole]; return !!s && (s.strokes != null || s.picked_up); };

  // Holes behind where the group has got to that someone hasn't got a
  // score on yet: marked on the strip until they're filled in.
  function missingHoles(r, players) {
    const furthest = Math.max(0, ...players.flatMap(p => r.holes.filter(h => hasScore(p, h.hole)).map(h => h.hole)));
    const out = new Set();
    r.holes.forEach(h => { if (h.hole < furthest && players.some(p => !hasScore(p, h.hole))) out.add(h.hole); });
    return out;
  }

  // Moving on with a score missing: say who, and let them go back or carry on.
  function missingSheet(r, players, hole) {
    buzz([120, 60, 120]);
    const names = players.map(p => esc(p.name));
    openSheet(`
      <h2>No score on hole ${hole}</h2>
      <p>${names.length === 1 ? `<b>${names[0]}</b> hasn't` : `<b>${names.slice(0, -1).join(", ")}</b> and <b>${names[names.length - 1]}</b> haven't`} got a score on hole ${hole} yet.</p>
      <p class="small muted">The hole stays marked in red until it's filled in. Every hole needs a score or a pick-up before the card can be submitted.</p>
      <button class="btn block" data-action="cell" data-player="${players[0] ? players[0].id : ""}" data-hole="${hole}">Go back to hole ${hole}</button>
      <button class="btn ghost block" style="margin-top:8px" data-action="close-sheet">Carry on</button>`);
  }

  function locked(r, playerId) {
    return r.submitted.has(playerId) && !r.canManage;
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
    buzz();
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
    const mapped = g && g.green_lat != null && g.tee_lat != null;
    if (!mapped) {
      return app.committee && r.course
        ? `<div class="gps-bar muted small">Hole ${hole} isn't on the map yet. <a href="#/course-map/${r.course.id}">Map the holes</a></div>` : "";
    }
    const on = store.get("gps-on", false);
    return `<div class="gps-bar">
      <span class="gps-hole">Hole ${hole}</span>
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
    if (d.front != null || d.back != null) {
      return `<span class="fcb">${d.front != null ? `<span><small>F</small>${d.front}</span>` : ""}<span class="m"><small>Mid</small><b>${d.yards}</b></span>${d.back != null ? `<span><small>B</small>${d.back}</span>` : ""}</span>${clubTip(d.yards)}`;
    }
    return `<b>${d.yards}</b> yds <span class="small muted">to the middle · ±${d.acc}</span>${clubTip(d.yards)}`;
  }

  // Keep the yardage ticking over without redrawing the whole screen.
  if (window.HoleMaps) {
    window.HoleMaps.onGps(() => {
      const el = document.getElementById("gps-yds");
      if (el && app.round && store.get("gps-on", false)) el.innerHTML = gpsText(app.round, app.round.gpsHole || app.round.hole);
    });
  }

  // ---------- preview, before the round is published ----------

  function previewView(r) {
    const me = r.me;
    const par = parTotal(r);
    const card = (from, to, label) => {
      const hs = r.holes.slice(from, to);
      const shots = h => me ? S.shotsOnHole(me.ph, h.stroke_index, 18) : 0;
      return `<table class="sc">
        <tr><th>Hole</th>${hs.map(h => `<th style="text-align:center">${h.hole}</th>`).join("")}<th class="tot">${label}</th></tr>
        <tr><th>Par</th>${hs.map(h => `<td>${h.par}</td>`).join("")}<td class="tot">${hs.reduce((t, h) => t + h.par, 0)}</td></tr>
        <tr><th>SI</th>${hs.map(h => `<td>${h.stroke_index}</td>`).join("")}<td class="tot"></td></tr>
        <tr><th>Yds</th>${hs.map(h => `<td class="small">${h.yards || ""}</td>`).join("")}<td class="tot small">${hs.reduce((t, h) => t + (h.yards || 0), 0) || ""}</td></tr>
        ${me ? `<tr><th>Shots</th>${hs.map(h => { const n = shots(h); return `<td><b>${n > 0 ? "•".repeat(Math.min(n, 3)) : n < 0 ? "+" : ""}</b></td>`; }).join("")}<td class="tot">${hs.reduce((t, h) => t + shots(h), 0)}</td></tr>` : ""}
      </table>`;
    };
    const groups = groupsOf(r);
    return `
      <div class="card preview-banner">
        <strong>Preview</strong>
        <p class="small" style="margin:4px 0 0">Scoring opens when the committee publishes the round${isToday(r) ? " — usually just before the first tee" : ""}.
        Until then, here's the card${me ? " with your shots" : ""}, the groups and everyone's playing handicap.</p>
      </div>
      <div class="card">
        <h2 style="margin-bottom:2px">${esc(r.course ? r.course.name : r.event.venue || "")}</h2>
        <p class="small muted" style="margin-top:0">${r.tee ? esc(r.tee.name) + " tees · " : ""}Par ${par}${r.tee && r.tee.slope ? ` · Slope ${r.tee.slope}` : ""}${r.tee && r.tee.course_rating ? ` · CR ${r.tee.course_rating}` : ""}</p>
        ${me ? `<p style="margin:6px 0 10px">You play off <b>${me.ph == null ? "?" : me.ph}</b>${me.ch != null ? ` <span class="muted small">(course handicap ${me.ch}, ${esc(String(r.setup.allowance))}%)</span>` : ""}. A dot is a shot on that hole.</p>` : ""}
        <div class="sc-wrap preview-sc">${card(0, 9, "Out")}</div>
        <div class="sc-wrap preview-sc" style="margin-top:8px">${card(9, 18, "In")}</div>
      </div>
      <div class="card">
        <h2>${groups.length ? "Tee groups" : "Who's playing"}</h2>
        ${groups.length ? groups.map(([n, ps]) => `
          <div class="preview-group${me && me.group === n ? " mine" : ""}"><div class="small muted">Group ${n}${me && me.group === n ? " — yours" : ""}</div>
            ${ps.map(p => `<div class="row"><span>${esc(p.name)}</span><span class="spacer"></span><span class="small">plays off <b>${p.ph == null ? "?" : p.ph}</b></span></div>`).join("")}</div>`).join("")
          : r.players.map(p => `<div class="row"><span>${esc(p.name)}</span><span class="spacer"></span><span class="small">plays off <b>${p.ph == null ? "?" : p.ph}</b></span></div>`).join("")}
        ${r.pairs && r.pairs.length ? `<p class="small" style="margin:10px 0 0"><a href="#" data-action="tab" data-tab="pairs">See the pairs →</a></p>` : ""}
      </div>`;
  }

  // ---------- checking in on the day ----------

  const isToday = r => r.event.event_date === londonToday();

  // Who this phone can check in: your tee group (or everyone, before the
  // draw is set). The committee checks people in from Setup as well.
  function checkinGroup(r) {
    if (!r.me) return r.canManage ? selectedPlayers(r) : [];
    if (r.me.group == null) {
      const drawSet = r.players.some(p => p.group != null);
      return drawSet ? [r.me] : r.players;
    }
    return r.players.filter(p => p.group === r.me.group);
  }

  function checkinCard(r) {
    const open = isToday(r) || (!!r.setup && r.event.event_date > londonToday());
    if (r.checkinsOff || !open || (r.setup && r.setup.status === "final")) return "";
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
    // Once scoring's open and you're in, keep it to one line so the card
    // and hole strip stay on screen; the rest of the group is a tap away.
    if (r.setup && r.setup.status === "live" && me && r.checkins.has(me.id) && !r.showCheckin) {
      return `<div class="card small row checkin-done"><span class="tick">✓</span>
        <span>You're checked in · ${here.length} of ${group.length} in ${esc(label.toLowerCase())}</span>
        <span class="spacer"></span><button class="mv-link" data-action="show-checkin">Check in others</button></div>`;
    }
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
      <p class="small" style="margin:0"><b>${here.length} of ${r.players.length}</b> checked in${today ? "" : " — players can check in from the app once the round's set up, or on the day"}.</p>
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
    const canEdit = editing && r.canManage;
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
      if (r.canManage) {
        actions.push(`<button class="btn ghost block" style="margin-top:8px" data-action="edit-card" data-player="${p.id}">Change scores (${app.committee ? "committee" : "round admin"})</button>`);
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
      ${actions.join("")}
      ${sum.thru ? `<button class="btn ghost block" style="margin-top:8px" data-action="share-card" data-player="${p.id}">Share this card</button>` : ""}`);
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



  // ---------- round admins ----------
  // When the committee can't be there, they hand one player the running
  // of this round: setup, publishing, disputes, cards, contests and
  // results — for this fixture only. Handicaps stay with the committee.

  function adminsCard(r) {
    if (r.admins == null) return "";
    const list = r.admins;
    const candidates = r.players.filter(p => p.profileId && !list.some(a => a.profile_id === p.profileId));
    return `<div class="card">
      <h2>Round admins</h2>
      <p class="small muted" style="margin-top:0">Can't be there? Make a player the admin for this round. They can set it up, publish it, settle disputes, change and reopen cards, confirm the side contests and finish it into Results — for this round only. Handicaps stay with the committee.</p>
      ${list.length ? list.map(a => `<div class="row checkin-row">${avatar(a.name, a.profile_id)}<b>${esc(a.name)}</b><span class="spacer"></span>
          ${app.committee ? `<button class="btn ghost" style="min-height:34px" data-action="remove-admin" data-profile="${a.profile_id}">Remove</button>` : ""}</div>`).join("")
        : `<p class="small" style="margin:0 0 6px">No round admin — the committee runs it.</p>`}
      ${app.committee && candidates.length ? `<div class="row" style="margin-top:8px;gap:8px">
          <select id="admin-pick" style="flex:1;min-height:42px;border:1.5px solid var(--line);border-radius:8px;padding:0 8px;background:#fff">
            <option value="">Choose a player…</option>${candidates.map(p => `<option value="${p.profileId}">${esc(p.name)}</option>`).join("")}
          </select>
          <button class="btn gold" style="min-height:42px" data-action="add-admin">Make admin</button></div>
        <p class="small muted" style="margin:6px 0 0">Only players with a website account can be made admin.</p>` : ""}
    </div>`;
  }

  async function addAdmin(r) {
    const pid = $("#admin-pick") && $("#admin-pick").value;
    if (!pid) { toast("Choose a player first.", true); return; }
    const { error } = await client.from("moderator_grants").insert({ profile_id: pid, event_id: r.id, granted_by: app.user.id });
    if (error) { toast(error.message, true); return; }
    const p = r.players.find(x => x.profileId === pid);
    toast(`${p ? p.name : "They"} can now run ${r.event.name}`);
    await reloadRound();
  }

  async function removeAdmin(r, profileId) {
    const { error } = await client.from("moderator_grants").delete().eq("event_id", r.id).eq("profile_id", profileId);
    if (error) { toast(error.message, true); return; }
    toast("Round admin removed");
    await reloadRound();
  }





  // ---------- Ryder Cup ----------
  // Two teams, sessions of fourballs, foursomes and singles, match play
  // with shots off the lowest handicap in each match (75% playing
  // handicaps; foursomes pairs play off half their combined handicap).
  // 1 point for a win, ½ each for a half.

  const RC_FORMATS = { fourball: "Fourballs", foursome: "Foursomes", single: "Singles" };
  const rcPerSide = f => f === "single" ? 1 : 2;
  const rc = { data: null, tab: "matches", channel: null };
  const RC_QUEUE = "falkners-rc-queue";

  async function loadRyder(eventId) {
    const [ev, cup, team, sessions, matches, pls, manage, att] = await Promise.all([
      client.from("events").select("*").eq("id", eventId).maybeSingle(),
      client.from("rc_cups").select("*").eq("event_id", eventId).maybeSingle(),
      client.from("rc_players").select("player_id, side, captain").eq("event_id", eventId),
      client.from("rc_sessions").select("*").eq("event_id", eventId).order("position"),
      client.from("rc_matches").select("*").eq("event_id", eventId).order("match_no"),
      client.from("players").select("id, name, handicap, profile_id, active"),
      client.rpc("can_manage_round", { target: eventId }),
      client.from("attendance").select("profile_id, player_id, status").eq("event_id", eventId),
    ]);
    if (ev.error) throw ev.error;
    if (!ev.data) throw new Error("That fixture doesn't exist.");
    if (cup.error) throw new Error("The Ryder Cup tables aren't set up in the database yet.");
    // Before the captains update, fall back to the teams without them.
    if (team.error) Object.assign(team, await client.from("rc_players").select("player_id, side").eq("event_id", eventId));
    const d = {
      id: eventId, event: ev.data, cup: cup.data, canManage: !!manage.data,
      team: new Map((team.data || []).map(t => [t.player_id, t.side])),
      sessions: sessions.data || [], matches: matches.data || [],
      players: pls.data || [], scores: new Map(), tees: new Map(), allTees: [],
      onTrip: new Set(),
      captains: new Set((team.data || []).filter(t => t.captain).map(t => t.player_id)),
      captainsOn: !!(team.data || []).length && "captain" in ((team.data || [])[0] || {}),
    };
    const mineIds = new Set(d.players.filter(p => p.profile_id && app.user && p.profile_id === app.user.id).map(p => p.id));
    const capt = [...d.captains].find(id => mineIds.has(id));
    d.captainSide = capt ? d.team.get(capt) : null;
    const playersByProfile = new Map(d.players.filter(p => p.profile_id).map(p => [p.profile_id, p.id]));
    (att.data || []).filter(a => !a.status || a.status === "playing").forEach(a => {
      const pid = a.player_id || playersByProfile.get(a.profile_id);
      if (pid) d.onTrip.add(pid);
    });
    const ids = d.matches.map(m => m.id);
    if (ids.length) {
      const { data: sc } = await client.from("rc_scores").select("*").in("match_id", ids);
      (sc || []).forEach(s => rcApplyScore(d, s));
    }
    rcOverlayQueue(d);
    const teeIds = [...new Set(d.sessions.map(s => s.tee_id).filter(Boolean))];
    if (teeIds.length) {
      const [t, h] = await Promise.all([
        client.from("course_tees").select("*, courses(*)").in("id", teeIds),
        client.from("course_holes").select("*").in("tee_id", teeIds).order("hole"),
      ]);
      (t.data || []).forEach(tee => d.tees.set(tee.id, { tee, holes: (h.data || []).filter(x => x.tee_id === tee.id) }));
    }
    return d;
  }

  function rcApplyScore(d, s) {
    if (!d.scores.has(s.match_id)) d.scores.set(s.match_id, {});
    const m = d.scores.get(s.match_id);
    if (!m[s.player_id]) m[s.player_id] = {};
    if (s._delete) delete m[s.player_id][s.hole];
    else m[s.player_id][s.hole] = { strokes: s.strokes, picked_up: !!s.picked_up, entered_by: s.entered_by };
  }

  // Scores entered with no signal wait on the phone, like normal rounds.
  function rcQueue() { return store.get(RC_QUEUE, []); }
  function rcOverlayQueue(d) { rcQueue().forEach(q => { if (d.matches.some(m => m.id === q.match_id)) rcApplyScore(d, q.clear ? { ...q, _delete: true } : q); }); }
  let rcFlushing = false;
  async function rcFlush() {
    if (rcFlushing || !navigator.onLine || !app.user) return;
    const q = rcQueue(); if (!q.length) return;
    rcFlushing = true;
    try {
      for (const row of q) {
        const res = row.clear
          ? await client.from("rc_scores").delete().eq("match_id", row.match_id).eq("player_id", row.player_id).eq("hole", row.hole)
          : await client.from("rc_scores").upsert({ match_id: row.match_id, player_id: row.player_id, hole: row.hole, strokes: row.strokes, picked_up: row.picked_up, entered_by: app.user.id, updated_at: new Date().toISOString() }, { onConflict: "match_id,player_id,hole" });
        if (res.error) {
          if (res.error.code === "42501" || /row-level security/i.test(res.error.message || "")) { toast("That score couldn't be saved — the session may be closed, or you're not in this match.", true); }
          else throw res.error;
        }
        store.set(RC_QUEUE, rcQueue().filter(x => x.ts !== row.ts));
      }
    } catch (e) { /* try again when signal's back */ }
    finally { rcFlushing = false; }
  }
  window.addEventListener("online", rcFlush);
  setInterval(rcFlush, 15000);

  function rcSubscribe(d) {
    if (rc.channel) client.removeChannel(rc.channel);
    rc.channel = client.channel("ryder-" + d.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "rc_scores" }, p => {
        if (!rc.data || rc.data.id !== d.id) return;
        const row = p.eventType === "DELETE" ? { ...(p.old || {}), _delete: true } : p.new;
        if (!rc.data.matches.some(m => m.id === row.match_id)) return;
        rcApplyScore(rc.data, row);
        rcRedraw();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "rc_sessions", filter: `event_id=eq.${d.id}` }, () => rcReload())
      .on("postgres_changes", { event: "*", schema: "public", table: "rc_matches", filter: `event_id=eq.${d.id}` }, () => rcReload())
      .on("postgres_changes", { event: "*", schema: "public", table: "rc_players", filter: `event_id=eq.${d.id}` }, () => rcReload())
      .on("postgres_changes", { event: "*", schema: "public", table: "rc_cups", filter: `event_id=eq.${d.id}` }, () => rcReload())
      .subscribe();
  }

  let rcReloadTimer = null;
  function rcReload() {
    clearTimeout(rcReloadTimer);
    rcReloadTimer = setTimeout(async () => {
      if (!rc.data) return;
      try { rc.data = await loadRyder(rc.data.id); rcRedraw(); } catch (e) { /* keep what's on screen */ }
    }, 300);
  }
  function rcRedraw() {
    const typing = document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && view.contains(document.activeElement);
    if (typing) return;
    const parts = (location.hash || "").slice(2).split("/");
    if (parts[0] === "ryder") drawRyder();
    else if (parts[0] === "rc") drawRcMatch(parts[1]);
  }

  const rcPlayer = (d, id) => d.players.find(p => p.id === id) || { id, name: "?" };
  const rcTeamName = (d, side) => d.cup ? d.cup[side === 1 ? "team1_name" : "team2_name"] : "Team " + side;
  const rcColour = (d, side) => d.cup ? d.cup[side === 1 ? "team1_colour" : "team2_colour"] : side === 1 ? "#1B3A6C" : "#B3261E";

  function rcPh(d, session, pid) {
    const t = d.tees.get(session.tee_id);
    const p = rcPlayer(d, pid);
    if (!t || p.handicap == null) return p.handicap == null ? null : Math.round(Number(p.handicap) * (d.cup ? d.cup.allowance : 75) / 100);
    const par = t.holes.reduce((a, h) => a + h.par, 0);
    return S.playingHandicap({ method: "whs", allowance: d.cup ? d.cup.allowance : 75, index: Number(p.handicap), tee: t.tee, par });
  }

  function rcEval(d, m) {
    const session = d.sessions.find(s => s.id === m.session_id);
    const t = session && d.tees.get(session.tee_id);
    const holes = t && t.holes.length === 18 ? t.holes : Array.from({ length: 18 }, (_, i) => ({ hole: i + 1, par: 4, stroke_index: i + 1 }));
    const sc = d.scores.get(m.id) || {};
    const per = rcPerSide(session.format);
    const side = ids => ids.slice(0, per).map(pid => ({ id: pid, ph: rcPh(d, session, pid), scores: sc[pid] || {} }));
    const res = S.teamMatch(holes, session.format, side(m.side1), side(m.side2));
    return { ...res, holes, session, real: !!(t && t.holes.length === 18) };
  }

  function rcTotals(d) {
    let t1 = 0, t2 = 0, p1 = 0, p2 = 0, n = 0;
    d.matches.forEach(m => {
      if (!m.side1.length || !m.side2.length) return;
      const ses = d.sessions.find(s => s.id === m.session_id);
      if (!ses) return;
      n++;
      const e = rcEval(d, m);
      if (e.points) { t1 += e.points[0]; t2 += e.points[1]; p1 += e.points[0]; p2 += e.points[1]; }
      else if (e.played) { if (e.leader === 1) p1 += 1; else if (e.leader === 2) p2 += 1; else { p1 += .5; p2 += .5; } }
    });
    return { t1, t2, p1, p2, n, toWin: n ? n / 2 + .5 : 0 };
  }
  const half = n => (Math.floor(n) === n ? String(n) : (Math.floor(n) || "") + "½");

  function rcStatusText(d, e) {
    if (e.played === 0) return "Not started";
    if (e.finished) {
      if (!e.leader) return "Halved";
      return `${esc(rcTeamName(d, e.leader))} win ${e.status}`;
    }
    if (!e.leader) return `All square · thru ${e.played}`;
    return `${esc(rcTeamName(d, e.leader))} ${e.status} · thru ${e.played}`;
  }

  async function renderRyder(eventId, tab) {
    view.innerHTML = `<div class="loading">Loading the Ryder Cup…</div>`;
    try { rc.data = await loadRyder(eventId); }
    catch (e) { view.innerHTML = `<a class="back-link" href="#/">‹ Home</a><div class="card status-msg err">${esc(e.message)}</div>`; return; }
    if (tab) rc.tab = tab;
    if (!rc.data.canManage && !(rc.tab === "pick" && rc.data.captainSide)) rc.tab = "matches";
    if (rc.tab === "setup") await rcEnsureTees();
    rcSubscribe(rc.data);
    rcFlush();
    drawRyder();
  }

  function drawRyder() {
    const d = rc.data;
    if (!d) return;
    const tabs = [["matches", "Matches", TAB_ICONS.board]];
    if (d.canManage) tabs.push(["setup", "Setup", TAB_ICONS.setup]);
    else if (d.captainSide) tabs.push(["pick", "Pairings", TAB_ICONS.pairs || TAB_ICONS.setup]);
    showTabbar(tabs.map(([k, l, ic]) => `<button role="tab" data-action="rc-tab" data-tab="${k}" aria-selected="${rc.tab === k}">${ic}<span>${l}</span></button>`).join(""));
    const head = `<div class="round-head"><a class="back-link" href="#/">‹ Rounds</a>
      <h1>${esc(d.event.name)}</h1><div class="muted small">${esc(d.event.venue || "")} · ${fmtDate(d.event.event_date, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</div></div>`;
    if (!d.cup) {
      view.innerHTML = head + (d.canManage
        ? `<div class="card"><h2>Set up the Ryder Cup</h2><p class="small muted">Name the two teams, pick the players, then add the sessions and matches. Players score their own matches live, and the team board keeps itself up to date.</p>
            <button class="btn gold block" data-action="rc-create">Set up the Ryder Cup</button></div>`
        : `<div class="card empty"><p>The teams haven't been announced yet.</p><p class="small">The committee will put the teams and matches up here before the weekend.</p></div>`);
      return;
    }
    view.innerHTML = head + (rc.tab === "setup" && d.canManage ? rcSetupView(d) : rc.tab === "pick" && d.captainSide ? rcCaptainView(d) : rcBoardView(d));
  }

  function rcNames(d, ids, colour) {
    return ids.length ? ids.map(id => `<span class="rc-pl">${avatar(rcPlayer(d, id).name, rcPlayer(d, id).profile_id)}<span>${esc(shortName(rcPlayer(d, id).name))}${d.captains.has(id) ? ' <i class="rc-c" title="Captain">C</i>' : ""}</span></span>`).join("") : `<span class="muted small">TBC</span>`;
  }

  function rcBoardView(d) {
    const t = rcTotals(d);
    const c1 = rcColour(d, 1), c2 = rcColour(d, 2);
    const mine = new Set(d.players.filter(p => p.profile_id === app.user.id).map(p => p.id));
    const board = `<div class="rc-score">
      <div class="rc-team" style="background:${esc(c1)}"><small>${esc(rcTeamName(d, 1))}</small><b>${half(t.t1)}</b></div>
      <div class="rc-mid">${t.n ? `${half(t.toWin)} to win` : ""}<br><span>${t.n} match${t.n === 1 ? "" : "es"}</span></div>
      <div class="rc-team" style="background:${esc(c2)}"><small>${esc(rcTeamName(d, 2))}</small><b>${half(t.t2)}</b></div></div>
      ${t.p1 !== t.t1 || t.p2 !== t.t2 ? `<p class="small muted rc-proj">If it finished as it stands: ${esc(rcTeamName(d, 1))} ${half(t.p1)} – ${half(t.p2)} ${esc(rcTeamName(d, 2))}</p>` : ""}`;
    const sessions = d.sessions.map(s => {
      const ms = d.matches.filter(m => m.session_id === s.id);
      const tee = d.tees.get(s.tee_id);
      return `<div class="card rc-session">
        <div class="row"><h2 style="margin:0">${esc(s.name)}</h2><span class="spacer"></span>${s.status === "live" ? `<span class="badge live">Live</span>` : s.status === "final" ? `<span class="badge final">Final</span>` : `<span class="badge">Not started</span>`}</div>
        <div class="thru">${RC_FORMATS[s.format]}${tee ? ` · ${esc(tee.tee.courses ? tee.tee.courses.name : "")} ${esc(tee.tee.name)} tees` : ""}${s.play_date ? " · " + fmtDate(s.play_date) : ""}</div>
        ${ms.length ? ms.map(m => { const e = rcEval(d, m); const lead = e.leader ? rcColour(d, e.leader) : "#57617A";
          const isMine = m.side1.concat(m.side2).some(id => mine.has(id));
          return `<a class="rc-match${isMine ? " mine" : ""}" href="#/rc/${m.id}">
            <div class="rc-side" style="border-color:${esc(c1)}">${rcNames(d, m.side1)}</div>
            <div class="rc-status" style="background:${e.played ? esc(lead) : "#e6eaf2"};color:${e.played ? "#fff" : "var(--ink-soft)"}">${e.finished && e.leader ? e.status : e.finished ? "½" : e.played ? (e.leader ? e.status : "AS") : "–"}<small>${e.finished ? "Final" : e.played ? "thru " + e.played : ""}</small></div>
            <div class="rc-side right" style="border-color:${esc(c2)}">${rcNames(d, m.side2)}</div></a>`; }).join("")
          : `<p class="small muted">No matches yet.</p>`}
      </div>`;
    }).join("");
    return board + (sessions || `<div class="card empty"><p>No sessions yet.</p>${d.canManage ? `<button class="btn" data-action="rc-tab" data-tab="setup">Add the sessions</button>` : ""}</div>`);
  }

  function rcSetupView(d) {
    const c = d.cup;
    const pool = d.players.filter(p => d.team.has(p.id) || d.onTrip.has(p.id) || (rc.showAll && p.active !== false))
      .sort((a, b) => (d.team.get(a.id) || 3) - (d.team.get(b.id) || 3) || a.name.localeCompare(b.name));
    const count = side => [...d.team.values()].filter(v => v === side).length;
    const teeOpts = sel => `<option value="">Choose a course…</option>` + rc.allTees.map(t => `<option value="${t.id}" ${t.id === sel ? "selected" : ""}>${esc(t.courses ? t.courses.name : "")} · ${esc(t.name)}</option>`).join("");
    const team = side => pool.filter(p => d.team.get(p.id) === side);
    const sel = (m, sideNo, i, s) => {
      const opts = team(sideNo).map(p => `<option value="${p.id}" ${m[sideNo === 1 ? "side1" : "side2"][i] === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
      return `<select class="rc-sel" data-rc-pick="${m.id}" data-side="${sideNo}" data-i="${i}" ${s.status === "final" ? "disabled" : ""}><option value="">—</option>${opts}</select>`;
    };
    return `
      <div class="card"><h2>Teams</h2>
        <div class="rc-teams">
          <label class="field">Team 1<input id="rc-n1" value="${esc(c.team1_name)}"></label><label class="field rc-col">Colour<input type="color" id="rc-c1" value="${esc(c.team1_colour)}"></label>
          <label class="field">Team 2<input id="rc-n2" value="${esc(c.team2_name)}"></label><label class="field rc-col">Colour<input type="color" id="rc-c2" value="${esc(c.team2_colour)}"></label>
        </div>
        <label class="field">Allowance %<input id="rc-allow" type="number" min="0" max="100" value="${c.allowance}"></label>
        <p class="small muted" style="margin-top:-4px">Playing handicaps are this % of course handicap. In every match the lowest plays off scratch and the others get the difference. Foursomes pairs play off half their combined handicap.</p>
        <button class="btn block" data-action="rc-save-cup">Save teams</button></div>
      <div class="card"><div class="row"><h2 style="margin:0">Players</h2><span class="spacer"></span><span class="small muted">${count(1)} v ${count(2)}</span></div>
        ${d.captainsOn ? `<p class="small muted" style="margin:6px 0 0">Tap <b>C</b> to make a player captain. Captains can pick their own team's pairings for each session.</p>` : ""}
        <p class="small muted">${d.onTrip.size ? "Everyone registered for the fixture." : "Nobody's registered for the fixture yet."} <button class="mv-link" data-action="rc-show-all">${rc.showAll ? "Only show those registered" : "Show every player"}</button></p>
        ${pool.map(p => { const sd = d.team.get(p.id); return `<div class="row rc-prow"><span class="rc-pname">${esc(p.name)} <span class="muted small">${p.handicap == null ? "" : p.handicap}</span></span><span class="spacer"></span>
          ${sd && d.captainsOn ? `<button class="rc-capt${d.captains.has(p.id) ? " on" : ""}" data-action="rc-captain" data-player="${p.id}" aria-pressed="${d.captains.has(p.id)}" title="Captain">C</button>` : ""}
          <div class="rc-seg"><button data-action="rc-side" data-player="${p.id}" data-side="1" class="${sd === 1 ? "on" : ""}" style="${sd === 1 ? `background:${esc(c.team1_colour)}` : ""}">${esc(shortName(c.team1_name) || "1")}</button><button data-action="rc-side" data-player="${p.id}" data-side="0" class="${!sd ? "on0" : ""}">–</button><button data-action="rc-side" data-player="${p.id}" data-side="2" class="${sd === 2 ? "on" : ""}" style="${sd === 2 ? `background:${esc(c.team2_colour)}` : ""}">${esc(shortName(c.team2_name) || "2")}</button></div></div>`; }).join("") || `<p class="small muted">No players to show.</p>`}
      </div>
      ${d.sessions.map(s => { const ms = d.matches.filter(m => m.session_id === s.id); const per = rcPerSide(s.format);
        return `<div class="card rc-sess-edit">
          <div class="row"><input class="rc-sname" data-rc-sess="${s.id}" data-field="name" value="${esc(s.name)}"><span class="spacer"></span>
            ${s.status === "live" ? `<span class="badge live">Live</span>` : s.status === "final" ? `<span class="badge final">Final</span>` : ""}</div>
          <div class="rc-sess-row">
            <select data-rc-sess="${s.id}" data-field="format">${Object.entries(RC_FORMATS).map(([k, l]) => `<option value="${k}" ${s.format === k ? "selected" : ""}>${l}</option>`).join("")}</select>
            <select data-rc-sess="${s.id}" data-field="tee_id">${teeOpts(s.tee_id)}</select>
            <input type="date" data-rc-sess="${s.id}" data-field="play_date" value="${s.play_date || ""}"></div>
          ${ms.map(m => `<div class="rc-medit"><span class="rc-mno">${m.match_no}</span>
            <div class="rc-mside" style="border-color:${esc(c.team1_colour)}">${Array.from({ length: per }, (_, i) => sel(m, 1, i, s)).join("")}</div>
            <span class="muted small">v</span>
            <div class="rc-mside" style="border-color:${esc(c.team2_colour)}">${Array.from({ length: per }, (_, i) => sel(m, 2, i, s)).join("")}</div>
            <button class="mv-link" data-action="rc-del-match" data-id="${m.id}" aria-label="Remove match">✕</button></div>`).join("")}
          <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
            <button class="btn ghost" style="min-height:38px" data-action="rc-add-match" data-session="${s.id}">+ Match</button>
            <span class="spacer"></span>
            ${s.status === "setup" ? `<button class="btn gold" style="min-height:38px" data-action="rc-sess-status" data-session="${s.id}" data-status="live">Open scoring</button>`
              : s.status === "live" ? `<button class="btn" style="min-height:38px" data-action="rc-sess-status" data-session="${s.id}" data-status="final">Finish session</button>`
              : `<button class="btn ghost" style="min-height:38px" data-action="rc-sess-status" data-session="${s.id}" data-status="live">Reopen</button>`}
            <button class="mv-link" data-action="rc-del-session" data-session="${s.id}">Delete session</button>
          </div></div>`; }).join("")}
      <div class="card"><h2>Add a session</h2>
        <label class="field">Name<input id="rc-new-name" placeholder="e.g. Friday fourballs"></label>
        <label class="field">Format<select id="rc-new-format">${Object.entries(RC_FORMATS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
        <label class="field">Course and tee<select id="rc-new-tee">${teeOpts(null)}</select></label>
        <label class="field">Date<input id="rc-new-date" type="date" value="${d.event.event_date}"></label>
        <button class="btn block" data-action="rc-add-session">Add session</button></div>`;
  }

  // A captain picks their own team for each match; the other side and
  // everything else stays as the committee set it.
  function rcCaptainView(d) {
    const side = d.captainSide;
    const c = rcColour(d, side);
    const team = d.players.filter(p => d.team.get(p.id) === side).sort((a, b) => a.name.localeCompare(b.name));
    const used = (s, m, id) => d.matches.some(x => x.session_id === s.id && x.id !== m.id && x[side === 1 ? "side1" : "side2"].includes(id));
    return `<div class="card"><h2>Your pairings</h2><p class="small muted" style="margin-top:0">You're captain of <b style="color:${esc(c)}">${esc(rcTeamName(d, side))}</b>. Pick who plays in each match. The committee sets the sessions, the matches and the other team.</p></div>
      ${d.sessions.map(s => { const ms = d.matches.filter(m => m.session_id === s.id); const per = rcPerSide(s.format);
        return `<div class="card rc-sess-edit"><div class="row"><h2 style="margin:0">${esc(s.name)}</h2><span class="spacer"></span><span class="small muted">${RC_FORMATS[s.format]}</span></div>
          ${ms.map(m => { const mine = m[side === 1 ? "side1" : "side2"], theirs = m[side === 1 ? "side2" : "side1"];
            return `<div class="rc-medit"><span class="rc-mno">${m.match_no}</span>
              <div class="rc-mside" style="border-color:${esc(c)}">${Array.from({ length: per }, (_, i) => `<select class="rc-sel" data-rc-pick="${m.id}" data-side="${side}" data-i="${i}" ${s.status === "final" ? "disabled" : ""}><option value="">—</option>${team.map(p => `<option value="${p.id}" ${mine[i] === p.id ? "selected" : ""}>${esc(p.name)}${used(s, m, p.id) ? " (in another match)" : ""}</option>`).join("")}</select>`).join("")}</div>
              <span class="muted small">v</span><div class="rc-mside rc-theirs">${theirs.length ? theirs.map(id => esc(shortName(rcPlayer(d, id).name))).join(" &amp; ") : '<span class="muted small">TBC</span>'}</div></div>`; }).join("") || `<p class="small muted">No matches in this session yet.</p>`}
        </div>`; }).join("") || `<div class="card empty"><p>The committee hasn't added any sessions yet.</p></div>`}`;
  }

  async function rcEnsureTees() {
    if (rc.allTees.length) return;
    const { data } = await client.from("course_tees").select("id, name, course_id, courses(name)").order("name");
    rc.allTees = (data || []).sort((a, b) => ((a.courses && a.courses.name) || "").localeCompare((b.courses && b.courses.name) || ""));
  }
  rc.allTees = [];

  async function rcDo(promise, ok) {
    const { error } = await promise;
    if (error) { toast(error.message, true); return false; }
    if (ok) toast(ok);
    rc.data = await loadRyder(rc.data.id);
    drawRyder();
    return true;
  }

  // ----- a match -----

  async function renderRcMatch(matchId) {
    if (!rc.data || !rc.data.matches.some(m => m.id === matchId)) {
      view.innerHTML = `<div class="loading">Loading the match…</div>`;
      const { data: m } = await client.from("rc_matches").select("event_id").eq("id", matchId).maybeSingle();
      if (!m) { view.innerHTML = `<div class="card status-msg err">Couldn't find that match.</div>`; return; }
      try { rc.data = await loadRyder(m.event_id); rcSubscribe(rc.data); } catch (e) { view.innerHTML = `<div class="card status-msg err">${esc(e.message)}</div>`; return; }
    }
    rcFlush();
    drawRcMatch(matchId);
  }

  function drawRcMatch(matchId) {
    const d = rc.data;
    const m = d.matches.find(x => x.id === matchId);
    if (!m) return;
    hideTabbar();
    const e = rcEval(d, m);
    const s = e.session;
    const c1 = rcColour(d, 1), c2 = rcColour(d, 2);
    const balls = s.format === "foursome"
      ? [{ pid: m.side1[0], side: 1, label: m.side1.map(id => shortName(rcPlayer(d, id).name)).join(" & ") }, { pid: m.side2[0], side: 2, label: m.side2.map(id => shortName(rcPlayer(d, id).name)).join(" & ") }]
      : m.side1.map(pid => ({ pid, side: 1 })).concat(m.side2.map(pid => ({ pid, side: 2 })));
    const gets = [...e.shots.s1, ...e.shots.s2];
    const sc = d.scores.get(m.id) || {};
    const canScore = d.canManage || (s.status === "live" && m.side1.concat(m.side2).some(id => rcPlayer(d, id).profile_id === app.user.id));
    const cols = `grid-template-columns: 30px 30px 32px repeat(${balls.length}, minmax(0, 1fr)) 34px;`;
    const shotsFor = (i, h) => S.shotsOnHole(gets[i], h.stroke_index, 18);
    const lead = e.leader ? rcColour(d, e.leader) : "var(--navy-dark)";
    const row = h => {
      const l = e.log.find(x => x.hole === h.hole) || {};
      return `<div class="sg-row" style="${cols}"><span class="sg-hole">${h.hole}</span><span class="sg-par">${h.par}</span><span class="sg-si">${h.stroke_index}</span>
        ${balls.map((b, i) => { const v = (sc[b.pid] || {})[h.hole]; const sh = shotsFor(i, h);
          let cls = "sg-cell", txt = "+";
          if (v && (v.strokes != null || v.picked_up)) { cls += " set"; if (v.picked_up) { cls += " pu"; txt = "P"; } else { const dd = v.strokes - h.par; cls += dd < 0 ? " under" : dd > 0 ? " over" : " par"; txt = v.strokes; } }
          return `<button class="${cls}" data-action="rc-cell" data-match="${m.id}" data-player="${b.pid}" data-hole="${h.hole}" ${canScore ? "" : "disabled"}>${sh > 0 ? `<span class="sg-shots">${"•".repeat(Math.min(sh, 3))}</span>` : ""}<span class="sg-val">${txt}</span></button>`; }).join("")}
        <span class="rc-res" style="${l.res === 1 ? `background:${c1}` : l.res === -1 ? `background:${c2}` : l.res === 0 ? "background:#c9ced8" : ""}">${l.res === 0 ? "½" : l.res ? "" : ""}</span></div>`;
    };
    view.innerHTML = `
      <div class="round-head"><a class="back-link" href="#/ryder/${d.id}">‹ ${esc(d.event.name)}</a>
        <h1>${esc(s.name)} · match ${m.match_no}</h1>
        <div class="muted small">${RC_FORMATS[s.format]}${e.real ? ` · ${esc(d.tees.get(s.tee_id).tee.name)} tees` : " · course not chosen yet"}</div></div>
      <div class="rc-banner" style="background:${lead}">${rcStatusText(d, e)}</div>
      <div class="card rc-vs">
        <div class="rc-vs-side" style="border-color:${esc(c1)}"><small>${esc(rcTeamName(d, 1))}</small>${m.side1.map((id, i) => `<div>${esc(rcPlayer(d, id).name)} <span class="muted small">${s.format === "foursome" ? "" : gets[i] ? `gets ${gets[i]}` : "scratch"}</span></div>`).join("")}${s.format === "foursome" ? `<span class="muted small">${e.shots.s1[0] ? `gets ${e.shots.s1[0]}` : "scratch"}</span>` : ""}</div>
        <div class="rc-vs-side right" style="border-color:${esc(c2)}"><small>${esc(rcTeamName(d, 2))}</small>${m.side2.map((id, i) => `<div>${esc(rcPlayer(d, id).name)} <span class="muted small">${s.format === "foursome" ? "" : gets[m.side1.length + i] ? `gets ${gets[m.side1.length + i]}` : "scratch"}</span></div>`).join("")}${s.format === "foursome" ? `<span class="muted small">${e.shots.s2[0] ? `gets ${e.shots.s2[0]}` : "scratch"}</span>` : ""}</div>
      </div>
      ${!canScore && s.status !== "final" ? `<p class="small muted">Only the players in this match can score it${s.status === "setup" ? ", once the committee opens the session" : ""}.</p>` : ""}
      <div class="card score-grid">
        <div class="sg-sticky"><div class="sg-row sg-head" style="${cols}"><span>Hole</span><span>Par</span><span>SI</span>
          ${balls.map(b => `<span class="sg-who">${s.format === "foursome" ? `<span class="rc-ball" style="background:${b.side === 1 ? c1 : c2}">${esc(b.label)}</span>` : `<span class="rc-av" style="box-shadow:0 0 0 2px ${b.side === 1 ? c1 : c2}">${avatar(rcPlayer(d, b.pid).name, rcPlayer(d, b.pid).profile_id)}</span>`}</span>`).join("")}<span></span></div></div>
        ${e.holes.map(row).join("")}
        <p class="small muted sg-key">Tap a box to put a score in · dots are shots · the coloured dot shows who won the hole</p>
      </div>`;
  }

  function rcKeypad(matchId, pid, hole) {
    const d = rc.data, m = d.matches.find(x => x.id === matchId);
    const e = rcEval(d, m), h = e.holes.find(x => x.hole === hole);
    const cur = ((d.scores.get(matchId) || {})[pid] || {})[hole];
    const curV = cur ? (cur.picked_up ? "P" : cur.strokes) : null;
    rc.kp = { matchId, pid, hole, pending: curV };
    const name = e.session.format === "foursome" ? (m.side1[0] === pid ? m.side1 : m.side2).map(id => shortName(rcPlayer(d, id).name)).join(" & ") : rcPlayer(d, pid).name;
    const keys = []; for (let v = 1; v <= 12; v++) { const dd = v - h.par; keys.push(`<button class="kp-key ${dd < 0 ? "k-under" : dd > 0 ? "k-over" : "k-par"}${curV === v ? " on" : ""}" data-action="rc-kp" data-val="${v}">${v}<small>${dd === -2 ? "Eagle" : dd === -1 ? "Birdie" : dd === 0 ? "Par" : dd === 1 ? "Bogey" : dd === 2 ? "Double" : ""}</small></button>`); }
    openSheet(`<div class="kp-title">${esc(name)} – Hole ${hole}</div><div class="kp-facts">Par ${h.par} · SI ${h.stroke_index}</div>
      <div class="kp-grid">${keys.join("")}
        <button class="kp-key k-pu${curV === "P" ? " on" : ""}" data-action="rc-kp" data-val="P">P/U<small>Concede</small></button>
        <button class="kp-key k-clear" data-action="rc-kp-clear" ${cur ? "" : "disabled"}>Clear</button>
        <button class="kp-key k-ok" data-action="rc-kp-ok" ${curV == null ? "disabled" : ""}>✓</button></div>`);
  }

  function rcSave(row) {
    const q = rcQueue().filter(x => !(x.match_id === row.match_id && x.player_id === row.player_id && x.hole === row.hole));
    q.push({ ...row, ts: Date.now() + Math.random() });
    store.set(RC_QUEUE, q);
    rcApplyScore(rc.data, row.clear ? { ...row, _delete: true } : { ...row, entered_by: app.user.id });
    buzz();
    rcFlush();
  }

  function rcAfterKeypad(matchId, pid, hole) {
    const d = rc.data, m = d.matches.find(x => x.id === matchId);
    const fmt = d.sessions.find(s => s.id === m.session_id).format;
    const order = fmt === "foursome" ? [m.side1[0], m.side2[0]] : m.side1.concat(m.side2);
    const sc = d.scores.get(matchId) || {};
    const next = order.slice(order.indexOf(pid) + 1).find(id => !((sc[id] || {})[hole]));
    if (next) rcKeypad(matchId, next, hole); else closeSheet();
    drawRcMatch(matchId);
  }


  // ---------- the bag ----------
  // Each player's clubs (with how far they hit them), glove, shoes and
  // ball. Every member can see every bag; only the player changes theirs.
  // On the course the yardage line suggests a club from it.

  const CLUBS = [
    ["DR", "Driver", "wood"], ["2W", "2 wood", "wood"], ["3W", "3 wood", "wood"], ["4W", "4 wood", "wood"], ["5W", "5 wood", "wood"], ["7W", "7 wood", "wood"], ["9W", "9 wood", "wood"],
    ["1H", "1 hybrid", "hybrid"], ["2H", "2 hybrid", "hybrid"], ["3H", "3 hybrid", "hybrid"], ["4H", "4 hybrid", "hybrid"], ["5H", "5 hybrid", "hybrid"], ["6H", "6 hybrid", "hybrid"], ["7H", "7 hybrid", "hybrid"],
    ["1I", "1 iron", "iron"], ["2I", "2 iron", "iron"], ["3I", "3 iron", "iron"], ["4I", "4 iron", "iron"], ["5I", "5 iron", "iron"], ["6I", "6 iron", "iron"], ["7I", "7 iron", "iron"], ["8I", "8 iron", "iron"], ["9I", "9 iron", "iron"],
    ["PW", "Pitching wedge", "wedge"], ["GW", "Gap wedge", "wedge"], ["AW", "Approach wedge", "wedge"], ["SW", "Sand wedge", "wedge"], ["LW", "Lob wedge", "wedge"], ["PT", "Putter", "putter"],
  ];
  const CLUB = new Map(CLUBS.map(([code, name, family], i) => [code, { code, name, family, order: i }]));
  const clubShort = code => { const c = CLUB.get(code); if (!c) return code || "?"; return c.family === "iron" ? code[0] + "i" : c.family === "hybrid" ? code[0] + "Hy" : c.family === "wood" && code !== "DR" ? code[0] + "W" : code === "DR" ? "Driver" : code === "PT" ? "Putter" : code[0] + "w"; };
  const KIT = { club: "Club", glove: "Glove", shoes: "Shoes", ball: "Ball" };
  const kitOrder = x => x.kind === "club" ? (CLUB.get(x.club) || { order: 99 }).order : { ball: 100, glove: 101, shoes: 102 }[x.kind] || 103;

  // Simple line drawings, one per kind of club: never a maker's photo.
  function kitIcon(x) {
    const fam = x.kind === "club" ? (CLUB.get(x.club) || {}).family : x.kind;
    const paths = {
      wood: '<path d="M30 6 30 40"/><path d="M30 40c-10 0-18 4-18 10 0 5 7 7 15 7s13-3 13-8-3-9-10-9z"/>',
      hybrid: '<path d="M32 6 30 40"/><path d="M30 40c-8 0-15 3-15 9 0 4 6 6 13 6s11-3 11-7-3-8-9-8z"/>',
      iron: '<path d="M34 6 31 38"/><path d="M31 38 16 48c-2 2-1 6 3 6h14c3 0 4-2 3-5z"/>',
      wedge: '<path d="M34 6 31 36"/><path d="M31 36 15 46c-3 3-1 8 4 8h13c3 0 5-3 3-6z"/>',
      putter: '<path d="M30 6 30 44"/><path d="M14 44h26a4 4 0 0 1 4 4v3a4 4 0 0 1-4 4H14z"/>',
      ball: '<circle cx="30" cy="30" r="16"/><circle cx="25" cy="25" r="1.4"/><circle cx="32" cy="23" r="1.4"/><circle cx="36" cy="30" r="1.4"/><circle cx="27" cy="33" r="1.4"/>',
      glove: '<path d="M20 52V30l-4-10a3 3 0 0 1 5-2l4 8V12a3 3 0 0 1 6 0v12V10a3 3 0 0 1 6 0v14-10a3 3 0 0 1 6 0v22c0 10-5 16-13 16z"/>',
      shoes: '<path d="M8 38h20l8-8 6 4c4 2 10 4 12 8v6H8z"/><path d="M8 48h46"/>',
    };
    return `<svg class="kit-ico" viewBox="0 0 60 60" aria-hidden="true">${paths[fam] || paths.iron}</svg>`;
  }

  async function loadBag(pid) {
    const { data, error } = await client.from("player_equipment").select("*").eq("player_id", pid);
    if (error) return null;
    return (data || []).sort((a, b) => kitOrder(a) - kitOrder(b) || String(a.created_at).localeCompare(String(b.created_at)));
  }

  // My bag, for the club suggestion on the course.
  async function loadMyBag() {
    if (!app.approved || app.guest) return;
    const { data } = await client.from("players").select("id").eq("profile_id", app.user.id).is("guest_event_id", null).limit(1);
    const pid = data && data[0] && data[0].id;
    if (!pid) return;
    const bag = await loadBag(pid);
    app.bag = (bag || []).filter(x => x.kind === "club" && !x.retired && x.distance);
  }

  // The club for a yardage: the shortest one that gets there (5 yds of
  // leeway), never the driver or putter; past everything, the longest.
  function clubFor(yds) {
    const bag = (app.bag || []).filter(x => x.club !== "DR" && x.club !== "PT");
    if (!bag.length || !(yds > 15)) return null;
    const byDist = bag.slice().sort((a, b) => a.distance - b.distance || kitOrder(b) - kitOrder(a));
    const reach = byDist.find(x => x.distance >= yds - 5);
    return reach ? { c: reach, over: false } : { c: byDist[byDist.length - 1], over: true };
  }

  function clubTip(yds) {
    const t = clubFor(yds);
    if (!t) return app.bag && app.bag.length ? "" : (app.approved && !app.guest ? `<span class="club-tip muted"><a href="#/me/bag">Add your clubs</a> for a club suggestion</span>` : "");
    const name = (CLUB.get(t.c.club) || { name: t.c.club }).name;
    return `<span class="club-tip">${t.over ? "Longest" : "Club"}: <b>${esc(name)}</b> <span class="muted">· you hit it ${t.c.distance}</span></span>`;
  }

  function bagCard(items, p, isMe) {
    const clubs = items.filter(x => x.kind === "club" && !x.retired);
    const ball = items.find(x => x.kind === "ball" && !x.retired);
    const href = isMe ? "#/me/bag" : `#/bag/${p.id}`;
    if (!clubs.length && !ball) return isMe ? `<a class="card bag-card" href="${href}"><h2>In the bag</h2><p class="small muted" style="margin:0">Add your clubs and how far you hit them — the scorecard then suggests a club from the yardage. ›</p></a>` : "";
    return `<a class="card bag-card" href="${href}"><div class="row"><h2 style="margin:0">In the bag</h2><span class="spacer"></span><span class="small muted">${clubs.length} clubs ›</span></div>
      <div class="bag-chips">${clubs.map(x => `<span class="bag-chip"><b>${esc(clubShort(x.club))}</b>${x.distance ? ` ${x.distance}` : ""}</span>`).join("")}</div>
      ${ball && (ball.make || ball.model) ? `<p class="small muted" style="margin:8px 0 0">Ball: ${esc([ball.make, ball.model].filter(Boolean).join(" "))}</p>` : ""}</a>`;
  }

  const bagView = { pid: null, tab: "active", data: null, player: null, mine: false };

  async function renderBag(pid) {
    view.innerHTML = `<div class="loading">Loading the bag…</div>`;
    if (!pid) {
      const { data } = await client.from("players").select("id").eq("profile_id", app.user.id).is("guest_event_id", null).limit(1);
      pid = data && data[0] ? data[0].id : null;
      if (!pid) { view.innerHTML = `<a class="back-link" href="#/">‹ Home</a><div class="card empty"><p>You're not on the player list yet. Ask the committee to link your account.</p></div>`; return; }
    }
    const [pl, bag] = await Promise.all([client.from("players").select("id, name, profile_id").eq("id", pid).maybeSingle(), loadBag(pid)]);
    if (!pl.data) { view.innerHTML = `<div class="card status-msg err">Couldn't find that player.</div>`; return; }
    if (bag == null) { view.innerHTML = `<a class="back-link" href="#/">‹ Home</a><div class="card status-msg err">The bag needs a database update before it can work.</div>`; return; }
    Object.assign(bagView, { pid, data: bag, player: pl.data, mine: pl.data.profile_id === app.user.id || app.committee });
    if (pl.data.profile_id === app.user.id) app.bag = bag.filter(x => x.kind === "club" && !x.retired && x.distance);
    drawBag();
    if (app.openKitAdd) { app.openKitAdd = false; if (bagView.mine) kitSheet(null); }
  }

  function drawBag() {
    const b = bagView;
    const list = b.data.filter(x => !!x.retired === (b.tab === "retired"));
    const clubs = b.data.filter(x => x.kind === "club" && !x.retired).length;
    const mine = b.player.profile_id === app.user.id;
    view.innerHTML = `
      <div class="row bag-head"><a class="back-link" href="${mine ? "#/me" : `#/stats/${b.pid}`}">‹ ${mine ? "My profile" : esc(b.player.name)}</a><span class="spacer"></span>
        ${b.mine ? `<button class="btn gold bag-add" data-action="kit-add" aria-label="Add equipment">＋ Add</button>` : ""}</div>
      <h1>${mine ? "My bag" : `${esc(b.player.name)}'s bag`}</h1>
      <div class="seg2 bag-tabs" role="tablist"><button type="button" class="${b.tab === "active" ? "on" : ""}" data-action="bag-tab" data-tab="active">Active</button><button type="button" class="${b.tab === "retired" ? "on" : ""}" data-action="bag-tab" data-tab="retired">Retired</button></div>
      ${b.tab === "active" ? `<p class="bag-count">${clubs} club${clubs === 1 ? "" : "s"} in the bag${clubs > 14 ? ` <span class="bag-warn">· over the 14-club limit</span>` : ""}</p>` : ""}
      <div class="card bag-list">
        ${list.map(x => `<${b.mine ? `button type="button" data-action="kit-edit" data-id="${x.id}"` : "div"} class="kit-row">
          <span class="kit-pic">${kitIcon(x)}</span>
          <span class="kit-main"><span class="kit-top">${x.kind === "club" ? `<b>${esc(clubShort(x.club))}</b>${x.distance ? ` <span class="kit-yds">${x.distance}<small>y</small></span>` : ""}` : `<b>${KIT[x.kind]}</b>`}</span>
            ${x.make || x.model ? `<span class="kit-model">${esc([x.make, x.model].filter(Boolean).join(" "))}</span>` : ""}
            ${x.loft != null || x.shaft ? `<span class="kit-spec">${[x.loft != null ? `${x.loft}°` : "", x.shaft ? esc(x.shaft) : ""].filter(Boolean).join(" · ")}</span>` : ""}</span>
          ${b.mine ? `<span class="chev" aria-hidden="true">›</span>` : ""}</${b.mine ? "button" : "div"}>`).join("")
          || `<p class="small muted" style="padding:6px 2px">${b.tab === "active" ? (b.mine ? "Nothing in the bag yet. Tap ＋ Add to put your clubs in, with how far you hit each one: the scorecard then suggests a club from the yardage." : "Nothing in the bag yet.") : "Nothing retired."}</p>`}
      </div>`;
  }

  function kitSheet(item) {
    const x = item || { kind: null };
    if (!x.kind) {
      openSheet(`<h2>Add equipment</h2><div class="kit-types">${Object.entries(KIT).map(([k, l]) => `<button type="button" class="kit-type" data-action="kit-kind" data-kind="${k}">${kitIcon({ kind: k, club: k === "club" ? "7I" : null })}<span>${l}</span></button>`).join("")}</div>
        <button class="btn ghost block" style="margin-top:12px" data-action="close-sheet">Cancel</button>`);
      return;
    }
    const used = new Set(bagView.data.filter(y => y.kind === "club" && !y.retired && y.id !== x.id).map(y => y.club));
    openSheet(`<h2>${item.id ? "Edit" : "Add"} ${KIT[x.kind].toLowerCase()}</h2>
      <form id="kit-form">
        ${x.kind === "club" ? `<label class="field">Club<select name="club" required><option value="">Choose…</option>${CLUBS.map(([c, n]) => `<option value="${c}" ${x.club === c ? "selected" : ""}>${n}${used.has(c) ? " (in the bag)" : ""}</option>`).join("")}</select></label>
          <label class="field">How far you hit it (yards)<input name="distance" type="number" inputmode="numeric" min="1" max="400" value="${x.distance || ""}" placeholder="Your normal carry, e.g. 125"></label>` : ""}
        <div class="row" style="gap:10px"><label class="field" style="flex:1">Make<input name="make" maxlength="60" value="${esc(x.make || "")}" placeholder="e.g. Cobra"></label>
          <label class="field" style="flex:1.4">Model<input name="model" maxlength="80" value="${esc(x.model || "")}" placeholder="e.g. F-Max"></label></div>
        ${x.kind === "club" ? `<div class="row" style="gap:10px"><label class="field" style="flex:1">Loft (°)<input name="loft" type="number" step="0.5" inputmode="decimal" min="0" max="80" value="${x.loft != null ? x.loft : ""}"></label>
          <label class="field" style="flex:2">Shaft<input name="shaft" maxlength="80" value="${esc(x.shaft || "")}" placeholder="e.g. Regular graphite"></label></div>` : ""}
        <input type="hidden" name="kind" value="${x.kind}">
        <button class="btn gold block" type="submit">${item.id ? "Save" : "Add to the bag"}</button>
        ${item.id ? `<button type="button" class="btn ghost block" style="margin-top:8px" data-action="kit-retire" data-id="${x.id}">${x.retired ? "Back in the bag" : "Retire it"}</button>
          <button type="button" class="btn ghost block danger-text" style="margin-top:8px" data-action="kit-delete" data-id="${x.id}">Delete</button>` : ""}
      </form>`);
    $("#kit-form").addEventListener("submit", async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const num = k => f.get(k) === "" || f.get(k) == null ? null : Number(f.get(k));
      const txt = k => (f.get(k) || "").toString().trim() || null;
      const row = { player_id: bagView.pid, kind: f.get("kind"), club: txt("club"), distance: num("distance"), make: txt("make"), model: txt("model"), loft: num("loft"), shaft: txt("shaft"), updated_at: new Date().toISOString() };
      if (row.kind === "club" && !row.club) { toast("Choose the club.", true); return; }
      const res = item.id ? await client.from("player_equipment").update(row).eq("id", item.id) : await client.from("player_equipment").insert(row);
      if (res.error) { toast(res.error.message, true); return; }
      closeSheet(); toast(item.id ? "Saved" : "In the bag");
      renderBag(bagView.pid);
    });
  }

  async function kitChange(id, change) {
    const res = change === "delete" ? await client.from("player_equipment").delete().eq("id", id)
      : await client.from("player_equipment").update({ retired: change === "retire", updated_at: new Date().toISOString() }).eq("id", id);
    if (res.error) { toast(res.error.message, true); return; }
    closeSheet(); toast(change === "delete" ? "Deleted" : change === "retire" ? "Retired" : "Back in the bag");
    renderBag(bagView.pid);
  }

  // ---------- society handicaps: the committee's list ----------
  // Everyone on the player list: their society handicap, their England
  // Golf index if they have one (the starting point), how many cards are
  // behind them and what those cards work out at. Players without an
  // England Golf index can be given a provisional handicap from their
  // society rounds in one go.

  const hcList = { data: null, q: "", filter: "all" };

  async function loadHandicaps() {
    const [pl, rv] = await Promise.all([
      client.from("players").select("id, name, handicap, active, official_index, hcp_cut, hcp_cut_note").order("name"),
      client.from("handicap_reviews").select("player_id, event_id, differential, source, approved_at, events(event_date)"),
    ]);
    if (pl.error || rv.error) return { off: true };
    const by = new Map();
    (rv.data || []).filter(x => x.differential != null).forEach(x => { if (!by.has(x.player_id)) by.set(x.player_id, []); by.get(x.player_id).push(x); });
    const rows = (pl.data || []).filter(p => p.active !== false).map(p => {
      const h = (by.get(p.id) || []).sort((a, b) => hcDate(a).localeCompare(hcDate(b)));
      const w = S.whsIndex(h.map(x => Number(x.differential)));
      return { p, cards: h.length, calc: w ? w.index : null, w };
    });
    return { rows };
  }

  async function renderHandicaps() {
    if (!app.committee) { view.innerHTML = `<div class="card empty">Committee only.</div>`; return; }
    view.innerHTML = `<div class="loading">Loading handicaps…</div>`;
    hcList.data = await loadHandicaps();
    drawHandicaps();
  }

  function drawHandicaps() {
    const d = hcList.data;
    if (d.off) { view.innerHTML = `<a class="back-link" href="#/">‹ Home</a><div class="card status-msg err">Society handicaps need a database update before they can work.</div>`; return; }
    const q = hcList.q.toLowerCase();
    const rows = d.rows.filter(x => (!q || x.p.name.toLowerCase().includes(q)) &&
      (hcList.filter === "all" || (hcList.filter === "noeg" ? x.p.official_index == null : x.p.official_index != null)));
    const prov = d.rows.filter(x => x.p.official_index == null && x.calc != null && x.calc !== Number(x.p.handicap));
    view.innerHTML = `<a class="back-link" href="#/">‹ Home</a>
      <h1>Society handicaps</h1>
      <p class="small muted">Recalculated for everyone after every finished round — best 8 of the last 20 differentials, fewer while there aren't 20. Put in each player's England Golf index if they have one: it's their starting point, and no index then moves more than 2.0 in a round until they have 20 cards. Players without one can be given a provisional handicap from their society rounds.</p>
      ${prov.length ? `<div class="card hc-prov"><b>${prov.length} player${prov.length > 1 ? "s" : ""} without an England Golf index ${prov.length > 1 ? "have" : "has"} a calculated handicap</b>
        <p class="small muted" style="margin:4px 0 10px">From at least 3 society rounds. Setting it replaces their current figure.</p>
        <button class="btn gold block" data-action="hc-provisional">Set ${prov.length} provisional handicap${prov.length > 1 ? "s" : ""}</button></div>` : ""}
      <div class="row hc-tools"><input id="hc-find" placeholder="Find a player" value="${esc(hcList.q)}">
        <select id="hc-filter"><option value="all">Everyone</option><option value="eg" ${hcList.filter === "eg" ? "selected" : ""}>England Golf</option><option value="noeg" ${hcList.filter === "noeg" ? "selected" : ""}>No England Golf</option></select></div>
      <div class="card board-card"><table class="board hc-table">
        <thead><tr><th>Player</th><th class="num">Society</th><th class="num">England Golf</th><th class="num">Cards</th><th class="num">Works out</th></tr></thead>
        <tbody>${rows.map(x => `<tr>
          <td><a href="#/stats/${x.p.id}"><strong>${esc(x.p.name)}</strong></a>${Number(x.p.hcp_cut) > 0 ? `<div class="thru">−${x.p.hcp_cut} next round</div>` : ""}</td>
          <td class="num"><span class="big">${x.p.handicap == null ? "?" : x.p.handicap}</span></td>
          <td class="num"><input class="hc-eg" data-eg="${x.p.id}" type="number" step="0.1" inputmode="decimal" value="${x.p.official_index == null ? "" : x.p.official_index}" placeholder="–" aria-label="England Golf index for ${esc(x.p.name)}"></td>
          <td class="num thru">${x.cards}</td>
          <td class="num">${x.calc == null ? '<span class="thru">–</span>' : `<b class="${x.calc < Number(x.p.handicap) ? "hc-new down" : x.calc > Number(x.p.handicap) ? "hc-new up" : ""}">${x.calc}</b>`}</td></tr>`).join("")}</tbody></table>
        <p class="small muted" style="margin:10px 0 0">"Works out" is what their cards alone give, with no 2.0 cap. Tap a name for the full working.</p></div>`;
    $("#hc-find").addEventListener("input", e => { hcList.q = e.target.value; const pos = e.target.selectionStart; drawHandicaps(); const f = $("#hc-find"); f.focus(); f.setSelectionRange(pos, pos); });
    $("#hc-filter").addEventListener("change", e => { hcList.filter = e.target.value; drawHandicaps(); });
  }

  async function saveOfficial(pid, value) {
    const v = value === "" ? null : Math.round(Number(value) * 10) / 10;
    if (v != null && (isNaN(v) || v < -10 || v > 54)) { toast("Enter an index between −10 and 54, or leave it blank.", true); return; }
    const { error } = await client.from("players").update({ official_index: v }).eq("id", pid);
    if (error) { toast(error.message, true); return; }
    const row = hcList.data.rows.find(x => x.p.id === pid); if (row) row.p.official_index = v;
    toast(v == null ? "England Golf index cleared" : "England Golf index saved");
  }

  async function setProvisional() {
    const list = hcList.data.rows.filter(x => x.p.official_index == null && x.calc != null && x.calc !== Number(x.p.handicap));
    if (!list.length || !confirm(`Set provisional handicaps for ${list.length} player${list.length > 1 ? "s" : ""} from their society rounds?`)) return;
    for (const x of list) {
      const a = await client.from("handicap_reviews").insert({ event_id: null, player_id: x.p.id, old_index: x.p.handicap, new_index: x.calc, whs_index: x.calc,
        source: "manual", note: `Provisional handicap from ${x.cards} society round${x.cards > 1 ? "s" : ""} (best ${x.w.used} of ${x.w.of}${x.w.adjust ? ` ${x.w.adjust}` : ""})`, approved_by: app.user.id });
      if (a.error) { toast(a.error.message, true); return; }
      const b = await client.from("players").update({ handicap: x.calc }).eq("id", x.p.id);
      if (b.error) { toast(b.error.message, true); return; }
    }
    toast(`${list.length} provisional handicap${list.length > 1 ? "s" : ""} set`);
    renderHandicaps();
  }

  // ---------- private games ----------
  // A member's own round with up to 3 others: members and friends. Hidden
  // from the website; never in results, the Order of Merit or handicaps.
  // Friends get a link and a one-off code, by email from the app or sent
  // by the member from their own phone.

  const PRIVATE_MAX = 4;

  async function privateSheet() {
    openSheet(`<div class="loading">Loading…</div>`);
    const [t, pl] = await Promise.all([
      client.from("course_tees").select("id, name, course_id, courses(name)"),
      client.from("players").select("id, name, profile_id, handicap, active, guest_event_id").order("name"),
    ]);
    const tees = (t.data || []).sort((a, b) => ((a.courses && a.courses.name) || "").localeCompare((b.courses && b.courses.name) || "") || a.name.localeCompare(b.name));
    const me = (pl.data || []).find(x => x.profile_id === app.user.id);
    if (!me) { openSheet(`<h2>New private game</h2><p>You need to be on the player list first. Ask the committee to link your account to your name.</p><button class="btn ghost block" data-action="close-sheet">OK</button>`); return; }
    const members = (pl.data || []).filter(x => x.active !== false && !x.guest_event_id && x.id !== me.id);
    openSheet(`<h2>New private game</h2>
      <p class="small muted" style="margin-top:-4px">You plus up to 3 others. Nothing here reaches the Order of Merit or anyone's handicap.</p>
      <label class="field">Name<input id="pg-name" value="${esc(String(me.name).trim().split(/\s+/)[0])}'s game" maxlength="60"></label>
      <label class="field">Date<input id="pg-date" type="date" value="${londonToday()}"></label>
      <label class="field">Course and tee<select id="pg-tee">${tees.map(x => `<option value="${x.id}">${esc(x.courses ? x.courses.name : "")} · ${esc(x.name)}</option>`).join("")}</select></label>
      <p class="small" style="margin:-6px 0 12px">Course not listed? <a href="#/courses" data-action="close-sheet">Add it from the scorecard</a>.</p>
      <div class="field">Who can see it
        <div class="seg2" id="pg-vis"><button type="button" class="on" data-vis="0">Just the players</button><button type="button" data-vis="1">All members</button></div></div>
      <div class="field" style="margin-top:12px">Members playing <span class="muted small" id="pg-count"></span>
        <input id="pg-find" placeholder="Find a member" autocomplete="off" style="margin-top:6px">
        <div class="pr-list" id="pg-list">${members.map(x => `<label class="pr-pl" data-name="${esc(x.name.toLowerCase())}"><input type="checkbox" value="${x.id}"><span>${esc(x.name)}</span><span class="spacer"></span><span class="muted small">${x.handicap == null ? "" : x.handicap}</span></label>`).join("")}</div></div>
      <div class="field" style="margin-top:12px">Friends who aren't members
        <div id="pg-guests"></div>
        <button type="button" class="btn ghost block" style="min-height:40px;margin-top:6px" data-action="pg-add-guest">＋ Add a friend</button>
        <p class="small muted" style="margin:6px 0 0">Their email gets them a link and a code from the app. A mobile number: you send the link from your phone once the game's made.</p></div>
      <button class="btn gold block" style="margin-top:14px" data-action="private-create">Create the game</button>
      <button class="btn ghost block" style="margin-top:8px" data-action="close-sheet">Cancel</button>`);
    const sheet = $("#sheet");
    const count = () => {
      const n = 1 + sheet.querySelectorAll("#pg-list input:checked").length + sheet.querySelectorAll(".pg-guest").length;
      $("#pg-count").textContent = `· ${n} of ${PRIVATE_MAX} players`;
      sheet.querySelectorAll("#pg-list input:not(:checked)").forEach(i => { i.disabled = n >= PRIVATE_MAX; });
      const add = sheet.querySelector("[data-action=pg-add-guest]"); if (add) add.disabled = n >= PRIVATE_MAX;
    };
    app.pgCount = count;
    sheet.addEventListener("change", e => { if (e.target.closest("#pg-list")) count(); });
    $("#pg-find").addEventListener("input", e => { const q = e.target.value.trim().toLowerCase(); sheet.querySelectorAll("#pg-list .pr-pl").forEach(l => { l.hidden = q && !l.dataset.name.includes(q); }); });
    $("#pg-vis").addEventListener("click", e => { const b = e.target.closest("[data-vis]"); if (!b) return; $("#pg-vis").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); });
    count();
  }

  function addGuestRow() {
    const box = $("#pg-guests");
    const row = document.createElement("div");
    row.className = "pg-guest";
    row.innerHTML = `<div class="row" style="gap:8px"><input class="pg-g-name" placeholder="Name" maxlength="60" style="flex:1;min-width:0"><input class="pg-g-hcp" type="number" step="0.1" inputmode="decimal" placeholder="Handicap" style="width:96px"><button type="button" class="mv-link" data-action="pg-del-guest" aria-label="Remove">✕</button></div>
      <input class="pg-g-contact" placeholder="Their email or mobile" autocomplete="off" style="margin-top:6px">`;
    box.appendChild(row);
    row.querySelector(".pg-g-name").focus();
    if (app.pgCount) app.pgCount();
  }

  const isEmail = v => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
  const isMobile = v => /^\+?[0-9 ()-]{9,}$/.test(v);

  async function createPrivate() {
    const sheet = $("#sheet");
    const players = [...sheet.querySelectorAll("#pg-list input:checked")].map(x => x.value);
    const guests = [...sheet.querySelectorAll(".pg-guest")].map(g => ({
      name: g.querySelector(".pg-g-name").value.trim(),
      handicap: g.querySelector(".pg-g-hcp").value === "" ? null : Number(g.querySelector(".pg-g-hcp").value),
      contact: g.querySelector(".pg-g-contact").value.trim(),
    })).filter(g => g.name);
    const bad = guests.find(g => g.handicap == null || isNaN(g.handicap));
    if (bad) { toast(`Put in a handicap for ${bad.name} (54 if they haven't got one).`, true); return; }
    const badContact = guests.find(g => g.contact && !isEmail(g.contact) && !isMobile(g.contact));
    if (badContact) { toast(`${badContact.name}'s email or mobile doesn't look right.`, true); return; }
    const btn = sheet.querySelector("[data-action=private-create]"); btn.disabled = true; btn.textContent = "Creating…";
    const { data: ev, error } = await client.rpc("create_private_game", {
      p_name: $("#pg-name").value.trim(), p_date: $("#pg-date").value || londonToday(), p_tee: $("#pg-tee").value,
      p_visible: $("#pg-vis .on").dataset.vis === "1", p_players: players, p_guests: guests.map(g => ({ name: g.name, handicap: g.handicap })),
    });
    if (error || !ev) { toast((error && error.message) || "Couldn't create the game.", true); btn.disabled = false; btn.textContent = "Create the game"; return; }
    // Invite the friends who left an email or mobile.
    const { data: gp } = await client.from("players").select("id, name").eq("guest_event_id", ev);
    let emailed = 0, toShare = 0;
    for (const g of guests) {
      if (!g.contact) continue;
      const p = (gp || []).find(x => x.name === g.name.slice(0, 60));
      if (!p) continue;
      const inv = await makeInvite(p.id, g.contact);
      if (inv && isEmail(g.contact)) { if (await emailInvite(inv.invite_id)) emailed++; } else if (inv) toShare++;
    }
    closeSheet();
    toast(`Game created${emailed ? ` · ${emailed} invite${emailed > 1 ? "s" : ""} emailed` : ""}${toShare ? ` · share ${toShare} invite${toShare > 1 ? "s" : ""} from Setup` : ""}`);
    store.set("round-" + ev, { tab: "setup" });
    location.hash = "#/round/" + ev;
  }

  async function makeInvite(playerId, contact) {
    const { data, error } = await client.rpc("create_guest_invite", { p_player: playerId, p_email: isEmail(contact) ? contact : null, p_mobile: isEmail(contact) ? null : contact });
    if (error) { toast(error.message, true); return null; }
    return data && data[0];
  }

  async function emailInvite(inviteId) {
    try {
      const { data, error } = await client.functions.invoke("guest-invite", { body: { invite_id: inviteId } });
      if (error || !data || !data.sent) { toast((data && data.error) || "The email didn't send — use Share instead.", true); return false; }
      return true;
    } catch (e) { toast("The email didn't send — use Share instead.", true); return false; }
  }

  const inviteLink = token => `${location.origin}${location.pathname.replace(/[^/]*$/, "")}#/join/${token}`;

  async function shareInvite(r, inv) {
    const g = r.players.find(p => p.id === inv.player_id);
    const text = `${g ? String(g.name).trim().split(/\s+/)[0] : "Hi"}, you're in ${r.event.name}${r.event.venue ? " at " + r.event.venue : ""} on ${fmtDate(r.event.event_date, { weekday: "long", day: "numeric", month: "long" })}. Keep your score on your phone: open ${inviteLink(inv.token)} and enter code ${inv.code}. It works for this game only.`;
    if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
    const num = (inv.mobile || "").replace(/[^0-9+]/g, "").replace(/^0/, "44").replace(/^\+/, "");
    openSheet(`<h2>Send the invite</h2><p class="small muted">Copy this, or open WhatsApp.</p><textarea class="share-text" rows="6" readonly>${esc(text)}</textarea>
      <a class="btn gold block" style="margin-top:10px" href="https://wa.me/${num ? esc(num) : ""}?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">Open WhatsApp</a>
      ${inv.mobile ? `<a class="btn ghost block" style="margin-top:8px" href="sms:${esc(inv.mobile.replace(/[^0-9+]/g, ""))}?&body=${encodeURIComponent(text)}">Send as a text</a>` : ""}
      <button class="btn ghost block" style="margin-top:8px" data-action="close-sheet">Done</button>`);
  }

  async function loadInvites(r) {
    const { data, error } = await client.from("guest_invites").select("id, player_id, token, code, email, mobile, used_at, expires_at, attempts").eq("event_id", r.id);
    r.invites = error ? [] : (data || []);
    if (app.round && app.round.id === r.id && r.tab === "setup") renderRoundBody();
  }

  function guestsCard(r) {
    if (!r.canManage) return "";
    const guests = r.players.filter(p => p.guest);
    if (!guests.length) return "";
    if (!r.invites) { loadInvites(r); return `<div class="card"><h2>Friends</h2><p class="small muted">Loading invites…</p></div>`; }
    return `<div class="card" id="guests-card"><h2>Friends</h2>
      <p class="small muted" style="margin-top:0">Each friend gets a link and a one-off code that works for this game only, until the end of the day. They can score on their own phone; their email or mobile is deleted after the game.</p>
      ${guests.map(g => { const inv = r.invites.filter(i => i.player_id === g.id).sort((a, b) => String(b.expires_at).localeCompare(String(a.expires_at)))[0];
        return `<div class="guest-row">
          <div><b>${esc(g.name)}</b> <span class="muted small">· plays off ${g.ph == null ? "?" : g.ph}</span>
            <div class="thru">${inv ? (inv.used_at ? "✓ Joined on their phone" : `Code <b>${esc(inv.code)}</b>${inv.email ? ` · emailed to ${esc(inv.email)}` : inv.mobile ? ` · for ${esc(inv.mobile)}` : ""}`) : "Not invited — you can score for them"}</div></div>
          <div class="guest-acts">${inv && !inv.used_at ? `${inv.email ? `<button class="btn ghost" data-action="guest-email" data-invite="${inv.id}">Email again</button>` : ""}<button class="btn ghost" data-action="guest-share" data-invite="${inv.id}">Share</button>` : ""}
            ${!inv || inv.used_at ? "" : ""}<button class="mv-link" data-action="guest-new-invite" data-player="${g.id}">${inv ? "New code" : "Invite"}</button></div>
        </div>`; }).join("")}
    </div>`;
  }

  async function newInvite(r, playerId) {
    const contact = (prompt("Their email or mobile number:") || "").trim();
    if (!contact) return;
    if (!isEmail(contact) && !isMobile(contact)) { toast("That doesn't look like an email or a mobile number.", true); return; }
    const inv = await makeInvite(playerId, contact);
    if (!inv) return;
    if (isEmail(contact)) { if (await emailInvite(inv.invite_id)) toast("Invite emailed"); }
    await loadInvites(r);
    if (!isEmail(contact)) { const full = r.invites.find(i => i.id === inv.invite_id); if (full) shareInvite(r, full); }
  }

  // Finishing a private game keeps everyone's result for their profile.
  async function finishGame(r) {
    const rows = S.stablefordBoard(r.holes, r.players).filter(x => x.sum.thru > 0);
    if (rows.length) {
      const res = await client.from("game_results").upsert(rows.map(x => ({ event_id: r.id, player_id: x.player.id, points: x.sum.points, gross: x.sum.gross, position: x.pos, field: rows.length })), { onConflict: "event_id,player_id" });
      if (res.error) { toast(res.error.message, true); return; }
    }
    await setStatus(r, "final");
  }

  // ---------- practice rounds ----------
  // A round to try the app out, scored from anywhere. Hidden from the
  // website; never copied to results; no handicap changes; cuts untouched.

  async function practiceSheet() {
    openSheet(`<div class="loading">Loading…</div>`);
    const [t, pl] = await Promise.all([
      client.from("course_tees").select("id, name, course_id, courses(name)"),
      client.from("players").select("id, name, profile_id, active").order("name"),
    ]);
    const tees = (t.data || []).sort((a, b) => ((a.courses && a.courses.name) || "").localeCompare((b.courses && b.courses.name) || "") || a.name.localeCompare(b.name));
    const players = (pl.data || []).filter(x => x.active !== false);
    const mine = players.find(x => x.profile_id === app.user.id);
    openSheet(`<h2>New practice round</h2>
      <p class="small muted" style="margin-top:-4px">Pick a course and the players. They're put in fours in the order ticked; you can change groups, contests and formats in Setup afterwards.</p>
      <label class="field">Name<input id="pr-name" value="Practice round"></label>
      <label class="field">Date<input id="pr-date" type="date" value="${londonToday()}"></label>
      <label class="field">Course and tee<select id="pr-tee">${tees.map(x => `<option value="${x.id}">${esc(x.courses ? x.courses.name : "")} · ${esc(x.name)}</option>`).join("")}</select></label>
      <label class="field" style="margin-bottom:6px">Players<input id="pr-find" placeholder="Find a player" autocomplete="off"></label>
      <div class="pr-list">${players.map(x => `<label class="pr-pl" data-name="${esc(x.name.toLowerCase())}"><input type="checkbox" value="${x.id}" ${mine && mine.id === x.id ? "checked" : ""}><span>${esc(x.name)}</span></label>`).join("")}</div>
      <p class="small muted" id="pr-count"></p>
      <button class="btn gold block" data-action="practice-create">Create practice round</button>
      <button class="btn ghost block" style="margin-top:8px" data-action="close-sheet">Cancel</button>`);
    const count = () => { const n = document.querySelectorAll(".pr-list input:checked").length; $("#pr-count").textContent = `${n} player${n === 1 ? "" : "s"} · ${Math.ceil(n / 4) || 0} group${Math.ceil(n / 4) === 1 ? "" : "s"}`; };
    $("#sheet").addEventListener("change", e => { if (e.target.closest(".pr-list")) { if (e.target.checked) e.target.dataset.at = Date.now(); count(); } });
    $("#pr-find").addEventListener("input", e => { const q = e.target.value.trim().toLowerCase(); document.querySelectorAll(".pr-pl").forEach(l => { l.hidden = q && !l.dataset.name.includes(q); }); });
    count();
  }

  async function createPractice() {
    const ids = [...document.querySelectorAll(".pr-list input:checked")].sort((a, b) => (Number(a.dataset.at) || 0) - (Number(b.dataset.at) || 0)).map(x => x.value);
    const tee = $("#pr-tee").value, date = $("#pr-date").value || londonToday();
    if (!tee) { toast("Choose a course first.", true); return; }
    if (!ids.length) { toast("Tick at least one player.", true); return; }
    const btn = document.querySelector("[data-action=practice-create]"); btn.disabled = true; btn.textContent = "Creating…";
    const { data: id, error } = await client.rpc("create_practice_round", { p_name: $("#pr-name").value.trim() || "Practice round", p_date: date, p_tee: tee, p_players: ids });
    if (error || !id) { toast((error && error.message) || "Couldn't create it.", true); btn.disabled = false; btn.textContent = "Create practice round"; return; }
    closeSheet();
    toast("Practice round ready — publish it in Setup to start scoring");
    location.hash = "#/round/" + id;
  }

  async function deletePractice(r) {
    if (!r || !(r.event.is_practice || r.event.is_private)) return;
    if (!confirm(`Delete ${r.event.name} and every score in it?`)) return;
    const { error } = await client.rpc("delete_game", { target: r.id });
    if (error) { toast(error.message, true); return; }
    toast(r.event.is_private ? "Private game deleted" : "Practice round deleted");
    location.hash = "#/";
  }

  // ---------- records & honours ----------

  const records = { data: null, year: "all", a: null, b: null };

  async function loadRecords() {
    const [res, evs, prizes, hs, setups] = await Promise.all([
      client.from("results").select("event_id, player_id, points, gross_score, players(name, profile_id)"),
      client.from("events").select("id, name, venue, event_date, hidden, is_trip"),
      client.from("event_prizes").select("*"),
      client.from("hole_scores").select("event_id, player_id, hole, strokes, picked_up"),
      client.from("event_scoring").select("event_id, tee_id"),
    ]);
    if (res.error) throw res.error;
    const teeIds = [...new Set((setups.data || []).map(x => x.tee_id).filter(Boolean))];
    const { data: ch } = teeIds.length ? await client.from("course_holes").select("tee_id, hole, par").in("tee_id", teeIds) : { data: [] };
    const { data: pls } = await client.from("players").select("id, name, profile_id");
    return { results: res.data || [], events: (evs.data || []).filter(e => !e.hidden), prizes: prizes.data || [], hs: hs.data || [],
      teeOf: new Map((setups.data || []).map(x => [x.event_id, x.tee_id])), par: new Map((ch || []).map(h => [h.tee_id + ":" + h.hole, h.par])), players: pls || [] };
  }

  async function renderRecords() {
    view.innerHTML = `<div class="loading">Digging out the records…</div>`;
    try { if (!records.data) records.data = await loadRecords(); }
    catch (e) { view.innerHTML = `<div class="card status-msg err">${esc(e.message)}</div>`; return; }
    drawRecords();
  }

  function drawRecords() {
    const d = records.data;
    const evById = new Map(d.events.map(e => [e.id, e]));
    const played = new Set(d.results.map(x => x.event_id));
    const years = [...new Set(d.events.filter(e => played.has(e.id)).map(e => e.event_date.slice(0, 4)))].sort().reverse();
    const inYear = id => { const e = evById.get(id); return e && (records.year === "all" || e.event_date.startsWith(records.year)); };
    const res = d.results.filter(r => r.points != null && inYear(r.event_id));
    const nameOf = id => { const p = d.players.find(x => x.id === id); return p ? p.name : "?"; };
    const profOf = id => { const p = d.players.find(x => x.id === id); return p ? p.profile_id : null; };
    // winners per event: the prize sheet if filled in, otherwise top points
    const byEvent = new Map();
    res.forEach(r => { if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, []); byEvent.get(r.event_id).push(r); });
    const winners = [...byEvent.entries()].map(([eid, rs]) => {
      const top = Math.max(...rs.map(r => Number(r.points)));
      const pz = d.prizes.find(p => p.event_id === eid);
      return { ev: evById.get(eid), names: pz && pz.first_place ? [pz.first_place] : rs.filter(r => Number(r.points) === top).map(r => nameOf(r.player_id)), ids: rs.filter(r => Number(r.points) === top).map(r => r.player_id), pts: top, pairs: pz && pz.winning_pair };
    }).sort((a, b) => b.ev.event_date.localeCompare(a.ev.event_date));
    const tally = (fn) => { const m = new Map(); fn(m); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
    const wins = tally(m => winners.forEach(w => w.ids.forEach(id => m.set(id, (m.get(id) || 0) + 1))));
    const rounds = tally(m => res.forEach(r => m.set(r.player_id, (m.get(r.player_id) || 0) + 1)));
    const best = res.slice().sort((a, b) => b.points - a.points).slice(0, 10);
    const birdies = new Map(), eagles = new Map(), twos = new Map();
    d.hs.filter(h => inYear(h.event_id) && !h.picked_up && h.strokes != null).forEach(h => {
      const par = d.par.get(d.teeOf.get(h.event_id) + ":" + h.hole);
      if (!par) return;
      if (h.strokes <= par - 2) eagles.set(h.player_id, (eagles.get(h.player_id) || 0) + 1);
      else if (h.strokes === par - 1) birdies.set(h.player_id, (birdies.get(h.player_id) || 0) + 1);
      if (h.strokes <= par - 2 || h.strokes === 2) twos.set(h.player_id, (twos.get(h.player_id) || 0) + 1);
    });
    const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n || 5);
    const list = (rows, unit) => rows.length ? rows.map(([id, n], i) => `<div class="rec-row"><span class="rec-pos">${i + 1}</span>${avatar(nameOf(id), profOf(id))}<span class="rec-name">${esc(nameOf(id))}</span><b>${n}</b><small>${unit}</small></div>`).join("") : `<p class="small muted">Nothing yet.</p>`;
    // head to head
    const ppl = [...new Set(d.results.map(r => r.player_id))].map(id => ({ id, name: nameOf(id) })).sort((a, b) => a.name.localeCompare(b.name));
    if (!records.a && r0()) records.a = r0();
    function r0() { const me = d.players.find(p => p.profile_id === app.user.id); return me && ppl.some(x => x.id === me.id) ? me.id : (ppl[0] && ppl[0].id); }
    if (!records.b) records.b = (ppl.find(x => x.id !== records.a) || {}).id;
    let h2h = "";
    if (records.a && records.b) {
      const both = [...byEvent.entries()].map(([eid, rs]) => ({ eid, a: rs.find(r => r.player_id === records.a), b: rs.find(r => r.player_id === records.b) })).filter(x => x.a && x.b);
      const aw = both.filter(x => Number(x.a.points) > Number(x.b.points)).length, bw = both.filter(x => Number(x.b.points) > Number(x.a.points)).length;
      const avg = k => both.length ? (both.reduce((t, x) => t + Number(x[k].points), 0) / both.length).toFixed(1) : "–";
      h2h = `<div class="h2h"><div class="h2h-side">${avatar(nameOf(records.a), profOf(records.a), "h2h-av")}<b>${aw}</b><small>avg ${avg("a")}</small></div>
        <div class="h2h-mid">${both.length} round${both.length === 1 ? "" : "s"}<br>together${both.length - aw - bw ? `<br>${both.length - aw - bw} level` : ""}</div>
        <div class="h2h-side">${avatar(nameOf(records.b), profOf(records.b), "h2h-av")}<b>${bw}</b><small>avg ${avg("b")}</small></div></div>`;
    }
    const opts = sel => ppl.map(p => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.name)}</option>`).join("");
    view.innerHTML = `
      <a class="back-link" href="#/">‹ Home</a>
      <h1>Records &amp; honours</h1>
      <div class="subtabs">${["all", ...years].map(y => `<button data-action="rec-year" data-year="${y}" aria-selected="${records.year === y}">${y === "all" ? "All time" : y}</button>`).join("")}</div>
      <div class="card"><h2>Head to head</h2>
        <div class="row" style="gap:8px"><select id="h2h-a" class="rec-sel">${opts(records.a)}</select><span class="muted">v</span><select id="h2h-b" class="rec-sel">${opts(records.b)}</select></div>
        ${h2h}<p class="small muted" style="margin:8px 0 0">Rounds both played, by Stableford points.</p></div>
      <div class="card"><h2>Roll of honour</h2>${winners.length ? winners.map(w => `<div class="hon-row"><div class="hon-date">${fmtDate(w.ev.event_date, { day: "numeric", month: "short", year: "numeric" })}</div>
        <div class="hon-what"><b>${esc(w.ev.name)}</b><span class="thru">${esc(w.ev.venue || "")}</span></div>
        <div class="hon-who">🏆 ${w.names.map(esc).join(" &amp; ")} <small>${w.pts} pts</small>${w.pairs ? `<div class="thru">🤝 ${esc(w.pairs)}</div>` : ""}</div></div>`).join("") : `<p class="small muted">No results yet.</p>`}</div>
      <div class="card"><h2>Best rounds</h2>${best.map((r, i) => { const e = evById.get(r.event_id); return `<div class="rec-row"><span class="rec-pos">${i + 1}</span>${avatar(nameOf(r.player_id), profOf(r.player_id))}<span class="rec-name">${esc(nameOf(r.player_id))}<span class="thru">${esc(e.name)} · ${fmtDate(e.event_date, { day: "numeric", month: "short", year: "numeric" })}</span></span><b>${r.points}</b><small>pts</small></div>`; }).join("") || `<p class="small muted">No results yet.</p>`}</div>
      <div class="rec-grid">
        <div class="card"><h2>Most wins</h2>${list(wins.slice(0, 5), "")}</div>
        <div class="card"><h2>Most rounds</h2>${list(rounds.slice(0, 5), "")}</div>
        <div class="card"><h2>Most birdies</h2>${list(top(birdies), "")}</div>
        <div class="card"><h2>Eagles &amp; 2s</h2>${list(top(twos), "")}</div>
      </div>
      <p class="small muted" style="text-align:center">Birdies, eagles and 2s count from rounds scored in the app.</p>`;
  }

  // ---------- print pack ----------

  function teeTimeFor(r, group) {
    const t = r.event.tee_time, gap = r.setup && r.setup.tee_interval;
    if (!t) return "";
    if (!gap) return group === 1 ? t.slice(0, 5) : "";
    const [h, m] = t.split(":").map(Number);
    const mins = h * 60 + m + (group - 1) * gap;
    return String(Math.floor(mins / 60) % 24).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0");
  }

  async function renderPrint(eventId) {
    hideTabbar();
    view.innerHTML = `<div class="loading">Making the print pack…</div>`;
    let r;
    try { r = (app.round && app.round.id === eventId) ? app.round : await loadRound(eventId); }
    catch (e) { view.innerHTML = `<div class="card status-msg err">${esc(e.message)}</div>`; return; }
    if (!r.tee || r.holes.length !== 18) { view.innerHTML = `<div class="card empty">Set the round up (course and tee) first.</div>`; return; }
    const ev = r.event;
    const groups = groupsOf(r);
    const ungrouped = r.players.filter(p => p.group == null);
    const allGroups = groups.length ? groups : [[1, r.players]];
    if (groups.length && ungrouped.length) allGroups.push(["–", ungrouped]);
    const head = (t) => `<div class="pp-head"><img src="icons/icon-192.png" alt=""><div><div class="pp-kick">The Falkners Arms Golf Society</div><h1>${t}</h1>
      <div class="pp-sub">${esc(ev.name)} · ${esc(r.course ? r.course.name : ev.venue || "")} · ${esc(r.tee.name)} tees · ${fmtDate(ev.event_date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</div></div></div>`;
    const cs = contestsOn(r);
    const start = `<section class="pp-page">${head("Start sheet")}
      <div class="pp-facts"><span>First tee <b>${ev.tee_time ? ev.tee_time.slice(0, 5) : "—"}</b></span><span>Par <b>${parTotal(r)}</b></span>${r.tee.slope ? `<span>Slope <b>${r.tee.slope}</b></span>` : ""}${r.tee.course_rating ? `<span>CR <b>${r.tee.course_rating}</b></span>` : ""}<span>Allowance <b>${esc(String(r.setup.allowance))}%</b></span></div>
      <table class="pp-table"><thead><tr><th>Group</th><th>Tee time</th><th>Player</th><th>Index</th><th>Plays off</th><th>Pair</th><th>Here</th></tr></thead>
      <tbody>${allGroups.map(([n, ps]) => ps.map((p, i) => `<tr class="${i === 0 ? "pp-first" : ""}"><td>${i === 0 ? n : ""}</td><td>${i === 0 && n !== "–" ? teeTimeFor(r, n) : ""}</td><td>${esc(p.name)}${p.guest ? " (guest)" : ""}</td><td>${p.index == null ? "" : p.index}</td><td><b>${p.ph == null ? "" : p.ph}</b></td><td>${(p.pairs || []).join(", ")}</td><td class="pp-box"></td></tr>`).join("")).join("")}</tbody></table>
      ${cs.length ? `<h3>Side contests</h3><p>${cs.map(c => `${esc(c.label)} — hole ${c.holeNo}`).join(" · ")}</p>` : ""}
      <p class="pp-note">Playing handicaps are ${esc(String(r.setup.allowance))}% of course handicap for the ${esc(r.tee.name)} tees. A dot on a card means a shot on that hole.</p></section>`;
    const card = ([n, ps]) => {
      const sums = ps.map(p => S.summarise(r.holes, {}, p.ph));
      const row = h => `<tr><td class="pp-h">${h.hole}</td><td>${h.yards || ""}</td><td>${h.par}</td><td>${h.stroke_index}</td>${ps.map((p, i) => { const sh = sums[i].holes[h.hole].shots; return `<td class="pp-sc"><span class="pp-dots">${sh > 0 ? "•".repeat(Math.min(sh, 3)) : sh < 0 ? "+" : ""}</span></td><td class="pp-pt"></td>`; }).join("")}</tr>`;
      const tot = (label, hs) => `<tr class="pp-tot"><td>${label}</td><td>${hs.reduce((t, h) => t + (h.yards || 0), 0) || ""}</td><td>${hs.reduce((t, h) => t + h.par, 0)}</td><td></td>${ps.map(() => `<td></td><td></td>`).join("")}</tr>`;
      return `<section class="pp-page">${head(n === "–" ? "Scorecard" : "Scorecard · Group " + n)}
        <table class="pp-card"><thead><tr><th>Hole</th><th>Yds</th><th>Par</th><th>SI</th>${ps.map(p => `<th colspan="2">${esc(p.name)}<small>plays off ${p.ph == null ? "?" : p.ph}</small></th>`).join("")}</tr>
          <tr class="pp-sub2"><th></th><th></th><th></th><th></th>${ps.map(() => `<th>Score</th><th>Pts</th>`).join("")}</tr></thead>
          <tbody>${r.holes.slice(0, 9).map(row).join("")}${tot("Out", r.holes.slice(0, 9))}${r.holes.slice(9).map(row).join("")}${tot("In", r.holes.slice(9))}${tot("Total", r.holes)}</tbody></table>
        <div class="pp-sign"><span>Marker's signature</span><span>Player's signature</span></div>
        ${n !== "–" && teeTimeFor(r, n) ? `<p class="pp-note">Tee time ${teeTimeFor(r, n)}</p>` : ""}</section>`;
    };
    const stakes = cs.map(c => `<section class="pp-page">${head(esc(c.label))}
      <div class="pp-facts"><span>Hole <b>${c.holeNo}</b></span><span>${esc(c.nine)}</span></div>
      <p>Write your name under the last one if you're in front. The last group brings this back to the clubhouse.</p>
      <table class="pp-table pp-stake"><thead><tr><th>#</th><th>Name</th><th>Group</th></tr></thead><tbody>${Array.from({ length: 14 }, (_, i) => `<tr><td>${i + 1}</td><td></td><td></td></tr>`).join("")}</tbody></table></section>`).join("");
    view.innerHTML = `<div class="pp-toolbar no-print"><a class="back-link" href="#/round/${r.id}">‹ Back to the round</a>
        <p class="small muted">${allGroups.length} scorecard${allGroups.length > 1 ? "s" : ""}${cs.length ? `, ${cs.length} stake sheet${cs.length > 1 ? "s" : ""}` : ""} and the start sheet. On a phone, Print lets you save it as a PDF or share it.</p>
        <button class="btn gold block" data-action="print">🖨️ Print or save as PDF</button></div>
      <div class="print-pack">${start}${allGroups.map(card).join("")}${stakes}</div>`;
    document.body.classList.add("printing-pack");
  }

  // ---------- prize-giving screen ----------
  // Full screen for the clubhouse TV or a laptop: the contests, the pairs,
  // third, second and then the winner, the final board and the Order of
  // Merit. Tap, click or use the arrow keys to move on. "TV" mode is a
  // live leaderboard that keeps itself up to date and swaps boards.

  const present = { slides: [], i: 0, timer: null, tv: false, eventId: null };

  async function renderPresent(eventId, tv) {
    hideTabbar();
    view.innerHTML = `<div class="loading">Getting the results ready…</div>`;
    let r;
    try { r = (app.round && app.round.id === eventId) ? app.round : await loadRound(eventId); }
    catch (e) { view.innerHTML = `<div class="card status-msg err">${esc(e.message)}</div>`; return; }
    present.eventId = eventId; present.tv = !!tv; present.i = 0;
    if (!app.round || app.round.id !== eventId) { app.round = r; subscribe(r); }
    let season = null;
    try { season = await loadSeason(); } catch (e) { /* the season slide is skipped */ }
    present.season = season;
    buildSlides(r);
    document.body.classList.add("presenting");
    drawPresent();
    clearInterval(present.timer);
    if (tv) present.timer = setInterval(() => { if (!document.body.classList.contains("presenting")) return clearInterval(present.timer);
      buildSlides(app.round); present.i = (present.i + 1) % present.slides.length; drawPresent(); }, 15000);
  }

  function buildSlides(r) {
    const ev = r.event;
    const title = `<div class="pz-kicker">${esc(ev.name)} · ${esc(r.course ? r.course.name : ev.venue || "")}</div>`;
    const slides = [];
    const board = r.holes.length ? S.stablefordBoard(r.holes, r.players).filter(x => x.sum.thru) : [];
    const pairs = r.holes.length && r.pairs && r.pairs.length ? S.pairsBoard(r.holes, r.pairs).filter(x => x.started) : [];
    const name = p => esc(p.name);
    const boardSlide = (rows, label, isPairs) => `${title}<h2 class="pz-h">${label}</h2>
      <div class="pz-board">${rows.slice(0, 12).map(x => `<div class="pz-row${x.pos === 1 ? " gold" : ""}"><span class="pz-pos">${x.tied ? "T" : ""}${x.pos}</span>
        ${isPairs ? `<span class="pz-name">${x.pair.players.map(name).join(" &amp; ")}</span><span class="pz-thru">${x.complete ? "F" : "Thru " + x.thru}</span><span class="pz-pts">${x.points}</span>`
                  : `<span class="pz-av">${avatar(x.player.name, x.player.profileId)}</span><span class="pz-name">${name(x.player)}</span><span class="pz-thru">${x.sum.complete ? "F" : "Thru " + x.sum.thru}</span><span class="pz-pts">${x.sum.points}</span>`}</div>`).join("")}</div>`;
    if (present.tv) {
      if (board.length) slides.push(boardSlide(board, r.setup && r.setup.status === "live" ? "Live leaderboard" : "Leaderboard"));
      if (pairs.length) slides.push(boardSlide(pairs, "Pairs", true));
      const cs = contestsOn(r);
      if (cs.length) slides.push(`${title}<h2 class="pz-h">Side contests</h2><div class="pz-contests">${cs.map(c => { const lead = leaderOf(r, c.id); const conf = confirmedOf(r, c);
        return `<div class="pz-ct"><span>${COMP_ICON[compKind(c)]}</span><div><small>${esc(c.label)} · hole ${c.holeNo}</small><b>${esc(conf || (lead ? playerName(r, lead.player_id) : "No name yet"))}</b></div></div>`; }).join("")}</div>`);
      if (!slides.length) slides.push(`${title}<h2 class="pz-h">Scores will appear here</h2>`);
      present.slides = slides; return;
    }
    slides.push(`<div class="pz-title"><img src="icons/icon-512.png" alt=""><div class="pz-kicker">The Falkners Arms Golf Society</div>
      <h1>${esc(ev.name)}</h1><div class="pz-sub">${esc(r.course ? r.course.name : ev.venue || "")} · ${fmtDate(ev.event_date, { weekday: "long", day: "numeric", month: "long" })}</div></div>`);
    contestsOn(r).forEach(c => {
      const lead = leaderOf(r, c.id); const conf = confirmedOf(r, c);
      const who = conf || (lead ? playerName(r, lead.player_id) : null);
      slides.push(`${title}<div class="pz-award"><div class="pz-ico">${COMP_ICON[compKind(c)]}</div><div class="pz-label">${esc(c.label)}</div><div class="pz-meta">Hole ${c.holeNo} · ${esc(c.nine)}</div>
        <div class="pz-winner">${who ? esc(who) : "Not awarded"}</div>${!conf && who ? `<div class="pz-meta">Still to be confirmed</div>` : ""}</div>`);
    });
    if (pairs.length && pairs[0].pair.players.length > 1) {
      const top = pairs.filter(x => x.pos === 1);
      slides.push(`${title}<div class="pz-award"><div class="pz-ico">🤝</div><div class="pz-label">Pairs winners</div>
        <div class="pz-winner">${top.map(x => x.pair.players.map(name).join(" &amp; ")).join("<br>")}</div><div class="pz-pts-big">${top[0].points} <small>points</small></div></div>`);
    }
    const place = (pos, label, medal) => {
      const xs = board.filter(x => x.pos === pos);
      if (!xs.length) return;
      slides.push(`${title}<div class="pz-award${pos === 1 ? " pz-first" : ""}"><div class="pz-medal ${medal}">${pos}</div><div class="pz-label">${label}</div>
        <div class="pz-winner">${xs.map(x => `${avatar(x.player.name, x.player.profileId, "pz-big-av")}<span>${name(x.player)}</span>`).join("")}</div>
        <div class="pz-pts-big">${xs[0].sum.points} <small>points</small></div>${xs.length > 1 ? `<div class="pz-meta">Tied after countback</div>` : ""}</div>`);
    };
    place(3, "Third place", "bronze"); place(2, "Runner-up", "silver"); place(1, "Winner", "gold");
    if (board.length) slides.push(boardSlide(board, "Final leaderboard"));
    if (pairs.length) slides.push(boardSlide(pairs, "Pairs", true));
    if (present.season && present.season.table.length) {
      slides.push(`<div class="pz-kicker">The Falkners Arms Golf Society</div><h2 class="pz-h">Order of Merit</h2>
        <div class="pz-board">${present.season.table.slice(0, 10).map((e, i) => `<div class="pz-row${i === 0 ? " gold" : ""}"><span class="pz-pos">${i + 1}</span>
          <span class="pz-av">${avatar(e.name, e.profileId)}</span><span class="pz-name">${esc(e.name)}</span>
          <span class="pz-thru">${e.move ? `<span class="move ${e.move > 0 ? "up" : "down"}" style="display:inline">${e.move > 0 ? "▲" : "▼"}${Math.abs(e.move)}</span>` : ""}</span><span class="pz-pts">${e.totalPoints}</span></div>`).join("")}</div>`);
    }
    slides.push(`<div class="pz-title"><img src="icons/icon-512.png" alt=""><h1>Thanks for playing</h1><div class="pz-sub">See you at the next one</div></div>`);
    present.slides = slides;
  }

  function drawPresent() {
    const n = present.slides.length;
    view.innerHTML = `<div class="present${present.tv ? " tv" : ""}" data-action="present-next">
      <div class="pz-slide" key="${present.i}">${present.slides[present.i] || ""}</div>
      <div class="pz-bar">
        <button data-action="present-exit" aria-label="Close">✕</button>
        ${present.tv ? `<span class="pz-live"><i></i>Live · changes every 15 seconds</span>` : `<button data-action="present-prev" ${present.i === 0 ? "disabled" : ""}>‹</button><span>${present.i + 1} / ${n}</span><button data-action="present-next" ${present.i === n - 1 ? "disabled" : ""}>›</button>`}
        <button data-action="present-full">Full screen</button>
      </div></div>`;
  }

  function exitPresent() {
    clearInterval(present.timer);
    document.body.classList.remove("presenting");
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    location.hash = "#/round/" + present.eventId;
  }

  document.addEventListener("keydown", e => {
    if (!document.body.classList.contains("presenting")) return;
    if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") { if (present.i < present.slides.length - 1) { present.i++; drawPresent(); } e.preventDefault(); }
    if (e.key === "ArrowLeft" || e.key === "PageUp") { if (present.i > 0) { present.i--; drawPresent(); } e.preventDefault(); }
    if (e.key === "Escape" && !document.fullscreenElement) exitPresent();
  });

  // ---------- the forecast ----------
  function weatherChip(f) {
    return `<button class="wx-chip" data-action="weather">${f.first.w.icon} <b>${f.first.temp}°C</b> · ${f.maxRain}% rain · ${f.maxWind} mph${f.days === 0 ? "" : ` <span class="muted">· ${f.days === 1 ? "tomorrow" : "in " + f.days + " days"}</span>`}</button>`;
  }


  // ---------- society handicaps ----------
  // Everyone's society index is recalculated when a round is finished:
  // each card's differential (holes capped at net double bogey, adjusted
  // for slope and rating), then the best 8 of the last 20 - fewer while
  // there aren't 20 - with exceptional scores taken off as WHS does. Until
  // a player has 20 cards no index moves more than 2.0 in one round.
  // The winner and runner-up get a temporary cut (2 and 1) for the next
  // round they play only; it carries over if they miss rounds, and the
  // recalculation ignores it. The committee can change any figure after.
  // Every round's working is kept, and every member can read it.
  const HC_CUTS = [2, 1];

  async function loadHcReview(r) {
    const ids = r.players.map(p => p.id);
    const [rev, pl] = await Promise.all([
      ids.length ? client.from("handicap_reviews").select("*, events(event_date, name)").in("player_id", ids) : Promise.resolve({ data: [] }),
      ids.length ? client.from("players").select("id, handicap, official_index, hcp_cut, hcp_cut_note").in("id", ids) : Promise.resolve({ data: [] }),
    ]);
    r.hc = { prior: rev.error ? [] : (rev.data || []), off: !!rev.error, v2: !pl.error, players: new Map((pl.data || []).map(x => [x.id, x])), edit: r.hc && r.hc.edit || null };
    const pending = r.hc.v2 && !r.hc.off && app.committee ? hcRows(r).filter(x => !x.done && x.next != null) : [];
    if (pending.length && !r.hcApplying) { r.hcApplying = true; await hcApply(r, pending); r.hcApplying = false; return; }
    if (app.round && app.round.id === r.id && app.round.tab === "setup") renderRoundBody();
  }

  const hcDate = x => String((x.events && x.events.event_date) || x.approved_at || "");

  // Finishing positions for the cuts: per division when the round has them.
  function hcPositions(r) {
    const split = r.setup && r.setup.division_split;
    const groups = split ? [r.players.filter(p => p.index != null && p.index <= split), r.players.filter(p => !(p.index != null && p.index <= split))] : [r.players];
    const pos = new Map();
    groups.forEach(g => S.stablefordBoard(r.holes, g).forEach(x => { if (x.sum.complete) pos.set(x.player.id, x.pos); }));
    return pos;
  }

  function hcSuggest(r, p, positions) {
    const h = r.hcps.get(p.id) || {};
    const cutUsed = Number(h.cut) || 0;
    // The index going into the round, before any temporary cut.
    const old = p.index == null ? null : Math.round((Number(p.index) + cutUsed) * 10) / 10;
    const t = r.tee, par = parTotal(r);
    const sum = S.summarise(r.holes, p.scores, p.ph);
    const done = r.hc.prior.find(x => x.event_id === r.id && x.player_id === p.id);
    const out = { p, old, cutUsed, done, notes: [], diff: null };
    if (sum.thru === 18 && t && t.slope && t.course_rating != null && old != null) {
      const ch = S.courseHandicap(old, t.slope, t.course_rating, par);
      out.ags = S.adjustedGross(r.holes, p.scores, ch).ags;
      out.diff = S.differential(out.ags, t.slope, Number(t.course_rating));
    }
    const prior = r.hc.prior.filter(x => x.player_id === p.id && x.event_id !== r.id && x.differential != null)
      .sort((a, b) => hcDate(a).localeCompare(hcDate(b)));
    out.later = r.hc.prior.some(x => x.player_id === p.id && x.event_id !== r.id && hcDate(x) > String(r.event.event_date));
    if (out.diff == null) {
      out.next = old;
      out.notes.push(sum.thru < 18 ? "card not complete — no change" : old == null ? "no index" : "tee has no slope or rating — no change");
    } else {
      const diffs = prior.map(x => Number(x.differential)).concat([out.diff]);
      const res = S.societyIndex({ old, diffs, diff: out.diff });
      out.next = res.next; out.whs = res.whs;
      if (res.whs) out.notes.push(`best ${res.whs.used} of ${res.whs.of}${res.whs.adjust ? ` ${res.whs.adjust}` : ""}`);
      else out.notes.push(`${diffs.length} of 3 cards needed — no change yet`), out.next = old;
      const fromPoints = prior.slice(-20).filter(x => x.source === "points").length;
      if (res.whs && fromPoints) out.notes.push(`${fromPoints} from points`);
      if (res.esr && res.whs) out.notes.push(`−${res.esr} exceptional score`);
      if (res.capped != null) out.notes.push(`capped at ${S.HC_STEP.toFixed(1)} a round until 20 cards (uncapped ${res.capped})`);
    }
    const pos = positions.get(p.id);
    out.pos = pos;
    out.cut = pos === 1 ? HC_CUTS[0] : pos === 2 ? HC_CUTS[1] : 0;
    if (cutUsed) out.notes.push(`played off −${cutUsed} cut`);
    if (out.cut) out.notes.push(`−${out.cut} for the next round (${pos === 1 ? "winner" : "runner-up"})`);
    return out;
  }

  function hcRows(r) {
    const positions = hcPositions(r);
    return r.players.map(p => hcSuggest(r, p, positions));
  }

  async function hcApply(r, list) {
    let changed = 0, cuts = 0;
    for (const x of list) {
      const row = { event_id: r.id, player_id: x.p.id, old_index: x.old, differential: x.diff, ags: x.ags == null ? null : x.ags, whs_index: x.whs ? x.whs.index : null,
        cut: x.cut, new_index: x.next, note: x.notes.join(" · "), source: "card", approved_by: app.user.id, approved_at: new Date().toISOString() };
      const a = await client.from("handicap_reviews").upsert(row, { onConflict: "event_id,player_id" });
      if (a.error) { toast("Handicaps not updated: " + a.error.message, true); return; }
      // A later round already worked out? Then this one is history only.
      if (x.later) continue;
      const upd = {};
      if (x.next != null && x.next !== Number((r.hc.players.get(x.p.id) || {}).handicap)) { upd.handicap = x.next; changed++; }
      if (x.cut) { upd.hcp_cut = x.cut; upd.hcp_cut_note = `−${x.cut} for ${x.pos === 1 ? "winning" : "runner-up in"} ${r.event.name}`; cuts++; }
      if (Object.keys(upd).length) {
        const b = await client.from("players").update(upd).eq("id", x.p.id);
        if (b.error) { toast(b.error.message, true); return; }
      }
    }
    toast(`Handicaps worked out: ${changed} changed${cuts ? `, ${cuts} cut${cuts > 1 ? "s" : ""} for the next round` : ""}`);
    await loadHcReview(r);
  }

  async function hcOverride(r, pid) {
    const input = document.querySelector(`[data-hc="${pid}"]`);
    const val = input && input.value !== "" ? Math.round(Number(input.value) * 10) / 10 : null;
    if (val == null || isNaN(val) || val < -10 || val > 54) { toast("Enter an index between −10 and 54.", true); return; }
    const x = hcRows(r).find(y => y.p.id === pid);
    const note = ((x.done && x.done.note) || "") + ` · changed by the committee to ${val}`;
    const a = await client.from("handicap_reviews").update({ new_index: val, overridden: true, note: note.replace(/^ · /, ""), approved_by: app.user.id }).eq("event_id", r.id).eq("player_id", pid);
    if (a.error) { toast(a.error.message, true); return; }
    if (!x.later) { const b = await client.from("players").update({ handicap: val }).eq("id", pid); if (b.error) { toast(b.error.message, true); return; } }
    toast("Handicap changed");
    r.hc.edit = null;
    loadHcReview(r);
  }

  function hcReviewCard(r) {
    if (!r.setup || r.setup.status !== "final" || r.event.is_practice) return "";
    if (!r.hc) { loadHcReview(r); return `<div class="card"><h2>Handicaps</h2><p class="small muted">Working out the new handicaps…</p></div>`; }
    if (r.hc.off || !r.hc.v2) return `<div class="card"><h2>Handicaps</h2><p class="small muted">Society handicaps need a database update before they can work.</p></div>`;
    const rows = hcRows(r);
    const pending = rows.filter(x => !x.done && x.next != null);
    const cutRows = rows.filter(x => (x.done ? Number(x.done.cut) : x.cut) > 0);
    return `<div class="card" id="hc-review"><h2>Handicaps</h2>
      <p class="small muted" style="margin-top:0">Worked out for everyone when the round finished: each card's differential, then the best 8 of the last 20 (fewer while there aren't 20). No index moves more than 2.0 in a round until a player has 20 cards. Every member can see the working on each player's profile.</p>
      ${cutRows.length ? `<div class="hc-cuts">${cutRows.map(x => `<span><b>${esc(x.p.name)}</b> −${x.done ? Number(x.done.cut) : x.cut} next round</span>`).join("")}</div>` : ""}
      ${rows.map(x => { const d = x.done; const val = d ? d.new_index : x.next; const editing = r.hc.edit === x.p.id;
        return `<div class="hc-row">
        <div class="hc-who"><b><a href="#/stats/${x.p.id}">${esc(x.p.name)}</a></b><span class="thru">${(d ? d.differential : x.diff) != null ? `Differential ${Number(d ? d.differential : x.diff).toFixed(1)} · ` : ""}${esc(d && d.note ? d.note : x.notes.join(" · "))}</span></div>
        <div class="hc-vals"><span class="hc-old">${x.old == null ? "?" : x.old}</span><span class="muted">→</span>
          ${editing ? `<input class="hc-input" data-hc="${x.p.id}" type="number" step="0.1" value="${val == null ? "" : val}"><button class="btn gold" style="min-height:34px" data-action="hc-save" data-player="${x.p.id}">Save</button>`
            : `<span class="hc-new${val != null && x.old != null && val < x.old ? " down" : val != null && x.old != null && val > x.old ? " up" : ""}">${val == null ? "–" : val}</span>${d ? `${d.overridden ? '<span class="hc-tag">changed</span>' : ""}${app.committee ? `<button class="mv-link" data-action="hc-edit" data-player="${x.p.id}">Change</button>` : ""}` : ""}`}</div></div>`; }).join("")}
      ${pending.length && app.committee ? `<button class="btn gold block" style="margin-top:10px" data-action="hc-apply">Work out ${pending.length} handicap${pending.length > 1 ? "s" : ""}</button>` : ""}
    </div>`;
  }

  // ---------- side contests: the stake on the hole ----------
  // The committee picks the holes on the admin page. A group names whoever
  // is in front; a later group that beats them adds their player under it,
  // just like the names written on the stake. The committee checks the
  // stake at the end and confirms the winner.

  const COMP_ICON = { ld: "🏌️", np: "📍", np2: "🎯" };
  const compKind = c => c.id.startsWith("ld") ? "ld" : c.id.startsWith("np2") ? "np2" : "np";
  function contestsOn(r) {
    if (r.contestsOff || !window.ROUND_COMPETITIONS) return [];
    return window.ROUND_COMPETITIONS.map(c => ({ ...c, holeNo: window.competitionHole(r.event, c) })).filter(c => c.holeNo);
  }
  const contestsOnHole = (r, hole) => contestsOn(r).filter(c => c.holeNo === hole);
  function stakeOf(r, compId) {
    return r.claims.filter(c => c.comp === compId).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }
  const playerName = (r, id) => { const p = r.players.find(x => x.id === id); return p ? p.name : "A player"; };
  const leaderOf = (r, compId) => { const st = stakeOf(r, compId); return st.length ? st[st.length - 1] : null; };
  const confirmedOf = (r, c) => r.prizes && r.prizes[c.winner] ? r.prizes[c.winner] : null;

  function contestsCard(r) {
    const cs = contestsOn(r);
    if (!cs.length) return "";
    return `<div class="card contests-card">
      <h2>Side contests</h2>
      ${cs.map(c => {
        const lead = leaderOf(r, c.id);
        const conf = confirmedOf(r, c);
        return `<button class="contest-row" data-action="stake" data-comp="${c.id}">
          <span class="ct-ico">${COMP_ICON[compKind(c)]}</span>
          <span class="ct-what"><b>${esc(c.label)}</b><span class="thru">Hole ${c.holeNo} · ${esc(c.nine)}</span></span>
          <span class="ct-who">${conf ? `<span class="tick">✓</span> ${esc(conf)}` : lead ? `${esc(shortName(playerName(r, lead.player_id)))}<span class="thru">in front</span>` : `<span class="muted small">No name yet</span>`}</span>
        </button>`;
      }).join("")}
    </div>`;
  }

  function stakeSheet(r, compId, fromHole) {
    const c = contestsOn(r).find(x => x.id === compId);
    if (!c) return;
    const st = stakeOf(r, compId);
    const lead = st[st.length - 1];
    const live = r.setup && r.setup.status === "live";
    const players = selectedPlayers(r).length ? selectedPlayers(r) : r.me ? [r.me] : [];
    const canClaim = live && (r.me || r.canManage);
    const conf = confirmedOf(r, c);
    openSheet(`
      <div class="kp-title">${COMP_ICON[compKind(c)]} ${esc(c.label)}</div>
      <div class="kp-facts">Hole ${c.holeNo} · ${esc(c.nine)}${conf ? ` · <b>Winner: ${esc(conf)}</b>` : ""}</div>
      <div class="stake">
        ${st.length ? st.map((x, i) => `<div class="stake-name${i === st.length - 1 ? " lead" : ""}">
            <span class="sn-n">${i + 1}</span>
            <span class="sn-who"><b>${esc(playerName(r, x.player_id))}</b><span class="thru">named by ${esc(entrant(r, x.claimed_by))} · ${new Date(x.created_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span></span>
            ${i === st.length - 1 ? `<span class="badge final">In front</span>` : ""}
            ${(app.user && x.claimed_by === app.user.id && i === st.length - 1) || r.canManage ? `<button class="mv-link" data-action="unstake" data-id="${x.id}" data-comp="${c.id}">${r.canManage ? "Remove" : "Undo"}</button>` : ""}
          </div>`).join("") : `<p class="muted small" style="margin:0">No name on the stake yet.</p>`}
      </div>
      ${canClaim ? `<p class="small muted" style="margin:12px 0 6px">${fromHole ? "Anyone in your group in front?" : "Who's in front now?"}</p>
        <div class="stake-claims">${players.filter(p => !lead || p.id !== lead.player_id).map(p =>
          `<button class="btn gold" data-action="stake-claim" data-comp="${c.id}" data-player="${p.id}">${esc(shortName(p.name))} is in front</button>`).join("")}</div>` : ""}
      <button class="btn ghost block" style="margin-top:10px" data-action="close-sheet">${fromHole && st.length ? "Nobody beat it" : "Done"}</button>
      ${r.canManage && lead && !conf ? `<button class="btn block" style="margin-top:8px" data-action="confirm-contest" data-comp="${c.id}">Confirm ${esc(playerName(r, lead.player_id))} as winner</button>` : ""}
      <p class="small muted" style="margin-top:10px">The real stake on the hole still counts — the committee checks it against this before announcing the winner.</p>`);
  }

  async function claimStake(r, compId, playerId) {
    const { data, error } = await client.from("contest_claims").insert({ event_id: r.id, comp: compId, player_id: playerId, claimed_by: app.user.id }).select().single();
    if (error) { toast(error.message, true); return; }
    if (!r.claims.some(c => c.id === data.id)) r.claims.push(data);
    buzz(15);
    toast(`${playerName(r, playerId)} is on the stake`);
    stakeSheet(r, compId);
    renderRoundBody();
  }

  async function confirmContest(r, compId) {
    const c = contestsOn(r).find(x => x.id === compId);
    const lead = c && leaderOf(r, compId);
    if (!lead) return;
    const name = playerName(r, lead.player_id);
    const row = { event_id: r.id, updated_at: new Date().toISOString() };
    row[c.winner] = name;
    const { error } = await client.from("event_prizes").upsert(row, { onConflict: "event_id" });
    if (error) { toast(error.message, true); return; }
    r.prizes = { ...(r.prizes || {}), ...row };
    toast(`${name} confirmed — ${c.label}, ${c.nine}`);
    stakeSheet(r, compId);
    renderRoundBody();
  }

  function contestsSetupCard(r) {
    const cs = contestsOn(r);
    return `<div class="card">
      <h2>Side contests</h2>
      ${cs.length ? `<p class="small muted" style="margin-top:0">Players add names to each stake as they play. Check the real stakes when they come in, then confirm the winners — they go on the Results page with the other prizes.</p>
        ${cs.map(c => { const lead = leaderOf(r, c.id); const conf = confirmedOf(r, c);
          return `<div class="row settle-row" style="flex-direction:row;align-items:center">
            <div><strong>${esc(c.label)}</strong> <span class="muted small">hole ${c.holeNo}, ${esc(c.nine)}</span>
              <div class="thru">${conf ? `<span class="tick">✓</span> Confirmed: ${esc(conf)}` : lead ? `In front: ${esc(playerName(r, lead.player_id))} · ${stakeOf(r, c.id).length} on the stake` : "No names yet"}</div></div>
            <span class="spacer"></span><button class="btn ghost" style="min-height:34px" data-action="stake" data-comp="${c.id}">Stake</button></div>`; }).join("")}`
        : `<p class="small muted" style="margin:0">No side contests on this round. Set the holes for longest drive and nearest the pin on the <a href="../admin.html">admin page</a> and they appear here.</p>`}
    </div>`;
  }

  function contestsBoard(r) {
    const cs = contestsOn(r);
    return `<div class="card">${cs.map(c => {
      const st = stakeOf(r, c.id); const conf = confirmedOf(r, c);
      return `<div class="ct-board" data-action="stake" data-comp="${c.id}">
        <div class="row"><span class="ct-ico">${COMP_ICON[compKind(c)]}</span><div><b>${esc(c.label)}</b><div class="thru">Hole ${c.holeNo} · ${esc(c.nine)}</div></div><span class="spacer"></span>
          ${conf ? `<span class="badge final">Winner</span>` : st.length ? `<span class="badge">${st.length} on the stake</span>` : ""}</div>
        <div class="ct-names">${conf ? `<b>${esc(conf)}</b>` : st.length ? st.map((x, i) => i === st.length - 1 ? `<b>${esc(playerName(r, x.player_id))}</b>` : `<s>${esc(playerName(r, x.player_id))}</s>`).join(" → ") : `<span class="muted">No name yet</span>`}</div>
      </div>`; }).join("")}</div>`;
  }

  // ---------- the live feed ----------

  function feedName(r, profileId) {
    if (app.user && profileId === app.user.id) return "You";
    const f = r.field.find(x => x.profile_id === profileId);
    return f ? f.name : "Committee";
  }
  const timeOf = iso => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const ordinal = n => n + ((n % 100 >= 11 && n % 100 <= 13) ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
  const photoUrl = path => client.storage.from("gallery").getPublicUrl(path).data.publicUrl;

  function updateFeedBadge() {
    const r = app.round, b = document.getElementById("feed-badge");
    if (!r || !b) return;
    const seen = store.get("feed-seen-" + r.id, "");
    const n = r.tab === "feed" ? 0 : r.posts.filter(p => String(p.created_at) > seen && !(app.user && p.author_id === app.user.id)).length;
    b.hidden = !n; b.textContent = n > 9 ? "9+" : String(n);
  }

  function feedView(r) {
    const canPost = !!(r.me || r.canManage);
    const composer = canPost ? `<div class="card composer">
      <textarea id="feed-text" rows="2" maxlength="500" placeholder="Say something to the field…"></textarea>
      <div class="row" style="margin-top:8px">
        <label class="btn ghost" style="min-height:40px">📷 Photo<input type="file" id="feed-photo" accept="image/*" hidden></label>
        <span class="small muted" id="feed-photo-name"></span>
        <span class="spacer"></span>
        <button class="btn" style="min-height:40px" data-action="post">Post</button>
      </div>
      <label class="small muted gallery-opt" id="feed-gallery-opt" hidden><input type="checkbox" id="feed-gallery"> Also put it in the society gallery (after committee approval)</label>
    </div>` : "";
    if (!r.posts.length) return composer + `<div class="card empty"><p>Nothing yet.</p><p class="small">Birdies, eagles and names on the stakes appear here by themselves as the round goes on.</p></div>`;
    return composer + r.posts.map(p => postCard(r, p)).join("");
  }

  function postCard(r, p) {
    const likes = r.likes.filter(l => l.post_id === p.id);
    const mine = app.user && likes.some(l => l.profile_id === app.user.id);
    const comments = r.comments.filter(c => c.post_id === p.id);
    const open = r.openComments === p.id;
    let head, body = "";
    if (p.kind === "auto") {
      const [label, strokes] = String(p.body || "").split("|");
      const h = r.holes.find(x => x.hole === p.hole);
      const ico = label === "Hole in one" ? "🎉" : label === "Albatross" || label === "Eagle" ? "🦅" : "🐦";
      head = `<div class="post-auto"><span class="pa-ico">${ico}</span><div><b>${esc(label)}!</b> ${esc(playerName(r, p.player_id))} on the ${ordinal(p.hole)}
        <div class="thru">${esc(strokes)} on a par ${h ? h.par : "?"}${Number(strokes) === 2 ? " · a 2" : ""} · ${timeOf(p.created_at)}</div></div></div>`;
    } else if (p.kind === "contest") {
      const c = (window.ROUND_COMPETITIONS || []).find(x => x.id === p.body);
      head = `<div class="post-auto"><span class="pa-ico">${c ? COMP_ICON[compKind(c)] : "📍"}</span><div><b>${esc(playerName(r, p.player_id))}</b> is in front · ${c ? esc(c.label) : "side contest"}${c ? `, hole ${window.competitionHole(r.event, c) || ""}` : ""}
        <div class="thru">named by ${esc(feedName(r, p.author_id))} · ${timeOf(p.created_at)}</div></div></div>`;
    } else {
      head = `<div class="post-head">${avatar(feedName(r, p.author_id) === "You" ? (r.me ? r.me.name : "You") : feedName(r, p.author_id), p.author_id)}<div><b>${esc(feedName(r, p.author_id))}</b><div class="thru">${timeOf(p.created_at)}</div></div></div>`;
      if (p.kind === "photo") body += `<img class="post-photo" src="${esc(photoUrl(p.photo_path))}" alt="" loading="lazy" data-action="photo" data-src="${esc(photoUrl(p.photo_path))}">`;
      if (p.body) body += `<p class="post-body">${esc(p.body)}</p>`;
    }
    const canDelete = (app.user && p.author_id === app.user.id && (p.kind === "text" || p.kind === "photo")) || r.canManage;
    return `<div class="card post pk-${p.kind}">
      ${head}${body}
      <div class="post-foot">
        <button class="pf-btn${mine ? " on" : ""}" data-action="like" data-post="${p.id}">👏 ${likes.length || ""}</button>
        <button class="pf-btn" data-action="comments" data-post="${p.id}">💬 ${comments.length || ""}</button>
        <span class="spacer"></span>
        ${canDelete ? `<button class="pf-btn" data-action="delete-post" data-post="${p.id}" aria-label="Delete">🗑</button>` : ""}
      </div>
      ${open ? `<div class="comments">${comments.map(c => `<div class="comment"><b>${esc(feedName(r, c.author_id))}</b> ${esc(c.body)}
          ${(app.user && c.author_id === app.user.id) || r.canManage ? `<button class="mv-link" data-action="delete-comment" data-id="${c.id}">Delete</button>` : ""}</div>`).join("")}
        <div class="row" style="margin-top:6px"><input class="comment-input" id="comment-${p.id}" maxlength="300" placeholder="Add a comment…"><button class="btn" style="min-height:38px" data-action="comment" data-post="${p.id}">Send</button></div></div>` : ""}
    </div>`;
  }

  async function postToFeed(r) {
    const text = ($("#feed-text").value || "").trim();
    const file = $("#feed-photo").files && $("#feed-photo").files[0];
    if (!text && !file) { toast("Write something or add a photo first.", true); return; }
    const btn = view.querySelector("[data-action=post]");
    btn.disabled = true; btn.textContent = file ? "Uploading…" : "Posting…";
    let photo_path = null;
    try {
      if (file) {
        photo_path = `feed/${r.id}/${(crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36))}.jpg`;
        const up = window.ImageResize ? await window.ImageResize.uploadPhoto(client, "gallery", photo_path, file)
          : await client.storage.from("gallery").upload(photo_path, file, { contentType: file.type || "image/jpeg" });
        if (up.error) throw up.error;
        if ($("#feed-gallery") && $("#feed-gallery").checked) {
          await client.from("photos").insert({ event_id: r.id, uploader_id: app.user.id, storage_path: photo_path, caption: text || null, status: "pending" });
        }
      }
      const { data, error } = await client.from("round_posts").insert({ event_id: r.id, author_id: app.user.id, kind: file ? "photo" : "text", body: text || null, photo_path }).select().single();
      if (error) throw error;
      if (!r.posts.some(x => x.id === data.id)) r.posts.unshift(data);
      renderRoundBody();
    } catch (e) {
      toast(e.message || "Couldn't post that — try again.", true);
      btn.disabled = false; btn.textContent = "Post";
    }
  }

  async function toggleLike(r, postId) {
    const mine = r.likes.find(l => l.post_id === postId && l.profile_id === app.user.id);
    if (mine) {
      r.likes = r.likes.filter(l => l !== mine);
      renderRoundBody();
      await client.from("round_post_likes").delete().eq("post_id", postId).eq("profile_id", app.user.id);
    } else {
      r.likes.push({ post_id: postId, profile_id: app.user.id });
      buzz(8); renderRoundBody();
      const { error } = await client.from("round_post_likes").insert({ post_id: postId, profile_id: app.user.id });
      if (error && !/duplicate/i.test(error.message)) toast(error.message, true);
    }
  }

  async function addComment(r, postId) {
    const el = document.getElementById("comment-" + postId);
    const body = (el && el.value || "").trim();
    if (!body) return;
    const { data, error } = await client.from("round_post_comments").insert({ post_id: postId, author_id: app.user.id, body }).select().single();
    if (error) { toast(error.message, true); return; }
    if (!r.comments.some(c => c.id === data.id)) r.comments.push(data);
    el.value = "";
    if (document.activeElement) document.activeElement.blur();
    renderRoundBody();
  }

  // ---------- sharing a card or a board as a picture ----------

  async function shareCanvas(canvas, filename, text) {
    const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
    const file = new File([blob], filename, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], text }); return; }
      catch (e) { if (e && e.name === "AbortError") return; }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Picture saved — share it from your photos or downloads");
  }

  const NAVY = "#10233F", NAVY2 = "#1B3A6C", GOLD = "#B8923C", GOLD2 = "#D9BE7C", INK = "#171F30", SOFT = "#57617A", GREEN = "#1E7A46", RED = "#C0392B";
  async function fontsReady() {
    try { await Promise.all([document.fonts.load("600 40px Oswald"), document.fonts.load("600 20px Inter"), document.fonts.load("400 20px Inter")]); } catch (e) { /* draw with fallbacks */ }
  }
  function shareHeader(ctx, W, r, crest, title) {
    const g = ctx.createLinearGradient(0, 0, W, 0); g.addColorStop(0, NAVY); g.addColorStop(1, NAVY2);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, 230);
    ctx.fillStyle = GOLD; ctx.fillRect(0, 230, W, 8);
    if (crest) ctx.drawImage(crest, 60, 52, 126, 126);
    ctx.fillStyle = GOLD2; ctx.font = "600 26px Inter, sans-serif"; ctx.fillText("THE FALKNERS ARMS GOLF SOCIETY", 214, 88);
    ctx.fillStyle = "#fff"; ctx.font = "600 64px Oswald, 'Arial Narrow', sans-serif"; ctx.fillText(title.toUpperCase(), 214, 156);
    ctx.fillStyle = "#C9D3E3"; ctx.font = "400 28px Inter, sans-serif";
    ctx.fillText(`${r.event.name} · ${r.course ? r.course.name : r.event.venue || ""} · ${fmtDate(r.event.event_date, { day: "numeric", month: "short", year: "numeric" })}`, 214, 200);
  }
  function loadImg(src) { return new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }); }
  function roundRect(ctx, x, y, w, h, rad) { ctx.beginPath(); ctx.moveTo(x + rad, y); ctx.arcTo(x + w, y, x + w, y + h, rad); ctx.arcTo(x + w, y + h, x, y + h, rad); ctx.arcTo(x, y + h, x, y, rad); ctx.arcTo(x, y, x + w, y, rad); ctx.closePath(); }

  async function shareCard(r, playerId) {
    const p = r.players.find(x => x.id === playerId);
    if (!p) return;
    await fontsReady();
    const crest = await loadImg("icons/icon-192.png");
    const sum = S.summarise(r.holes, p.scores, p.ph);
    const W = 1080, H = 1350, c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#EEF1F6"; ctx.fillRect(0, 0, W, H);
    shareHeader(ctx, W, r, crest, p.name);
    // headline numbers
    const tiles = [[String(sum.points), "POINTS"], [sum.pickups ? "NR" : sum.thru ? String(sum.gross) : "–", "GROSS"], [String(p.ph == null ? "?" : p.ph), "PLAYS OFF"], [sum.complete ? "F" : String(sum.thru), "THRU"]];
    tiles.forEach(([v, l], i) => {
      const x = 60 + i * 245;
      ctx.fillStyle = i === 0 ? GOLD : "#fff"; roundRect(ctx, x, 280, 225, 170, 24); ctx.fill();
      ctx.fillStyle = i === 0 ? NAVY : NAVY2; ctx.font = "600 84px Oswald, sans-serif"; ctx.textAlign = "center"; ctx.fillText(v, x + 112, 385);
      ctx.fillStyle = i === 0 ? NAVY : SOFT; ctx.font = "600 22px Inter, sans-serif"; ctx.fillText(l, x + 112, 425); ctx.textAlign = "left";
    });
    const nine = (from, top, label) => {
      const hs = r.holes.slice(from, from + 9);
      ctx.fillStyle = "#fff"; roundRect(ctx, 60, top, W - 120, 330, 24); ctx.fill();
      const x0 = 190, cw = (W - 120 - 130 - 110) / 9;
      ctx.font = "600 24px Inter, sans-serif"; ctx.fillStyle = SOFT;
      ["HOLE", "PAR", "SCORE", "PTS"].forEach((t, i) => ctx.fillText(t, 84, top + 62 + i * 75));
      hs.forEach((h, i) => {
        const cx = x0 + i * cw + cw / 2; const x = sum.holes[h.hole];
        ctx.textAlign = "center";
        ctx.fillStyle = NAVY2; ctx.font = "600 30px Oswald, sans-serif"; ctx.fillText(String(h.hole), cx, top + 62);
        ctx.fillStyle = INK; ctx.font = "400 28px Inter, sans-serif"; ctx.fillText(String(h.par), cx, top + 137);
        if (x.played) {
          const d = x.picked_up ? 0 : x.strokes - h.par;
          ctx.fillStyle = x.picked_up ? "#6b7280" : d < 0 ? GREEN : d > 0 ? "#FBE4E1" : "#EEF2F8";
          ctx.beginPath(); ctx.arc(cx, top + 203, 30, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = x.picked_up || d < 0 ? "#fff" : d > 0 ? RED : INK; ctx.font = "600 32px Oswald, sans-serif";
          ctx.fillText(x.picked_up ? "P" : String(x.strokes), cx, top + 215);
          ctx.fillStyle = SOFT; ctx.font = "600 26px Inter, sans-serif"; ctx.fillText(String(x.points), cx, top + 287);
        }
        ctx.textAlign = "left";
      });
      const pts = hs.reduce((t, h) => t + (sum.holes[h.hole].played ? sum.holes[h.hole].points : 0), 0);
      ctx.textAlign = "center"; ctx.fillStyle = NAVY2; ctx.font = "600 24px Inter, sans-serif"; ctx.fillText(label, W - 115, top + 62);
      ctx.font = "600 40px Oswald, sans-serif"; ctx.fillText(String(pts), W - 115, top + 287); ctx.textAlign = "left";
    };
    nine(0, 490, "OUT"); nine(9, 850, "IN");
    ctx.fillStyle = SOFT; ctx.font = "400 26px Inter, sans-serif"; ctx.textAlign = "center";
    ctx.fillText("thefalknersarmsgolfsociety.co.uk", W / 2, H - 50); ctx.textAlign = "left";
    await shareCanvas(c, `${p.name.replace(/\s+/g, "-")}-${r.event.name.replace(/\s+/g, "-")}.png`, `${p.name}: ${sum.points} points at ${r.event.name}`);
  }

  async function shareBoard(r, kind) {
    await fontsReady();
    const crest = await loadImg("icons/icon-192.png");
    let rows;
    if (kind === "pairs") rows = S.pairsBoard(r.holes, r.pairs || []).filter(x => x.started).map(x => ({ pos: x.pos, tied: x.tied, name: x.pair.players.map(p => p.name).join(" & "), thru: x.complete ? "F" : String(x.thru), pts: x.points }));
    else rows = S.stablefordBoard(r.holes, r.players).filter(x => x.sum.thru).map(x => ({ pos: x.pos, tied: x.tied, name: x.player.name, thru: x.sum.complete ? "F" : String(x.sum.thru), pts: x.sum.points }));
    rows = rows.slice(0, 16);
    const W = 1080, rowH = 66, H = Math.max(900, 330 + rows.length * rowH + 120);
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#EEF1F6"; ctx.fillRect(0, 0, W, H);
    shareHeader(ctx, W, r, crest, kind === "pairs" ? "Pairs leaderboard" : "Leaderboard");
    ctx.fillStyle = "#fff"; roundRect(ctx, 60, 280, W - 120, rows.length * rowH + 70, 24); ctx.fill();
    ctx.font = "600 22px Inter, sans-serif"; ctx.fillStyle = SOFT;
    ctx.fillText(kind === "pairs" ? "PAIR" : "PLAYER", 190, 322); ctx.textAlign = "right"; ctx.fillText("THRU", 840, 322); ctx.fillText("PTS", 980, 322); ctx.textAlign = "left";
    rows.forEach((x, i) => {
      const y = 350 + i * rowH;
      if (i) { ctx.fillStyle = "#E3E8F0"; ctx.fillRect(84, y, W - 168, 2); }
      const medal = x.pos === 1 ? GOLD : x.pos === 2 ? "#C9CED8" : x.pos === 3 ? "#D8B48F" : "#E6EAF2";
      ctx.fillStyle = medal; ctx.beginPath(); ctx.arc(126, y + 33, 24, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = NAVY; ctx.font = "600 26px Oswald, sans-serif"; ctx.textAlign = "center"; ctx.fillText((x.tied ? "T" : "") + x.pos, 126, y + 43); ctx.textAlign = "left";
      ctx.fillStyle = INK; ctx.font = `600 ${kind === "pairs" ? 26 : 30}px Inter, sans-serif`;
      let name = x.name; while (ctx.measureText(name).width > 590 && name.length > 4) name = name.slice(0, -2);
      ctx.fillText(name === x.name ? name : name + "…", 170, y + 44);
      ctx.fillStyle = SOFT; ctx.font = "400 26px Inter, sans-serif"; ctx.textAlign = "right"; ctx.fillText(x.thru, 840, y + 44);
      ctx.fillStyle = NAVY2; ctx.font = "600 40px Oswald, sans-serif"; ctx.fillText(String(x.pts), 980, y + 47); ctx.textAlign = "left";
    });
    ctx.fillStyle = SOFT; ctx.font = "400 26px Inter, sans-serif"; ctx.textAlign = "center";
    ctx.fillText(r.setup && r.setup.status === "final" ? "Final" : `Live · ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`, W / 2, H - 80);
    ctx.fillText("thefalknersarmsgolfsociety.co.uk", W / 2, H - 40); ctx.textAlign = "left";
    await shareCanvas(c, `${r.event.name.replace(/\s+/g, "-")}-${kind === "pairs" ? "pairs" : "leaderboard"}.png`, `${r.event.name} ${kind === "pairs" ? "pairs " : ""}leaderboard`);
  }

  // ---------- leaderboards ----------

  function boardView(r) {
    const nr = notReady(r);
    if (nr) return nr;
    const formats = (r.setup.formats || ["stableford"]).filter(f => FORMAT_LABELS[f]);
    if (!formats.length) formats.push("stableford");
    if (contestsOn(r).length) formats.push("contests");
    if (!r.board || !formats.includes(r.board)) r.board = formats[0] || "stableford";
    const sub = formats.length > 1 ? `<div class="subtabs">${formats.map(f =>
      `<button data-action="board" data-board="${f}" aria-selected="${r.board === f}">${FORMAT_LABELS[f] || "Side contests"}</button>`).join("")}</div>` : "";
    let body = "";
    if (!r.players.length) body = `<div class="card empty">Nobody's on this round yet.</div>`;
    else if (r.board === "medal") body = medalTable(r);
    else if (r.board === "skins") body = skinsTable(r);
    else if (r.board === "contests") body = contestsBoard(r);
    else body = stablefordTable(r);
    return sub + body;
  }

  // ⚠ on a player with a disputed hole, ✓ once their card is in.
  function flags(r, p) {
    const d = disputesFor(r, [p]).length;
    return (d ? ` <span class="flag-disputed" title="${d} disputed hole${d > 1 ? "s" : ""}">⚠</span>` : "") +
      (r.submitted.has(p.id) ? ' <span class="tick" title="Card submitted">✓</span>' : "");
  }

  const posCell = (pos, tied) => pos == null ? "" : `<span class="medal ${pos <= 3 ? "p" + pos : ""}">${tied ? "T" : ""}${pos}</span>`;
  const thruText = sum => sum.complete ? "F" : sum.thru ? "Thru " + sum.thru : "–";
  const meClass = p => app.round.me && p.id === app.round.me.id ? "me" : "";

  // Who's moved since the last score came in. Positions are kept on the
  // phone per round, so arrows survive closing the app; they compare the
  // board now with the board before the latest change.
  function movement(r, key, rows, idOf) {
    const sig = Object.values(r.scores).reduce((t, h) => t + Object.keys(h || {}).length, 0);
    const k = `moves-${r.id}-${key}`;
    const saved = store.get(k, null);
    const now = {};
    rows.forEach(x => { if (x.pos != null && x.started !== false) now[idOf(x)] = x.pos; });
    let base = saved ? saved.base : {};
    if (!saved || saved.sig !== sig) { base = saved ? saved.pos : {}; store.set(k, { sig, pos: now, base }); }
    return id => {
      const was = base[id], is = now[id];
      if (was == null || is == null || was === is) return "";
      const n = was - is;
      return `<span class="move ${n > 0 ? "up" : "down"}" aria-label="${n > 0 ? "up" : "down"} ${Math.abs(n)}">${n > 0 ? "▲" : "▼"}${Math.abs(n)}</span>`;
    };
  }

  function liveLine(r) {
    if (!r.setup || r.setup.status !== "live") return "";
    const t = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return `<div class="live-line"><span class="dot"></span>Live · updated ${t}</div>`;
  }

  // The top of the board, Golfify style: who's leading and by how much.
  // Results for a round scored off the app: podium, side contests and the
  // full table. Prizes the committee recorded beat the raw order, because
  // ties are settled on the day - the same as the website.
  function resultsView(r) {
    const rows = r.results.slice().sort((a, b) => Number(b.points) - Number(a.points) || (a.gross_score || 999) - (b.gross_score || 999));
    const p = r.prizes || {};
    const nm = x => (x && x.players && x.players.name) || "Unknown";
    const prof = x => x && x.players && x.players.profile_id;
    const mine = x => app.user && prof(x) === app.user.id;
    const byName = new Map(rows.map(x => [nm(x).trim().toLowerCase(), x]));
    const who = text => String(text).split(/\s*&\s*/).map(part => {
      const x = byName.get(part.trim().toLowerCase());
      return x ? `<a href="#/stats/${esc(x.player_id)}">${esc(part.trim())}</a>` : esc(part.trim());
    }).join(" &amp; ");
    const podium = [["p1", "1st", p.first_place, rows[0]], ["p2", "2nd", p.second_place, rows[1]], ["p3", "3rd", p.third_place, rows[2]]]
      .map(([cls, label, prize, row]) => {
        const text = prize && String(prize).trim() ? String(prize).trim() : row ? nm(row) : "";
        if (!text) return "";
        const x = byName.get(text.toLowerCase()) || (prize ? null : row);
        return `<div class="rs-pod ${cls}">${x ? avatar(nm(x), prof(x), "rs-av") : `<span class="avatar rs-av"><i>${initials(text)}</i></span>`}
          <span class="rs-place">${label}</span><b>${who(text)}</b>${x && x.points != null ? `<span class="rs-pts">${x.points} pts</span>` : ""}</div>`;
      }).join("");
    const contests = (window.ROUND_COMPETITIONS || []).map(c => {
      const v = p[c.winner]; if (!v || !String(v).trim()) return "";
      const hole = window.competitionHole ? window.competitionHole(r.event, c) : null;
      return `<div class="rs-ct"><span class="rs-ico">${COMP_ICON[compKind(c)] || "🏅"}</span><div><small>${esc(window.competitionName ? window.competitionName(c) : c.title)}${hole ? ` · hole ${hole}` : ""}</small><b>${who(v)}</b></div></div>`;
    }).join("");
    const pair = p.winning_pair && String(p.winning_pair).trim()
      ? `<div class="rs-ct"><span class="rs-ico">🤝</span><div><small>Winning pair</small><b>${who(p.winning_pair)}</b></div></div>` : "";
    const meRow = rows.findIndex(mine);
    return `
      ${podium ? `<div class="rs-podium">${podium}</div>` : ""}
      ${meRow >= 0 ? `<div class="card rs-you"><span>You finished</span><b>${meRow + 1}<small>${ordinal(meRow + 1).replace(/^\d+/, "")}</small></b><span>of ${rows.length} · ${rows[meRow].points} pts</span></div>` : ""}
      ${contests || pair ? `<div class="card"><h2>On the day</h2><div class="rs-cts">${pair}${contests}</div></div>` : ""}
      <div class="card board-card"><table class="board">
        <thead><tr><th></th><th colspan="2">Player</th><th class="num">HCP</th><th class="num">Pts</th></tr></thead>
        <tbody>${rows.map((x, i) => `
          <tr class="${mine(x) ? "me" : ""}">
            <td class="pos">${posCell(i + 1)}</td>
            <td class="av">${avatar(nm(x), prof(x), mine(x) ? "me" : "")}</td>
            <td><a class="rs-name" href="#/stats/${esc(x.player_id)}"><strong>${esc(nm(x))}</strong></a>${x.gross_score ? `<div class="thru">Gross ${x.gross_score}</div>` : ""}</td>
            <td class="num thru">${x.handicap == null ? "–" : esc(String(x.handicap))}</td>
            <td class="num"><span class="big">${x.points == null ? "–" : x.points}</span></td>
          </tr>`).join("")}</tbody></table>
        <p class="small muted" style="margin:10px 0 0">${rows.length} players · tap a name for their season</p></div>`;
  }

  function leaderCard(label, name, big, unit, sub) {
    return `<div class="leader-card">
      <div class="lc-label">${label}</div>
      <div class="lc-name">${name}</div>
      <div class="lc-score"><b>${big}</b> ${unit}</div>
      <div class="lc-sub">${sub}</div>
    </div>`;
  }

  // Two divisions when the round splits them: up to the split index, then
  // the rest. Each has its own winner (and its own handicap cuts).
  function divisionsOf(r) {
    const split = r.setup && r.setup.division_split;
    if (!split) return null;
    return [{ n: 1, label: `Division 1 · up to ${split}`, short: `Div 1 · up to ${split}`, players: r.players.filter(p => p.index != null && p.index <= split) },
            { n: 2, label: `Division 2 · ${split + 1} and over`, short: `Div 2 · ${split + 1}+`, players: r.players.filter(p => !(p.index != null && p.index <= split)) }];
  }

  function stablefordTable(r) {
    const divs = divisionsOf(r);
    if (!divs) return stablefordDiv(r, r.players, "stableford", null);
    if (!r.div || !divs.some(d => d.n === r.div)) r.div = r.me && divs[1].players.some(p => p.id === r.me.id) ? 2 : 1;
    const d = divs.find(x => x.n === r.div);
    return `<div class="subtabs div-tabs">${divs.map(x => `<button data-action="division" data-div="${x.n}" aria-selected="${x.n === r.div}">${esc(x.short)} <span class="div-n">${x.players.length}</span></button>`).join("")}</div>`
      + stablefordDiv(r, d.players, "stableford-d" + d.n, d.label);
  }

  function stablefordDiv(r, players, key, label) {
    const rows = S.stablefordBoard(r.holes, players);
    const started = rows.filter(x => x.sum.thru);
    const move = movement(r, key, rows.map(x => ({ ...x, started: !!x.sum.thru })), x => x.player.id);
    let hero = "";
    if (started.length) {
      const top = started.filter(x => x.pos === 1);
      const next = started.find(x => x.pos > 1);
      const lead = next ? top[0].sum.points - next.sum.points : 0;
      hero = leaderCard((top.length > 1 ? "Joint leaders" : "Leader") + (label ? ` · ${esc(label.split(" · ")[0])}` : ""),
        top.map(x => esc(x.player.name)).join(" &amp; "), top[0].sum.points, "pts",
        `${top.length > 1 ? "" : thruText(top[0].sum) + (lead > 0 ? ` · ${lead} clear` : "")}`);
    }
    return `${liveLine(r)}${hero}<div class="card board-card"><table class="board">
      <thead><tr><th></th><th colspan="2">Player</th><th class="num">Thru</th><th class="num">Pts</th></tr></thead>
      <tbody>${rows.map(x => `
        <tr data-player="${x.player.id}" class="${meClass(x.player)}">
          <td class="pos">${x.sum.thru ? posCell(x.pos, x.tied) : ""}${move(x.player.id)}</td>
          <td class="av">${avatar(x.player.name, x.player.profileId, meClass(x.player) ? "me" : "")}</td>
          <td><strong>${esc(x.player.name)}</strong>${flags(r, x.player)}<div class="thru">PH ${x.player.ph == null ? "?" : x.player.ph} · Out ${x.sum.front} · In ${x.sum.back}</div></td>
          <td class="num thru">${thruText(x.sum)}</td>
          <td class="num"><span class="big">${x.sum.points}</span></td>
        </tr>`).join("")}</tbody></table>
      <p class="small muted" style="margin:10px 0 0">Tap a player for their card. Ties on a finished card go to countback: last 9, 6, 3, then 1.</p></div>
      ${started.length ? `<button class="btn ghost block share-btn" data-action="share-board" data-kind="stableford">Share leaderboard</button>` : ""}
      ${started.length ? `<div class="row" style="gap:8px;margin-bottom:14px">
        <a class="btn ghost" style="flex:1" href="#/present/${r.id}/tv">📺 TV leaderboard</a>
        ${r.canManage ? `<a class="btn gold" style="flex:1" href="#/present/${r.id}">🏆 Prize-giving</a>` : ""}</div>` : ""}`;
  }

  function medalTable(r) {
    const gross = !!r.gross;
    const rows = S.medalBoard(r.holes, r.players, gross);
    const move = movement(r, gross ? "gross" : "net", rows.map(x => ({ ...x, started: !!x.sum.thru && !x.nr })), x => x.player.id);
    return `${liveLine(r)}
      <div class="subtabs">
        <button data-action="gross" data-gross="0" aria-selected="${!gross}">Net</button>
        <button data-action="gross" data-gross="1" aria-selected="${gross}">Gross</button>
      </div>
      <div class="card"><table class="board">
      <thead><tr><th></th><th colspan="2">Player</th><th class="num">Thru</th><th class="num">${gross ? "Gross" : "Net"}</th><th class="num">To par</th></tr></thead>
      <tbody>${rows.map(x => `
        <tr data-player="${x.player.id}" class="${meClass(x.player)}">
          <td class="pos">${posCell(x.pos)}${move(x.player.id)}</td>
          <td class="av">${avatar(x.player.name, x.player.profileId, meClass(x.player) ? "me" : "")}</td>
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
    const move = movement(r, "pairs", rows, x => "p" + x.pair.number);
    const top = rows.filter(x => x.started && x.pos === 1);
    const hero = top.length ? leaderCard(top.length > 1 ? "Joint leading pairs" : "Leading pair",
      top.map(x => x.pair.players.map(p => esc(p.name)).join(" &amp; ")).join("<br>"), top[0].points, "pts",
      top.length > 1 ? "" : (top[0].complete ? "Both finished" : `Thru ${top[0].thru}`)) : "";
    return `${liveLine(r)}${hero}${top.length ? `<button class="btn ghost block share-btn" style="margin:-4px 0 12px" data-action="share-board" data-kind="pairs">Share pairs leaderboard</button>` : ""}
      <div class="card board-card"><table class="board">
      <thead><tr><th></th><th>Pair</th><th class="num">Thru</th><th class="num">Pts</th></tr></thead>
      <tbody>${rows.map(x => `
        <tr data-pair="${x.pair.number}" class="${mine.has(x.pair.number) ? "me" : ""}">
          <td class="pos">${x.started ? posCell(x.pos, x.tied) : ""}${move("p" + x.pair.number)}</td>

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
    const practice = !!(r.event.is_practice || r.event.is_private);
    const kind = r.event.is_private ? "game" : "practice round";
    const statusBtns = practice
      ? (s.status === "setup" || !r.setup ? `<button class="btn gold block" data-action="go-live">Start the ${kind} — open scoring</button>`
        : s.status === "live" ? `<button class="btn block" data-action="${r.event.is_private ? "finish-game" : "set-status"}" data-status="final">Finish the ${kind}</button>
           <button class="btn ghost block" data-action="set-status" data-status="setup" style="margin-top:8px">Pause scoring</button>`
        : `<button class="btn ghost block" data-action="set-status" data-status="live">Reopen scoring</button>`)
        + `<button class="btn ghost block danger-text" data-action="practice-delete" style="margin-top:8px">Delete this ${kind}</button>`
      : s.status === "setup" || !r.setup
      ? `<button class="btn gold block" data-action="go-live">Publish round — open scoring</button>`
      : s.status === "live"
        ? `<button class="btn block" data-action="finalise">Finish round & copy points to Results</button>
           <button class="btn ghost block" data-action="set-status" data-status="setup" style="margin-top:8px">Unpublish — pause scoring</button>`
        : `<button class="btn ghost block" data-action="set-status" data-status="live">Republish — reopen scoring</button>
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
        <label class="field">Minutes between tee groups
          <input type="number" name="tee_interval" min="0" max="30" step="1" inputmode="numeric" value="${s.tee_interval != null ? s.tee_interval : ""}" placeholder="e.g. 8 — leave blank if not known">
        </label>
        <label class="field">Divisions — split the leaderboard at index
          <input type="number" name="division_split" min="1" max="53" step="1" inputmode="numeric" value="${s.division_split != null ? s.division_split : ""}" placeholder="e.g. 18 — leave blank for one leaderboard">
        </label>
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
        <p class="small muted">${!r.setup ? "Not set up yet. Save the course above and players can preview the round." : s.status === "setup" ? "<b>Preview</b> — players can see the card, groups and handicaps, and check in. Nobody can score until you publish." : s.status === "live" ? "<b>Published</b> — anyone on the round can score." : "<b>Finished</b> — scores are locked."}</p>
        ${missingPh ? `<p class="status-msg err">${missingPh} player${missingPh > 1 ? "s have" : " has"} no playing handicap yet.</p>` : ""}
        ${statusBtns}
      </div>

      ${r.setup && r.tee ? `<div class="card"><h2>Print pack</h2><p class="small muted" style="margin-top:0">The start sheet, a paper card for every group with the shots marked, and a sheet for each stake. A backup if phones or signal fail.</p>
        <a class="btn ghost block" href="#/print/${r.id}">🖨️ Open the print pack</a></div>` : ""}
      ${checkinsSetupCard(r)}
      ${r.contestsOff ? "" : contestsSetupCard(r)}
      ${practice ? "" : adminsCard(r)}
      ${r.event.is_private ? guestsCard(r) : ""}
      ${practice ? "" : hcReviewCard(r)}
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
      if (f.has("tee_interval") && !r.noTeeInterval) row.tee_interval = f.get("tee_interval") === "" ? null : Math.max(0, Math.min(30, Number(f.get("tee_interval"))));
      if (!row.formats.length) row.formats = ["stableford"];
      if (!r.setup) row.status = "setup";
      if (!row.tee_id) { st.hidden = false; st.className = "status-msg err"; st.textContent = "Choose a course and tee first."; return false; }
      const tee = setupCache.tees.find(t => t.id === row.tee_id);
      if (tee && tee.holeCount !== 18) { st.hidden = false; st.className = "status-msg err"; st.textContent = "That tee doesn't have all 18 holes yet — finish it under Courses."; return false; }
      if (f.has("division_split")) row.division_split = f.get("division_split") === "" ? null : Math.max(1, Math.min(53, Math.round(Number(f.get("division_split")))));
      st.hidden = false; st.className = "status-msg"; st.textContent = "Saving…";
      let { error } = await client.from("event_scoring").upsert(row, { onConflict: "event_id" });
      if (error && /division_split/.test(error.message || "")) {
        delete row.division_split;
        if (f.get("division_split")) toast("Divisions need a database update first — saved without them.", true);
        ({ error } = await client.from("event_scoring").upsert(row, { onConflict: "event_id" }));
      }
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
    // Winners' and runners-up's temporary cuts come off this round only.
    if (!r.event.is_practice && !r.event.is_private) {
      const cut = await client.rpc("take_handicap_cuts", { p_event: r.id });
      if (!cut.error && cut.data) toast(`${cut.data} handicap cut${cut.data > 1 ? "s" : ""} taken for this round`);
    }
    await setStatus(r, "live");
  }

  async function setStatus(r, status) {
    const { error } = await client.from("event_scoring").update({ status, updated_at: new Date().toISOString() }).eq("event_id", r.id);
    if (error) { toast(error.message, true); return; }
    toast(status === "live" ? "Round published — scoring is open" : status === "final" ? "Round finished" : "Unpublished — scoring paused");
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
    if (r.event.is_practice) { setStatus(r, "final"); return; }
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
    if (!app.approved) { view.innerHTML = `<div class="card empty">Members only.</div>`; return; }
    view.innerHTML = `<div class="loading">Loading courses…</div>`;
    const { courses, tees } = await loadCourses();
    const { data: geoRows } = await client.from("course_hole_geo").select("course_id, tee_lat, green_lat");
    courses.forEach(c => { c.mapped = (geoRows || []).filter(g => g.course_id === c.id && g.tee_lat != null && g.green_lat != null).length; });
    view.innerHTML = `
      <h1>Courses</h1>
      <p class="small muted">Any member can add a course or a tee from its scorecard. Put in the par and stroke index for every hole, and the course rating and slope if you have them, so handicaps work out properly.</p>
      <div class="card ci-list">${courses.map(c => { const ts = tees.filter(t => t.course_id === c.id); const y = ts.find(t => t.name.toLowerCase() === DEFAULT_TEE) || ts[0]; return `
        <a class="ci-row" href="#/courses/${c.id}"><span class="ci-ico">${ICO_FLAG}</span><span class="ci-label">${esc(c.name)}<small>${esc(c.address || "")}</small></span><span class="ci-right">${y && y.par ? "Par " + y.par : ts.length ? "" : "No scorecard"}</span><span class="ci-chev">›</span></a>`; }).join("")}
      </div>
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

  // ---------- course page and course preview ----------

  // Typical club distances, used only when your bag is empty (and said so).
  const TYPICAL_BAG = [["DR", 220], ["3W", 200], ["5W", 185], ["4H", 175], ["5I", 165], ["6I", 155], ["7I", 145], ["8I", 135], ["9I", 125], ["PW", 110], ["GW", 95], ["SW", 80]]
    .map(([club, distance]) => ({ club, distance, kind: "club" }));
  const clubName = code => (CLUB.get(code) || { name: code }).name;

  // The plan for a hole: driver off the tee on longer holes, then the club
  // that leaves the shortest next shot. If a full shot would leave an
  // awkward half-wedge, lay up to your shortest full club instead.
  function planHole(yds, par, bagIn) {
    const bag = (bagIn || []).filter(x => x.club && x.club !== "PT" && x.distance > 0);
    if (!bag.length || !(yds > 0)) return null;
    const dr = bag.find(x => x.club === "DR");
    const irons = bag.filter(x => x.club !== "DR").sort((a, b) => a.distance - b.distance || kitOrder(b) - kitOrder(a));
    const fair = irons.length ? irons : [dr];
    const longest = fair[fair.length - 1], shortest = fair[0];
    const shots = [];
    let left = yds;
    while (left > 15 && shots.length < 6) {
      const first = !shots.length;
      const reach = fair.find(x => x.distance >= left - 5);
      let c, finish = false;
      if (reach && !(first && par >= 4 && dr && left > reach.distance + 5)) { c = reach; finish = true; }
      else if (first && par >= 4 && dr && dr.distance >= longest.distance) c = dr;
      else {
        c = longest;
        const after = left - c.distance;
        if (after > 15 && after < shortest.distance - 10) {
          const target = left - shortest.distance;
          c = fair.find(x => x.distance >= target - 5) || longest;
        }
      }
      const carry = finish ? left : Math.min(c.distance, left);
      left = Math.max(0, left - carry);
      shots.push({ club: c.club, distance: c.distance, carry, leaves: left, finish, part: finish && c.distance - carry > 15 });
      if (finish) break;
    }
    const onIn = shots.length;
    return { shots, onIn, regulation: Math.max(1, par - 2), short: left > 15 ? left : 0 };
  }

  const coursePack = { id: null, data: null };
  async function loadCoursePack(courseId, fresh) {
    if (!fresh && coursePack.id === courseId && coursePack.data) return coursePack.data;
    const [{ data: course }, { data: tees }, { data: geoRows }, avg, notes] = await Promise.all([
      client.from("courses").select("*").eq("id", courseId).maybeSingle(),
      client.from("course_tees").select("*").eq("course_id", courseId).order("name"),
      client.from("course_hole_geo").select("*").eq("course_id", courseId),
      client.rpc("course_hole_averages", { p_course: courseId }),
      client.from("course_notes").select("*").eq("course_id", courseId).order("created_at", { ascending: false }),
    ]);
    if (!course) return null;
    const teeIds = (tees || []).map(t => t.id);
    const { data: holes } = teeIds.length ? await client.from("course_holes").select("*").in("tee_id", teeIds) : { data: [] };
    const authors = [...new Set((notes.data || []).map(n => n.author_id))];
    const { data: who } = authors.length ? await client.from("players").select("profile_id, name").in("profile_id", authors).is("guest_event_id", null) : { data: [] };
    const d = {
      course, tees: tees || [],
      holes: new Map(), geo: new Map((geoRows || []).map(g => [g.hole, g])),
      avg: new Map(((avg && avg.data) || []).map(a => [a.hole, a])), avgOk: !(avg && avg.error),
      notes: notes.data || [], notesOk: !notes.error,
      names: new Map((who || []).map(p => [p.profile_id, p.name])),
    };
    d.tees.forEach(t => d.holes.set(t.id, (holes || []).filter(h => h.tee_id === t.id).sort((a, b) => a.hole - b.hole)));
    d.rounds = Math.max(0, ...[...d.avg.values()].map(a => a.rounds || 0));
    // hardest first, by the society's average over par
    d.ranked = [...d.avg.values()].filter(a => a.cards >= 3).sort((a, b) => b.over_par - a.over_par).map(a => a.hole);
    Object.assign(coursePack, { id: courseId, data: d });
    return d;
  }
  function packTee(d) {
    const saved = store.get("preview-tee-" + d.course.id, null);
    const withHoles = d.tees.filter(t => (d.holes.get(t.id) || []).length);
    return withHoles.find(t => t.id === saved) || withHoles.find(t => t.name.toLowerCase() === DEFAULT_TEE) || withHoles[0] || null;
  }
  const holeYards = (d, h) => h.yards || (window.HoleMaps && d.geo.get(h.hole) && d.geo.get(h.hole).tee_lat != null && d.geo.get(h.hole).green_lat != null
    ? window.HoleMaps.yards({ lat: d.geo.get(h.hole).tee_lat, lng: d.geo.get(h.hole).tee_lng }, { lat: d.geo.get(h.hole).green_lat, lng: d.geo.get(h.hole).green_lng }) : null);
  const ICO_EYE = icon('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>');
  const ICO_CARD = icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11M15 9v11"/>');
  const ICO_NOTE = icon('<path d="M5 4h14v12l-4 4H5z"/><path d="M15 20v-4h4M8 9h8M8 13h5"/>');
  const ICO_FLAG = icon('<path d="M6 21V4"/><path d="M6 4h11l-2 4 2 4H6"/>');
  const ICO_PIN = icon('<path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>');

  async function renderCourseInfo(courseId) {
    if (!app.approved) { view.innerHTML = `<div class="card empty">Members only.</div>`; return; }
    view.innerHTML = `<div class="loading">Loading the course…</div>`;
    const d = await loadCoursePack(courseId, true);
    if (!d) { view.innerHTML = `<a class="back-link" href="#/courses">‹ Courses</a><div class="card status-msg err">Couldn't find that course.</div>`; return; }
    const tee = packTee(d);
    const holes = tee ? d.holes.get(tee.id) : [];
    const par = holes.reduce((s, h) => s + h.par, 0), yds = holes.reduce((s, h) => s + (h.yards || 0), 0);
    const hardest = d.ranked[0] || (holes.find(h => h.stroke_index === 1) || {}).hole;
    const notesN = d.notes.length;
    const mapped = [...d.geo.values()].filter(g => g.tee_lat != null && g.green_lat != null).length;
    const row = (href, ico, label, right, action) => `<${href ? `a href="${href}"` : `button type="button" data-action="${action}"`} class="ci-row"><span class="ci-ico">${ico}</span><span class="ci-label">${label}</span><span class="ci-right">${right || ""}</span><span class="ci-chev">›</span></${href ? "a" : "button"}>`;
    view.innerHTML = `
      <a class="back-link" href="#/courses">‹ Courses</a>
      <div class="ci-hero">
        <h1>${esc(d.course.name)}</h1>
        ${d.course.address ? `<a class="ci-addr" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.course.name + ", " + d.course.address)}" target="_blank" rel="noopener">${ICO_PIN}<span>${esc(d.course.address)}</span></a>` : ""}
        ${tee ? `<p class="ci-line">${holes.length} holes · Par ${par}${yds ? ` · ${yds.toLocaleString("en-GB")} yards` : ""} <span class="ci-tee"><i style="background:${esc(tee.colour || "#e3c33b")}"></i>${esc(tee.name)} tees</span></p>` : `<p class="ci-line">No scorecard yet</p>`}
      </div>
      <div class="card ci-stats">
        <div><b>${hardest || "–"}</b><span>Hardest hole${d.ranked.length ? "" : hardest ? " (SI 1)" : ""}</span></div>
        <div><b>${d.rounds || 0}</b><span>Society rounds here</span></div>
        <div><b>${mapped}/18</b><span>Holes mapped</span></div>
      </div>
      <div class="card ci-list">
        ${tee ? row(`#/preview/${courseId}/1`, ICO_EYE, "Course Preview", "Club plan, hole by hole") : ""}
        ${tee ? row(null, ICO_CARD, "Scorecard", tee.name, "ci-scorecard") : ""}
        ${row(null, ICO_NOTE, "Playing notes", String(notesN), "ci-notes")}
        ${app.committee ? row(`#/course-map/${courseId}`, ICO_FLAG, "Map the holes", `${mapped}/18`) : ""}
      </div>
      <div class="card">
        <h2>Tees</h2>
        <p class="small muted" style="margin-top:-4px">Tap a tee to check or correct its scorecard.</p>
        <div class="stack">
          ${d.tees.map(t => { const hs = d.holes.get(t.id) || []; return `
            <a class="row" href="#/course/${t.id}" style="text-decoration:none;color:inherit;padding:8px 0;border-top:1px solid var(--line)">
              <span style="width:16px;height:16px;border-radius:50%;border:1px solid var(--line);background:${esc(t.colour || "#ccc")}"></span>
              <strong>${esc(t.name)}</strong>
              <span class="muted small">${hs.length ? "Par " + hs.reduce((s, h) => s + h.par, 0) : ""}${t.course_rating ? " · CR " + t.course_rating : ""}${t.slope ? " · Slope " + t.slope : ""}</span>
              <span class="spacer"></span>${hs.length !== 18 ? `<span class="badge">${hs.length}/18</span>` : "›"}
            </a>`; }).join("")}
        </div>
        <button class="btn ghost block" style="margin-top:10px" data-action="new-tee" data-course="${courseId}">Add a tee</button>
      </div>`;
  }

  function courseCardSheet() {
    const d = coursePack.data; if (!d) return;
    const tee = packTee(d); const hs = tee ? d.holes.get(tee.id) : [];
    const line = (list, label) => `<tr class="sc-sum"><td>${label}</td><td>${list.reduce((s, h) => s + h.par, 0)}</td><td>${list.reduce((s, h) => s + (h.yards || 0), 0) || ""}</td><td></td><td></td></tr>`;
    const rowH = h => { const a = d.avg.get(h.hole); return `<tr><td><a href="#/preview/${d.course.id}/${h.hole}" data-action="close-sheet">${h.hole}</a></td><td>${h.par}</td><td>${h.yards || ""}</td><td>${h.stroke_index}</td><td>${a && a.cards >= 3 ? Number(a.avg_strokes).toFixed(1) : "–"}</td></tr>`; };
    openSheet(`<h2>Scorecard · ${esc(tee ? tee.name : "")}</h2>
      <table class="sc-table"><thead><tr><th>Hole</th><th>Par</th><th>Yds</th><th>SI</th><th>Society avg</th></tr></thead>
      <tbody>${hs.filter(h => h.hole <= 9).map(rowH).join("")}${line(hs.filter(h => h.hole <= 9), "Out")}
      ${hs.filter(h => h.hole > 9).map(rowH).join("")}${hs.some(h => h.hole > 9) ? line(hs.filter(h => h.hole > 9), "In") : ""}${line(hs, "Total")}</tbody></table>
      <p class="small muted">Society average is the strokes taken in society rounds here (pick-ups left out).</p>
      <button class="btn ghost block" style="margin-top:8px" data-action="close-sheet">Done</button>`);
  }

  function noteRows(d, list) {
    if (!list.length) return `<p class="small muted">No notes yet.</p>`;
    return list.map(n => `<div class="pv-note"><p>${esc(n.body)}</p><span class="small muted">${n.hole ? `Hole ${n.hole} · ` : ""}${esc(d.names.get(n.author_id) || "A member")} · ${fmtDate(String(n.created_at).slice(0, 10), { day: "numeric", month: "short", year: "numeric" })}
      ${n.author_id === app.user.id || app.committee ? ` · <a href="#" data-action="note-del" data-id="${n.id}">Delete</a>` : ""}</span></div>`).join("");
  }
  function noteForm(hole) {
    return `<form class="pv-note-form" data-hole="${hole || ""}"><textarea name="body" maxlength="300" rows="2" required placeholder="${hole ? "e.g. Ditch across the fairway at 220. Aim left of the oak." : "e.g. Greens are quick in summer. Buggies only on paths."}"></textarea>
      <button class="btn small" type="submit">Add note</button></form>`;
  }
  function notesSheet() {
    const d = coursePack.data; if (!d) return;
    if (!d.notesOk) { openSheet(`<h2>Playing notes</h2><p class="status-msg err">Playing notes need a database update before they can work.</p><button class="btn ghost block" data-action="close-sheet">Close</button>`); return; }
    openSheet(`<h2>Playing notes</h2><p class="small muted" style="margin-top:-4px">Tips for the whole course. Notes for a single hole are added in the Course Preview.</p>
      ${noteForm(null)}<div class="pv-notes">${noteRows(d, d.notes)}</div>
      <button class="btn ghost block" style="margin-top:10px" data-action="close-sheet">Done</button>`);
  }

  async function addNote(form) {
    const d = coursePack.data; if (!d) return;
    const body = form.querySelector("textarea").value.trim();
    if (!body) return;
    const hole = form.dataset.hole ? Number(form.dataset.hole) : null;
    const { error } = await client.from("course_notes").insert({ course_id: d.course.id, hole, body, author_id: app.user.id });
    if (error) { toast(error.message, true); return; }
    toast("Note added");
    await loadCoursePack(d.course.id, true);
    if (hole) drawPreview(hole); else { notesSheet(); const r = document.querySelector(".ci-list [data-action=ci-notes] .ci-right"); if (r) r.textContent = coursePack.data.notes.length; }
  }
  async function deleteNote(id) {
    const d = coursePack.data; if (!d) return;
    if (!confirm("Delete this note?")) return;
    const { error } = await client.from("course_notes").delete().eq("id", id);
    if (error) { toast(error.message, true); return; }
    await loadCoursePack(d.course.id, true);
    if (location.hash.startsWith("#/preview/")) drawPreview(Number(location.hash.split("/")[3]) || 1); else notesSheet();
  }

  // A simple drawing of the hole, tee at the bottom, used until (or
  // unless) it's on the satellite map.
  function schematic(h, yds, plan) {
    const W = 300, H = 520, teeY = H - 34, greenY = 52;
    const at = y => teeY - (teeY - greenY) * Math.min(1, y / (yds || 1));
    const bend = (h.hole % 3 === 0 ? -1 : h.hole % 3 === 1 ? 1 : 0) * 26;
    const fairway = h.par >= 4 ? `<path d="M${W / 2 - 34} ${teeY - 70} C ${W / 2 - 40 + bend} ${H * 0.55}, ${W / 2 - 30 + bend} ${H * 0.3}, ${W / 2 - 24} ${greenY + 50} L ${W / 2 + 24} ${greenY + 50} C ${W / 2 + 30 + bend} ${H * 0.3}, ${W / 2 + 40 + bend} ${H * 0.55}, ${W / 2 + 34} ${teeY - 70} Z" fill="#5fae5a"/>` : "";
    let run = 0;
    const marks = plan ? plan.shots.map(s => { const y = at(run); run += s.carry;
      return `<circle cx="${W / 2}" cy="${y}" r="4" fill="#10233F" stroke="#fff" stroke-width="2"/><g transform="translate(${W / 2} ${y})"><rect x="-34" y="-24" width="68" height="20" rx="4" fill="#10233F"/><text x="0" y="-9.5" text-anchor="middle" fill="#fff" font-size="12" font-weight="700">${esc(clubShort(s.club))} ${s.carry}</text></g>`; }).join("") : "";
    return `<svg class="pv-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Drawing of hole ${h.hole}">
      <rect x="${W / 2 - 80}" y="0" width="160" height="${H}" rx="40" fill="#3f8f45"/>${fairway}
      <ellipse cx="${W / 2}" cy="${greenY}" rx="30" ry="22" fill="#7cc46a" stroke="#4a9a46"/>
      <rect x="${W / 2 - 12}" y="${teeY - 6}" width="24" height="14" rx="3" fill="#7cc46a" stroke="#4a9a46"/>
      <line x1="${W / 2}" y1="${teeY}" x2="${W / 2}" y2="${greenY}" stroke="#fff" stroke-width="2" opacity=".85"/>
      ${marks}<text x="${W / 2 + 2}" y="${greenY + 5}" text-anchor="middle" font-size="18" fill="#fff">⚑</text></svg>`;
  }

  async function renderPreview(courseId, hole) {
    if (!app.approved) { view.innerHTML = `<div class="card empty">Members only.</div>`; return; }
    if (!(coursePack.id === courseId && coursePack.data)) view.innerHTML = `<div class="loading">Loading the course…</div>`;
    const d = await loadCoursePack(courseId);
    if (!d) { view.innerHTML = `<div class="card status-msg err">Couldn't find that course.</div>`; return; }
    if (!app.bag) await loadMyBag();
    drawPreview(Math.min(18, Math.max(1, hole || 1)));
  }

  function drawPreview(holeNo) {
    const d = coursePack.data;
    const tee = packTee(d);
    if (!tee) { view.innerHTML = `<a class="back-link" href="#/courses/${d.course.id}">‹ ${esc(d.course.name)}</a><div class="card empty"><p>This course needs a scorecard first.</p></div>`; return; }
    const holes = d.holes.get(tee.id);
    const h = holes.find(x => x.hole === holeNo) || holes[0];
    const yds = holeYards(d, h);
    const mine = (app.bag || []).length > 0;
    const plan = planHole(yds, h.par, mine ? app.bag : TYPICAL_BAG);
    const a = d.avg.get(h.hole), rank = d.ranked.indexOf(h.hole);
    const g = d.geo.get(h.hole);
    const mapped = g && g.green_lat != null;
    const holeNotes = d.notes.filter(n => n.hole === h.hole);
    const nth = n => n + (["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
    const verdict = !plan ? "" : plan.onIn <= plan.regulation ? `<span class="pv-ok">On in ${plan.onIn}</span> · in regulation for a par ${h.par}`
      : `<span class="pv-warn">On in ${plan.onIn}</span> · ${plan.onIn - plan.regulation === 1 ? "one shot" : plan.onIn - plan.regulation + " shots"} more than regulation — your shot comes back on the green`;
    const teesWithCards = d.tees.filter(t => (d.holes.get(t.id) || []).length);
    view.innerHTML = `
      <div class="row pv-top">
        <a class="back-link" href="#/courses/${d.course.id}" style="margin:0">‹ ${esc(d.course.name)}</a><span class="spacer"></span>
        ${teesWithCards.length > 1 ? `<select class="pv-tee" data-pv-tee aria-label="Tee">${teesWithCards.map(t => `<option value="${t.id}" ${t.id === tee.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select>` : `<span class="small muted">${esc(tee.name)} tees</span>`}
      </div>
      <div class="pv-title"><span class="pv-hn">${h.hole}</span><b>Par ${h.par}, ${yds || "–"} Y, SI ${h.stroke_index}</b>${rank >= 0 && rank < 3 ? `<span class="pv-hard">${rank === 0 ? "Society's hardest" : nth(rank + 1) + " hardest"}</span>` : ""}</div>
      <div id="pv-map" class="pv-hole">${schematic(h, yds, plan)}</div>
      ${!mapped ? `<p class="small muted pv-unmapped">Drawn to scale from the card: this hole isn't on the satellite map yet${app.committee ? ` — <a href="#/course-map/${d.course.id}">map it</a>` : ""}.</p>` : ""}
      <div class="card pv-plan">
        <h2>Your club plan</h2>
        ${!mine ? `<p class="small pv-typical">Using <b>typical club distances</b>. <a href="#/me/bag">Add your clubs</a> for a plan built on yours.</p>` : ""}
        ${plan ? `<ol class="pv-shots">${plan.shots.map((s, i) => `<li><span class="pv-shot-n">${i === 0 ? "Tee" : nth(i + 1)}</span><span class="pv-club"><b>${esc(clubName(s.club))}</b>${s.part ? ` <span class="muted small">(part shot)</span>` : ""}</span><span class="pv-yds">${s.finish ? `<b>${s.carry}</b> to the green` : `<b>${s.carry}</b> · leaves ${s.leaves}`}</span></li>`).join("")}
          ${plan.short ? `<li><span class="pv-shot-n">Then</span><span class="pv-club">Chip from ${plan.short}</span><span class="pv-yds"></span></li>` : ""}</ol>
          <p class="pv-verdict">${verdict}</p>` : `<p class="small muted">No yardage for this hole yet, so there's no plan.</p>`}
      </div>
      <div class="card">
        <h2>The society on this hole</h2>
        ${a && a.cards >= 3 ? `<div class="pv-stats"><div><b>${Number(a.avg_strokes).toFixed(1)}</b><span>average score</span></div><div><b>${toPar(Math.round(a.over_par * 10) / 10)}</b><span>to par</span></div><div><b>${rank >= 0 ? nth(rank + 1) : "–"}</b><span>hardest of ${d.ranked.length}</span></div></div>
          <p class="small muted" style="margin:8px 0 0">From ${a.cards} cards over ${a.rounds} society round${a.rounds === 1 ? "" : "s"} here.</p>`
        : `<p class="small muted">${d.avgOk ? "Not enough society rounds here yet to show an average." : "Society averages need a database update before they can show."}</p>`}
      </div>
      <div class="card">
        <h2>Playing notes · hole ${h.hole}</h2>
        ${d.notesOk ? noteForm(h.hole) + `<div class="pv-notes">${noteRows(d, holeNotes)}</div>` : `<p class="small muted">Playing notes need a database update before they can work.</p>`}
      </div>
      <nav class="pv-holes" aria-label="Holes">${holes.map(x => `<button data-pv-hole="${x.hole}" class="${x.hole === h.hole ? "current" : ""}" aria-label="Hole ${x.hole}">${x.hole}</button>`).join("")}</nav>`;
    document.body.classList.add("has-pvholes");
    const cur = view.querySelector(".pv-holes .current");
    if (cur) { const nav = cur.parentElement; nav.scrollLeft = cur.offsetLeft - nav.clientWidth / 2 + cur.offsetWidth / 2; }
    history.replaceState(null, "", `#/preview/${d.course.id}/${h.hole}`);
    view.querySelectorAll("[data-pv-hole]").forEach(b => b.addEventListener("click", () => { drawPreview(Number(b.dataset.pvHole)); window.scrollTo(0, 0); }));
    const sel = view.querySelector("[data-pv-tee]");
    if (sel) sel.addEventListener("change", () => { store.set("preview-tee-" + d.course.id, sel.value); drawPreview(h.hole); });
    if (mapped && window.HoleMaps) {
      const real = g.tee_lat != null ? window.HoleMaps.yards({ lat: g.tee_lat, lng: g.tee_lng }, { lat: g.green_lat, lng: g.green_lng }) : yds;
      const shots = plan ? plan.shots.map(s => ({ carry: Math.round(s.carry * real / (yds || 1)), label: `${esc(clubShort(s.club))} <i>${s.carry}</i>` })) : [];
      window.HoleMaps.previewHole({ el: $("#pv-map"), g, shots }).catch(() => { /* keep the drawing */ });
    }
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
      <a class="back-link" href="#/courses/${courseId}">‹ ${esc(course.name)}</a>
      <h1>${esc(course.name)}</h1>
      <p class="small muted">Tap the map to drop the tee, then the middle of the green. Drag a pin to move it. Every round here uses these.</p>
      <div class="hole-strip" id="pe-holes">${Array.from({ length: 18 }, (_, i) => `<button data-pe-hole="${i + 1}" class="${i === 0 ? "current" : done(i + 1) ? "done" : ""}">${i + 1}</button>`).join("")}</div>
      <div class="row" style="margin-bottom:8px">
        <div class="subtabs" style="margin:0">
          <button data-pe-mode="tee" aria-selected="true">Tee</button>
          <button data-pe-mode="green" aria-selected="false">Middle of green</button>
          <button data-pe-mode="front" aria-selected="false">Front</button>
          <button data-pe-mode="back" aria-selected="false">Back</button>
        </div>
        <span class="spacer"></span>
        <span class="small" id="pe-yds"></span>
      </div>
      <div id="pe-host" class="pe-host"><div class="loading">Loading the satellite view…</div></div>
      <div class="row" style="margin-top:10px;gap:8px">
        <button class="btn ghost" id="pe-import">Import from OpenStreetMap</button>
        <button class="btn ghost" id="pe-edges">Find fronts &amp; backs</button>
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
                      green_lat: g.green_lat ?? null, green_lng: g.green_lng ?? null,
                      front_lat: g.front_lat ?? null, front_lng: g.front_lng ?? null, back_lat: g.back_lat ?? null, back_lng: g.back_lng ?? null,
                      updated_at: new Date().toISOString() };
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
    $("#pe-edges").addEventListener("click", async () => {
      const btn = $("#pe-edges"); btn.disabled = true;
      status("Measuring the greens from OpenStreetMap…");
      try {
        const found = await window.HoleMaps.greensFromOsm(geo, t => { btn.textContent = `Measuring ${t}`; });
        found.forEach((v, hole) => { const g = { ...(geo.get(hole) || {}), ...v }; geo.set(hole, g); saveHole(hole, g); });
        editor.refresh();
        const missing = [...geo.keys()].filter(h => !found.has(h));
        status(found.size ? `Front and back found for ${found.size} green${found.size > 1 ? "s" : ""}${missing.length ? `. Not drawn on OpenStreetMap: ${missing.sort((a, b) => a - b).join(", ")} — use the Front and Back buttons to place those by hand` : ""}.`
          : "None of these greens are drawn on OpenStreetMap — place the fronts and backs by hand.", found.size ? "ok" : "err");
      } catch (e) { status(e.message, "err"); }
      btn.disabled = false; btn.textContent = "Find fronts & backs";
    });
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
    if (!app.approved) { view.innerHTML = `<div class="card empty">Members only.</div>`; return; }
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
      <a class="back-link" href="#/courses/${tee.course_id}">‹ ${esc(tee.courses ? tee.courses.name : "Course")}</a>
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
      const st = e.target.closest("tr[data-stats]");
      if (st && st.dataset.stats && st.dataset.stats !== "undefined") { location.hash = "#/stats/" + st.dataset.stats; return; }
      const pr = e.target.closest("tr[data-pair]");
      if (pr && app.round) pairSheet(app.round, Number(pr.dataset.pair));
      return;
    }
    const r = app.round;
    const a = el.dataset.action;
    switch (a) {
      case "close-sheet": closeSheet(); break;
      case "guest-signout": await client.auth.signOut(); location.hash = "#/"; break;
      case "practice-new": practiceSheet(); break;
      case "fab": fabSheet(); break;
      case "ci-scorecard": courseCardSheet(); break;
      case "ci-notes": notesSheet(); break;
      case "stat-trend": statTrend(el.dataset.key); break;
      case "note-del": e.preventDefault(); deleteNote(el.dataset.id); break;
      case "main-tab": if (location.hash === el.dataset.href || (el.dataset.href === "#/" && !location.hash)) route(); else location.hash = el.dataset.href; break;
      case "fab-bag": closeSheet(); app.openKitAdd = true; if (location.hash === "#/me/bag") renderBag(null); else location.hash = "#/me/bag"; break;
      case "fab-register": closeSheet(); location.href = "../fixtures.html"; break;
      case "fab-course": closeSheet(); location.hash = "#/courses"; setTimeout(() => { const f = document.querySelector("#new-course input[name=name]"); if (f) { f.scrollIntoView({ block: "center" }); f.focus(); } }, 900); break;
      case "fab-checkin": { const e2 = await fabRound(false); closeSheet(); if (!e2) { toast("No society round set up yet to check in for.", true); break; } location.hash = "#/round/" + e2.id; break; }
      case "fab-post": { const e2 = await fabRound(true); closeSheet(); if (!e2) { toast("There's no live round to post to right now.", true); break; }
        const pr = store.get("round-" + e2.id, {}); pr.tab = "feed"; store.set("round-" + e2.id, pr); location.hash = "#/round/" + e2.id; break; }
      case "bag-tab": bagView.tab = el.dataset.tab; drawBag(); break;
      case "kit-add": kitSheet(null); break;
      case "kit-kind": kitSheet({ kind: el.dataset.kind }); break;
      case "kit-edit": kitSheet(bagView.data.find(x => x.id === el.dataset.id)); break;
      case "kit-retire": { const it = bagView.data.find(x => x.id === el.dataset.id); kitChange(el.dataset.id, it && it.retired ? "unretire" : "retire"); break; }
      case "kit-delete": if (confirm("Delete this from the bag? Retire keeps it listed instead.")) kitChange(el.dataset.id, "delete"); break;
      case "private-new": privateSheet(); break;
      case "private-create": createPrivate(); break;
      case "pg-add-guest": addGuestRow(); break;
      case "pg-del-guest": el.closest(".pg-guest").remove(); if (app.pgCount) app.pgCount(); break;
      case "finish-game": finishGame(r); break;
      case "guest-email": if (await emailInvite(el.dataset.invite)) toast("Invite emailed"); break;
      case "guest-share": { const inv = (r.invites || []).find(i => i.id === el.dataset.invite); if (inv) shareInvite(r, inv); break; }
      case "guest-new-invite": newInvite(r, el.dataset.player); break;
      case "division": if (r) { r.div = Number(el.dataset.div); renderRoundBody(); } break;
      case "hc-provisional": setProvisional(); break;
      case "practice-create": createPractice(); break;
      case "practice-delete": deletePractice(r); break;
      case "hide-tip": store.set("hide-install-tip", Date.now()); el.closest(".install-tip").remove(); break;
      case "install-help": $("#menu").hidden = true; installSheet(); break;
      case "push-help": $("#menu").hidden = true; pushSheet(); break;
      case "weather": if (r && r.wx) openSheet(`<h2>Forecast</h2><p class="small muted" style="margin-top:-4px">${esc(r.course ? r.course.name : r.event.venue || "")} · ${fmtDate(r.event.event_date)}</p>${window.FalknersWeather.html(r.wx)}<button class="btn ghost block" style="margin-top:12px" data-action="close-sheet">Done</button>`); break;
      case "present-next": if (present.i < present.slides.length - 1 && !present.tv) { present.i++; drawPresent(); } break;
      case "present-prev": if (present.i > 0) { present.i--; drawPresent(); } break;
      case "present-exit": exitPresent(); break;
      case "present-full": { const el2 = document.documentElement; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else if (el2.requestFullscreen) el2.requestFullscreen().catch(() => toast("Full screen isn't available here — use the browser's own full-screen option.", true)); else toast("Use your browser's full-screen option (on an iPad: Share → Add to Home Screen).", true); break; }
      case "print": window.print(); break;
      case "rec-year": records.year = el.dataset.year; drawRecords(); break;
      case "rc-tab": rc.tab = el.dataset.tab; if (rc.tab === "setup") await rcEnsureTees(); drawRyder(); window.scrollTo(0, 0); break;
      case "rc-create": await rcDo(client.from("rc_cups").insert({ event_id: rc.data.id }), "Ryder Cup set up — now name the teams"); rc.tab = "setup"; await rcEnsureTees(); drawRyder(); break;
      case "rc-save-cup": await rcDo(client.from("rc_cups").update({ team1_name: $("#rc-n1").value.trim() || "Team 1", team2_name: $("#rc-n2").value.trim() || "Team 2",
        team1_colour: $("#rc-c1").value, team2_colour: $("#rc-c2").value, allowance: Math.max(0, Math.min(100, Number($("#rc-allow").value) || 75)), updated_at: new Date().toISOString() }).eq("event_id", rc.data.id), "Teams saved"); break;
      case "rc-show-all": rc.showAll = !rc.showAll; drawRyder(); break;
      case "rc-captain": {
        const pid = el.dataset.player, on = !rc.data.captains.has(pid), side = rc.data.team.get(pid);
        // One captain a team: making a new one stands the old one down.
        if (on) for (const id of rc.data.captains) if (rc.data.team.get(id) === side) await client.from("rc_players").update({ captain: false }).eq("event_id", rc.data.id).eq("player_id", id);
        await rcDo(client.from("rc_players").update({ captain: on }).eq("event_id", rc.data.id).eq("player_id", pid), on ? "Captain picked" : "Captain removed");
        break;
      }
      case "rc-side": {
        const side = Number(el.dataset.side), pid = el.dataset.player;
        if (side) await rcDo(client.from("rc_players").upsert({ event_id: rc.data.id, player_id: pid, side }, { onConflict: "event_id,player_id" }));
        else await rcDo(client.from("rc_players").delete().eq("event_id", rc.data.id).eq("player_id", pid));
        break;
      }
      case "rc-add-session": {
        const name = $("#rc-new-name").value.trim();
        if (!name) { toast("Give the session a name.", true); break; }
        await rcDo(client.from("rc_sessions").insert({ event_id: rc.data.id, name, format: $("#rc-new-format").value, tee_id: $("#rc-new-tee").value || null, play_date: $("#rc-new-date").value || null, position: rc.data.sessions.length }), "Session added");
        break;
      }
      case "rc-add-match": { const sid = el.dataset.session; const n = rc.data.matches.filter(m => m.session_id === sid).length + 1;
        await rcDo(client.from("rc_matches").insert({ session_id: sid, event_id: rc.data.id, match_no: n })); break; }
      case "rc-del-match": if (confirm("Remove this match and any scores in it?")) await rcDo(client.from("rc_matches").delete().eq("id", el.dataset.id), "Match removed"); break;
      case "rc-del-session": if (confirm("Delete this session, its matches and their scores?")) await rcDo(client.from("rc_sessions").delete().eq("id", el.dataset.session), "Session deleted"); break;
      case "rc-sess-status": await rcDo(client.from("rc_sessions").update({ status: el.dataset.status }).eq("id", el.dataset.session),
        el.dataset.status === "live" ? "Scoring's open for this session" : "Session finished"); break;
      case "rc-cell": rcKeypad(el.dataset.match, el.dataset.player, Number(el.dataset.hole)); break;
      case "rc-kp": { const k = rc.kp; if (!k) break; k.pending = el.dataset.val === "P" ? "P" : Number(el.dataset.val);
        document.querySelectorAll("#sheet-body .kp-key[data-action=rc-kp]").forEach(b => b.classList.toggle("on", b === el));
        const ok = document.querySelector("#sheet-body .k-ok"); if (ok) ok.disabled = false; buzz(6); break; }
      case "rc-kp-ok": { const k = rc.kp; if (!k || k.pending == null) break;
        rcSave({ match_id: k.matchId, player_id: k.pid, hole: k.hole, strokes: k.pending === "P" ? null : k.pending, picked_up: k.pending === "P" });
        rcAfterKeypad(k.matchId, k.pid, k.hole); break; }
      case "rc-kp-clear": { const k = rc.kp; if (!k) break; rcSave({ match_id: k.matchId, player_id: k.pid, hole: k.hole, clear: true }); closeSheet(); drawRcMatch(k.matchId); break; }
      case "hc-edit": r.hc.edit = el.dataset.player; renderRoundBody(); break;
      case "hc-save": hcOverride(r, el.dataset.player); break;
      case "hc-apply": hcApply(r, hcRows(r).filter(x => !x.done && x.next != null)); break;
      case "text-size": $("#menu").hidden = true; textSizeSheet(); break;
      case "set-text-size": store.set("text-size", el.dataset.size); applyTextSize(el.dataset.size); textSizeSheet(); break;
      case "push-on":
        el.disabled = true;
        try { await enablePush(); toast("Notifications on"); const tip = el.closest(".install-tip"); if (tip) tip.remove(); if (!$("#sheet").hidden) pushSheet(); }
        catch (err) { toast(err.message, true); el.disabled = false; }
        break;
      case "push-off": await disablePush(); toast("Notifications off"); pushSheet(); break;
      case "hide-push-tip": store.set("hide-push-tip", true); el.closest(".install-tip").remove(); break;
      case "install-now":
        if (installEvent) { installEvent.prompt(); const c = await installEvent.userChoice.catch(() => null); installEvent = null; if (c && c.outcome === "accepted") { closeSheet(); toast("Installed — open it from your home screen"); } }
        break;
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
      case "prev-hole": if (r.hole > 1) { r.hole -= 1; r.anim = "back"; savePrefs(); renderRoundBody(); } break;
      case "set": setStroke(el.dataset.player, Number(el.dataset.val)); break;
      case "cell": keypadSheet(r, el.dataset.player, Number(el.dataset.hole)); break;
      // Tap a number to pick it, then the tick to confirm it.
      case "kp": {
        const k = r.kp;
        if (!k) break;
        k.pending = el.dataset.val === "P" ? "P" : Number(el.dataset.val);
        document.querySelectorAll("#sheet-body .kp-key[data-action=kp]").forEach(b => b.classList.toggle("on", b === el));
        const ok = document.querySelector("#sheet-body .k-ok"); if (ok) ok.disabled = false;
        buzz(6);
        break;
      }
      case "kp-putts": case "kp-fw": {
        const k = r.kp;
        if (!k) break;
        const field = a === "kp-putts" ? "putts" : "fairway";
        const v = a === "kp-putts" ? Number(el.dataset.val) : el.dataset.val;
        k[field] = k[field] === v ? null : v;
        el.parentElement.querySelectorAll(".kps-chip").forEach(b => b.classList.toggle("on", b === el && k[field] != null));
        k.statsDirty = true;
        break;
      }
      case "kp-stats-toggle": {
        store.set("stats-on", !store.get("stats-on", false));
        const k = r.kp;
        if (k) { const pend = k.pending; keypadSheet(r, k.player, k.hole); if (pend != null) { r.kp.pending = pend; const b = document.querySelector(`#sheet-body .kp-key[data-action=kp][data-val="${pend}"]`); document.querySelectorAll("#sheet-body .kp-key[data-action=kp]").forEach(x => x.classList.toggle("on", x === b)); } }
        break;
      }
      case "kp-ok": {
        const k = r.kp;
        if (!k || k.pending == null) break;
        if (k.statsDirty) saveHoleStats(r, k.player, k.hole, k.putts, k.fairway);
        r.hole = k.hole;
        const mine = myEntry(r, k.player, k.hole);
        const sc = (r.scores[k.player] || {})[k.hole];
        const cur = mine ? (mine.picked_up ? "P" : mine.strokes) : sc ? (sc.picked_up ? "P" : sc.strokes) : null;
        // Confirming the number already there still counts as this phone agreeing it.
        if (k.pending !== cur || !mine) setStroke(k.player, k.pending === "P" ? "pickup" : k.pending);
        afterKeypad(app.round, k.player, k.hole);
        break;
      }
      case "kp-clear": {
        const k = r.kp;
        if (!k) break;
        r.hole = k.hole;
        setStroke(k.player, "clear");
        keypadSheet(app.round, k.player, k.hole);
        break;
      }
      case "review-cards": submitSheet(r); break;
      case "add-admin": addAdmin(r); break;
      case "remove-admin": if (confirm("Remove this round admin?")) removeAdmin(r, el.dataset.profile); break;
      case "stake": stakeSheet(r, el.dataset.comp); break;
      case "stake-claim": claimStake(r, el.dataset.comp, el.dataset.player); break;
      case "unstake": {
        const { error } = await client.from("contest_claims").delete().eq("id", el.dataset.id);
        if (error) { toast(error.message, true); break; }
        r.claims = r.claims.filter(c => c.id !== el.dataset.id);
        stakeSheet(r, el.dataset.comp); renderRoundBody();
        break;
      }
      case "confirm-contest": confirmContest(r, el.dataset.comp); break;
      case "post": postToFeed(r); break;
      case "like": toggleLike(r, el.dataset.post); break;
      case "comments": r.openComments = r.openComments === el.dataset.post ? null : el.dataset.post; renderRoundBody(); break;
      case "comment": addComment(r, el.dataset.post); break;
      case "delete-post": {
        if (!confirm("Delete this post?")) break;
        const { error } = await client.from("round_posts").delete().eq("id", el.dataset.post);
        if (error) toast(error.message, true); else { r.posts = r.posts.filter(x => x.id !== el.dataset.post); renderRoundBody(); }
        break;
      }
      case "delete-comment": {
        const { error } = await client.from("round_post_comments").delete().eq("id", el.dataset.id);
        if (error) toast(error.message, true); else { r.comments = r.comments.filter(x => x.id !== el.dataset.id); renderRoundBody(); }
        break;
      }
      case "photo": openSheet(`<img src="${esc(el.dataset.src)}" alt="" style="width:100%;border-radius:12px;display:block">`); break;
      case "share-card": shareCard(r, el.dataset.player); break;
      case "share-board": shareBoard(r, el.dataset.kind); break;
      case "next-hole": {
        const missing = selectedPlayers(r).filter(p => !hasScore(p, r.hole));
        if (missing.length && canScore(r)) { missingSheet(r, missing, r.hole, r.hole === 18 ? "submit" : r.hole + 1); break; }
        if (r.hole === 18) submitSheet(r);
        else { r.hole += 1; r.anim = "fwd"; savePrefs(); renderRoundBody(); }
        break;
      }
      case "carry-on":
        closeSheet();
        if (el.dataset.to === "submit") submitSheet(r);
        else { r.hole = Number(el.dataset.to); r.anim = "fwd"; savePrefs(); renderRoundBody(); }
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
        if (error) toast(error.message, true); else { closeSheet(); toast("Agreed"); await reloadRound(true); }
        break;
      }
      case "ask-committee": {
        const { error } = await client.rpc("ask_committee", { p_event: r.id, p_player: el.dataset.player, p_hole: Number(el.dataset.hole) });
        if (error) toast(error.message, true); else { closeSheet(); toast("The committee's been told — they'll settle it from the scorecard."); await reloadRound(true); }
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
          course: r.course, holes: r.holes, geo: r.geo, hole: r.gpsHole || r.hole,
          onClose: hole => { store.set("gps-on", true); if (app.round) { app.round.hole = hole; savePrefs(); renderRoundBody(); } },
        });
        break;
    }
  });

  document.addEventListener("submit", e => {
    const f = e.target.closest && e.target.closest(".pv-note-form");
    if (!f) return;
    e.preventDefault(); addNote(f);
  });

  document.addEventListener("change", async e => {
    if (e.target && e.target.dataset && e.target.dataset.hc) return;
    const t = e.target;
    if (t && t.dataset && t.dataset.eg) { saveOfficial(t.dataset.eg, t.value); return; }
    if (t && t.dataset && t.dataset.rcPick && rc.data) {
      const m = rc.data.matches.find(x => x.id === t.dataset.rcPick);
      const key = t.dataset.side === "1" ? "side1" : "side2";
      const arr = m[key].slice(); arr[Number(t.dataset.i)] = t.value || null;
      const clean = arr.filter(Boolean);
      if (new Set(clean).size !== clean.length) { toast("That player's already in this match.", true); drawRyder(); return; }
      await rcDo(client.from("rc_matches").update({ [key]: clean }).eq("id", m.id));
      return;
    }
    if (t && t.dataset && t.dataset.rcSess && rc.data) {
      const v = t.value === "" ? null : t.value;
      if (t.dataset.field === "name" && !v) { drawRyder(); return; }
      await rcDo(client.from("rc_sessions").update({ [t.dataset.field]: v }).eq("id", t.dataset.rcSess));
      return;
    }
    if (e.target && (e.target.id === "h2h-a" || e.target.id === "h2h-b")) { records[e.target.id === "h2h-a" ? "a" : "b"] = e.target.value; drawRecords(); return; }
    if (e.target && e.target.id === "avatar-file") {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      toast("Uploading your picture…");
      try {
        let body = f;
        if (window.ImageResize) { const sized = await window.ImageResize.resize(f); if (sized && sized.thumb) body = sized.thumb; }
        const path = `${app.user.id}/${Date.now()}.jpg`;
        const up = await client.storage.from("avatars").upload(path, body, { upsert: true, contentType: body.type || "image/jpeg" });
        if (up.error) throw up.error;
        const url = client.storage.from("avatars").getPublicUrl(path).data.publicUrl;
        const { error } = await client.from("profiles").update({ avatar_url: url }).eq("id", app.user.id);
        if (error) throw error;
        app.avatars.set(app.user.id, url);
        store.set("avatars", Object.fromEntries(app.avatars));
        toast("Profile picture updated");
        route();
      } catch (err) { toast(err.message || "Couldn't upload that picture.", true); }
      return;
    }
    if (e.target && e.target.id === "feed-photo") {
      const f = e.target.files && e.target.files[0];
      $("#feed-photo-name").textContent = f ? f.name : "";
      $("#feed-gallery-opt").hidden = !f;
    }
  });

  // Swipe across the hole to move between holes, like turning a page.
  let swipe = null;
  document.addEventListener("touchstart", e => {
    const z = e.target.closest(".swipe-zone");
    if (!z || e.touches.length !== 1 || e.target.closest("input, select, .gps-bar")) { swipe = null; return; }
    swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  document.addEventListener("touchend", e => {
    if (!swipe || !app.round || app.round.tab !== "score") return;
    const t = e.changedTouches[0];
    const dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
    const quick = Date.now() - swipe.t < 700;
    swipe = null;
    if (!quick || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    const btn = document.querySelector(`.hole-nav [data-action=${dx < 0 ? "next-hole" : "prev-hole"}]`);
    if (btn && !btn.disabled) btn.click();
  }, { passive: true });

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
    if (parts[0] !== "present") { document.body.classList.remove("presenting"); clearInterval(present.timer); }
    if (parts[0] !== "print") document.body.classList.remove("printing-pack");
    if (parts[0] !== "preview") { document.body.classList.remove("has-pvholes"); if (window.HoleMaps && window.HoleMaps.closePreview) window.HoleMaps.closePreview(); }
    if (!((parts[0] === "round" || parts[0] === "present") && app.round && app.round.id === parts[1])) { unsubscribe(); app.round = null; }
    if (parts[0] !== "round" && parts[0] !== "ryder") hideTabbar();
    if (parts[0] !== "ryder" && parts[0] !== "rc" && rc.channel) { client.removeChannel(rc.channel); rc.channel = null; rc.data = null; }
    const hb = $("#home-btn");
    if (hb) hb.hidden = !app.user || !!app.guest || !(parts[0] && parts[0] !== "join");
    if (parts[0] === "join" && parts[1]) return renderJoin(parts[1]);
    if (!app.user) return renderSignIn();
    if (app.guest) {
      if (app.guest.ended || new Date(app.guest.until) < new Date()) return renderGuestEnded();
      if (!(parts[0] === "round" && parts[1] === app.guest.eventId)) { location.replace("#/round/" + app.guest.eventId); return; }
      return renderRound(parts[1], parts[2] === "start");
    }
    if (!app.approved) return renderNotApproved();
    const mainKey = parts[0] === "" ? "play" : ["season", "records", "me"].includes(parts[0]) ? parts[0]
      : ["stats", "statistics", "bag", "courses", "course", "handicaps"].includes(parts[0]) ? "" : null;
    if (mainKey != null) mainTabbar(mainKey);
    if (parts[0] === "round" && parts[1]) return renderRound(parts[1], parts[2] === "start");
    if (parts[0] === "courses") return parts[1] ? renderCourseInfo(parts[1]) : renderCourses();
    if (parts[0] === "preview" && parts[1]) return renderPreview(parts[1], Number(parts[2]) || 1);
    if (parts[0] === "season") return renderSeason();
    if (parts[0] === "records") return renderRecords();
    if (parts[0] === "handicaps") return renderHandicaps();
    if (parts[0] === "ryder" && parts[1]) return renderRyder(parts[1], parts[2]);
    if (parts[0] === "rc" && parts[1]) return renderRcMatch(parts[1]);
    if (parts[0] === "print" && parts[1]) return renderPrint(parts[1]);
    if (parts[0] === "present" && parts[1]) return renderPresent(parts[1], parts[2] === "tv");
    if (parts[0] === "me" && parts[1] === "bag") return renderBag(null);
    if (parts[0] === "bag" && parts[1]) return renderBag(parts[1]);
    if (parts[0] === "me" && parts[1] === "statistics") return renderStatistics(null);
    if (parts[0] === "statistics" && parts[1]) return renderStatistics(parts[1]);
    if (parts[0] === "me") return renderStats(null);
    if (parts[0] === "stats" && parts[1]) return renderStats(parts[1]);
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
