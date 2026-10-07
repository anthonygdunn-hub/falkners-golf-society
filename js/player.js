/* ------------------------------------------------------------------
   player.html?id=<player id> — one player's season.

   Order of Merit place, points, rounds, average and best score, a bar
   for every round of the season (gold for their best, a dashed gap for
   a round they missed, each one linking to that round's results), the
   prizes they've won and a round-by-round table.

   Reads the same public data as the leaderboard and results pages.
   Prizes are typed as free text by the committee, so they are matched
   to the player by name.
   ------------------------------------------------------------------ */
document.addEventListener("DOMContentLoaded", async () => {
  const id = new URLSearchParams(location.search).get("id");
  const nameEl = document.getElementById("pl-name");
  const fail = (msg) => {
    nameEl.textContent = "Player not found";
    document.getElementById("pl-sub").textContent = msg;
    ["pl-chart", "pl-prizes", "pl-rounds"].forEach(i => { document.getElementById(i).innerHTML = ""; });
  };
  if (!id) return fail("Pick a name on the leaderboard or results to see their season.");

  let data, prizes = [], rules = {};
  try {
    const client = getClient();
    const [all, prizeRes, playerRes, ls] = await Promise.all([
      fetchAllData(),
      client.from("event_prizes").select("*"),
      client.from("players").select("id, name, handicap, profile_id").eq("id", id).maybeSingle(),
      typeof fetchLeagueSettings === "function" ? fetchLeagueSettings() : Promise.resolve({})
    ]);
    data = all; prizes = prizeRes.data || []; rules = ls || {};
    data.player = playerRes.data;
  } catch (err) {
    console.error(err);
    return fail("Couldn't load this player just now. Please try again in a moment.");
  }
  if (!data.player) return fail("That player isn't in the society's list.");

  const player = data.player;
  const lower = player.name.trim().toLowerCase();
  document.title = player.name + " — The Falkners Arms Golf Society";
  nameEl.textContent = player.name;

  // The season shown is the one with the latest logged round.
  const rounds = (typeof seasonRounds === "function" ? seasonRounds(data.events) : data.events.filter(e => !e.is_trip));
  const scored = data.results.map(r => r.events?.event_date).filter(Boolean).sort();
  const season = (scored[scored.length - 1] || new Date().toISOString()).slice(0, 4);
  const seasonRoundsList = rounds.filter(e => e.event_date.slice(0, 4) === season).sort((a, b) => a.event_date.localeCompare(b.event_date));
  const seasonIds = new Set(seasonRoundsList.map(e => e.id));
  const seasonResults = data.results.filter(r => seasonIds.has(r.event_id));

  const mine = seasonResults.filter(r => r.player_id === id);
  const table = buildLeaderboard(seasonResults, rules);
  const idx = table.findIndex(e => e.playerId === id || e.name.trim().toLowerCase() === lower);
  const entry = idx > -1 ? table[idx] : null;
  const pts = mine.map(r => Number(r.points) || 0);
  const best = pts.length ? Math.max(...pts) : null;
  const avg = pts.length ? pts.reduce((a, v) => a + v, 0) / pts.length : null;

  // Prizes, matched by name (a pair is stored as "A & B").
  const won = [];
  prizes.forEach(p => {
    const ev = data.events.find(e => e.id === p.event_id);
    if (!ev) return;
    const check = (val, label) => {
      if (!val) return;
      if (String(val).split(/\s*&\s*/).some(n => n.trim().toLowerCase() === lower)) won.push({ ev, label });
    };
    check(p.first_place, "1st place"); check(p.second_place, "2nd place"); check(p.third_place, "3rd place");
    check(p.winning_pair, "Winning pair");
    (window.ROUND_COMPETITIONS || []).forEach(c => check(p[c.winner], c.title));
  });
  won.sort((a, b) => a.ev.event_date.localeCompare(b.ev.event_date));
  const seasonWon = won.filter(w => seasonIds.has(w.ev.id));

  document.getElementById("pl-eyebrow").textContent = season + " season";
  document.getElementById("pl-sub").textContent = player.handicap != null ? "Handicap " + player.handicap : "";
  if (player.profile_id) {
    const m = document.getElementById("pl-member");
    m.href = "members.html#m-" + player.profile_id;
    m.hidden = false;
  }

  // ---- stat tiles
  const ord = n => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
  const tiles = [
    [entry ? ord(idx + 1) : "–", "Order of Merit" + (table.length ? " of " + table.length : "")],
    [entry ? entry.totalPoints : 0, "points", true],
    [mine.length + " / " + seasonRoundsList.filter(e => data.results.some(r => r.event_id === e.id)).length, "rounds played"],
    [avg != null ? avg.toFixed(1) : "–", "average points"],
    [best != null ? best : "–", "best round", true],
    [seasonWon.length, "prizes this season", true]
  ];
  const statsEl = document.getElementById("pl-stats");
  statsEl.innerHTML = tiles.map(([v, l, count]) =>
    `<div class="pl-stat"><b${count && typeof v === "number" ? ` data-count="${v}"` : ""}>${escapeHtml(String(v))}</b><span>${escapeHtml(l)}</span></div>`).join("");

  // ---- points by round chart
  const per = seasonRoundsList.map(ev => {
    const r = mine.find(x => x.event_id === ev.id);
    return { ev, pts: r ? Number(r.points) || 0 : null, played: data.results.some(x => x.event_id === ev.id) };
  });
  const top = Math.max(1, ...per.map(x => x.pts || 0));
  const chartEl = document.getElementById("pl-chart");
  document.getElementById("pl-chart-meta").textContent = avg != null ? "avg " + avg.toFixed(1) + " pts" : "";
  const avgPct = avg != null ? (avg / top * 100).toFixed(1) : null;
  chartEl.innerHTML = `<div class="pl-chart">` +
    per.map((x, i) => {
      const label = escapeHtml(x.ev.name.replace("Round ", "R"));
      const title = escapeHtml(x.ev.name + (x.ev.venue ? " · " + x.ev.venue : "") + ": " + (x.pts != null ? x.pts + " pts" : x.played ? "didn't play" : "not played yet"));
      const h = x.pts != null ? Math.max(3, x.pts / top * 100) : 10;
      const cls = "pl-col" + (x.pts == null ? " pl-none" : "") + (x.pts != null && x.pts === best ? " pl-best" : "");
      const inner = `<em>${x.pts != null ? x.pts : "&nbsp;"}</em><span class="pl-track">${avgPct ? `<b class="pl-avgline" style="bottom:${avgPct}%"></b>` : ""}<i style="height:${h}%"></i></span><span>${label}</span>`;
      return x.played
        ? `<a class="${cls}" style="--i:${i}" href="results.html#event-${x.ev.id}" title="${title}">${inner}</a>`
        : `<div class="${cls}" style="--i:${i}" title="${title}">${inner}</div>`;
    }).join("") + `</div>`;

  // ---- prizes
  document.getElementById("pl-prize-meta").textContent = won.length ? won.length + " in all" : "";
  document.getElementById("pl-prizes").innerHTML = won.length
    ? `<ul class="pl-prizes">${won.map(w => `<li><span>${escapeHtml(w.label)}</span><a class="player-link" href="results.html#event-${w.ev.id}">${escapeHtml(w.ev.name)}${w.ev.venue ? " · " + escapeHtml(w.ev.venue) : ""}</a></li>`).join("")}</ul>`
    : `<div class="empty-state">No prizes yet. There's always next round.</div>`;

  // ---- round by round
  const rows = mine.slice().sort((a, b) => (a.events?.event_date || "").localeCompare(b.events?.event_date || ""));
  document.getElementById("pl-rounds").innerHTML = rows.length ? `
    <table class="score-table">
      <thead><tr><th>Round</th><th>Course</th><th class="num">Finished</th><th class="num">Points</th></tr></thead>
      <tbody>${rows.map(r => {
        const ev = data.events.find(e => e.id === r.event_id) || {};
        const field = seasonResults.filter(x => x.event_id === r.event_id).map(x => Number(x.points) || 0).sort((a, b) => b - a);
        const place = field.indexOf(Number(r.points) || 0) + 1;
        const tied = field.filter(v => v === (Number(r.points) || 0)).length > 1;
        return `<tr>
          <td><a class="player-link" href="results.html#event-${r.event_id}">${escapeHtml(ev.name || "Round")}</a></td>
          <td>${escapeHtml(ev.venue || "")}</td>
          <td class="num">${tied ? "T" : ""}${place} of ${field.length}</td>
          <td class="num">${r.points}</td></tr>`;
      }).join("")}</tbody>
    </table>` : `<div class="empty-state">No rounds logged this season yet.</div>`;

  // ---- motion: count the tiles up and grow the bars when they're on screen
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduced) {
    statsEl.querySelectorAll("[data-count]").forEach(el => {
      const n = Number(el.getAttribute("data-count"));
      const start = performance.now();
      const step = t => { const p = Math.min(1, (t - start) / 900); el.textContent = Math.round(n * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); };
      el.textContent = "0";
      requestAnimationFrame(step);
    });
    const chart = chartEl.querySelector(".pl-chart");
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { chart.classList.add("mo-animate"); io.disconnect(); } }), { threshold: 0.2 });
      io.observe(chart);
    }
  }
});
