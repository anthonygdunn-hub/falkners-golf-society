// ------------------------------------------------------------------
// Shared helpers for the public-facing pages (leaderboard, results,
// fixtures, homepage). Reads from Supabase; never writes.
// ------------------------------------------------------------------

function getClient() {
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

function formatDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function shortDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return {
    day: d.toLocaleDateString("en-GB", { day: "numeric" }),
    month: d.toLocaleDateString("en-GB", { month: "short" }).toUpperCase()
  };
}

// Fetch every event + every result (with player name/handicap attached).
// We aggregate in JS rather than in SQL — simpler to reason about,
// and this society's data will always be small (a few dozen players,
// a handful of rounds a year).
async function fetchAllData() {
  const client = getClient();

  const [eventsRes, resultsRes, playersRes] = await Promise.all([
    client.from("events").select("*").order("event_date", { ascending: true }),
    client.from("results").select("*, players(name, handicap), events(name, event_date)"),
    client.from("players").select("*").eq("active", true).order("name", { ascending: true })
  ]);

  if (eventsRes.error) throw eventsRes.error;
  if (resultsRes.error) throw resultsRes.error;
  if (playersRes.error) throw playersRes.error;

  return {
    events: eventsRes.data || [],
    results: resultsRes.data || [],
    players: playersRes.data || []
  };
}

function buildLeaderboard(results) {
  const byPlayer = new Map();

  for (const r of results) {
    const name = r.players?.name || "Unknown";
    if (!byPlayer.has(name)) {
      byPlayer.set(name, { name, handicap: r.players?.handicap, totalPoints: 0, rounds: 0 });
    }
    const entry = byPlayer.get(name);
    entry.totalPoints += Number(r.points) || 0;
    entry.rounds += 1;
    // Keep the most recently-seen handicap
    if (r.players?.handicap != null) entry.handicap = r.players.handicap;
  }

  return Array.from(byPlayer.values()).sort((a, b) => b.totalPoints - a.totalPoints);
}

function renderLeaderboardTable(container, leaderboard) {
  if (!leaderboard.length) {
    container.innerHTML = `<div class="empty-state">No rounds logged yet this season. Check back after the first fixture!</div>`;
    return;
  }

  const rows = leaderboard.map((p, i) => `
    <tr class="${i === 0 ? 'pos-1' : ''}">
      <td class="pos"><span class="pos-badge">${i + 1}</span></td>
      <td>${escapeHtml(p.name)}</td>
      <td class="num">${p.handicap ?? '—'}</td>
      <td class="num">${p.rounds}</td>
      <td class="num">${p.totalPoints}</td>
    </tr>
  `).join("");

  container.innerHTML = `
    <table class="score-table">
      <thead>
        <tr>
          <th>Pos</th><th>Name</th><th class="num">HCap</th><th class="num">Rounds</th><th class="num">Points</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderEventResultsCard(event, resultsForEvent) {
  const sorted = [...resultsForEvent].sort((a, b) => Number(b.points) - Number(a.points));
  const bodyHtml = sorted.length
    ? `<table class="score-table">
        <thead><tr><th>Pos</th><th>Name</th><th class="num">HCap</th><th class="num">Gross</th><th class="num">Points</th></tr></thead>
        <tbody>
          ${sorted.map((r, i) => `
            <tr class="${i === 0 ? 'pos-1' : ''}">
              <td class="pos"><span class="pos-badge">${i + 1}</span></td>
              <td>${escapeHtml(r.players?.name || 'Unknown')}</td>
              <td class="num">${r.handicap ?? '—'}</td>
              <td class="num">${r.gross_score ?? '—'}</td>
              <td class="num">${r.points}</td>
            </tr>`).join("")}
        </tbody>
      </table>`
    : `<div class="empty-state">Results coming soon.</div>`;

  return `
    <div class="scorecard" style="margin-bottom:24px;">
      <div class="scorecard-head">
        <h3>${escapeHtml(event.name)}</h3>
        <span class="meta">${formatDate(event.event_date)} · ${escapeHtml(event.venue || 'Venue TBC')}</span>
      </div>
      ${bodyHtml}
    </div>
  `;
}

  const { day, month } = shortDate(event.event_date);
  const isPast = event.event_date < new Date().toISOString().slice(0, 10);
  const link = isPast ? `results.html#event-${event.id}` : `fixture.html?id=${event.id}`;
  return `
      <li class="fixture-item">
            <div class="fixture-date"><strong>${day}</strong>${month}</div>
                  <div class="fixture-body">
                          <h3><a href="${link}">${escapeHtml(event.name)}${event.venue ? ' — ' + escapeHtml(event.venue) : ''}</a></h3>
                                  <div class="venue">${escapeHtml(event.address || 'Venue to be confirmed')}</div>
      </div>
    </li>
  `;
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
