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
    <div class="scorecard" id="event-${event.id}" style="margin-bottom:24px;">
      <div class="scorecard-head">
        <h3>${escapeHtml(event.name)}</h3>
        <span class="meta">${formatDate(event.event_date)} · ${escapeHtml(event.venue || 'Venue TBC')}</span>
      </div>
      ${bodyHtml}
    </div>
  `;
}

// Has this round already been played?
function isPastEvent(event) {
  return event.event_date < new Date().toISOString().slice(0, 10);
}

// Renders one row in the fixtures list as a collapsed accordion item.
// Clicking the header expands a panel in place — no page navigation — with
// the full details, who's playing, and the option to register.
//
// Pass { compact: true } on pages that don't load js/fixtures.js (the
// homepage): there's no accordion behaviour there, so the item renders as a
// plain link through to this fixture on the fixtures page, which opens it.
function renderFixtureItem(event, opts = {}) {
  const { day, month } = shortDate(event.event_date);
  const title = `${escapeHtml(event.name)}${event.venue ? ' — ' + escapeHtml(event.venue) : ''}`;
  const venueLine = escapeHtml(event.address || 'Venue to be confirmed');

  if (opts.compact) {
    return `
      <li class="fixture-item fixture-item-static">
        <a class="fixture-head" href="fixtures.html#event-${event.id}">
          <span class="fixture-date"><strong>${day}</strong>${month}</span>
          <span class="fixture-body">
            <span class="fixture-title">${title}</span>
            <span class="venue">${venueLine}</span>
          </span>
          <span class="fixture-chevron" aria-hidden="true">&rsaquo;</span>
        </a>
      </li>
    `;
  }

  const past = isPastEvent(event);
  return `
    <li class="fixture-item" id="event-${event.id}" data-event-id="${event.id}" data-past="${past}">
      <button class="fixture-head" type="button" aria-expanded="false" aria-controls="panel-${event.id}">
        <span class="fixture-date"><strong>${day}</strong>${month}</span>
        <span class="fixture-body">
          <span class="fixture-title">${title}</span>
          <span class="venue">${venueLine}</span>
        </span>
        <span class="fixture-chevron" aria-hidden="true">&#9662;</span>
      </button>
      <div class="fixture-panel" id="panel-${event.id}" hidden>
        ${renderFixtureFacts(event)}
        <div class="fixture-section-label">${past ? 'Who played' : "Who's playing"}</div>
        <div class="attendee-slot" data-attendees-for="${event.id}"><p class="small">Loading…</p></div>
        <div class="register-slot" data-register-for="${event.id}"></div>
      </div>
    </li>
  `;
}
// The detail block inside an expanded fixture. Only shows rows the
// committee has actually filled in, so a sparse fixture stays tidy.
function renderFixtureFacts(event) {
  const rows = [];

  rows.push(["Date", formatDate(event.event_date)]);
  if (event.venue) rows.push(["Venue", escapeHtml(event.venue)]);
  if (event.address) {
    rows.push(["Address", `${escapeHtml(event.address)} · <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((event.venue ? event.venue + ", " : "") + event.address)}" target="_blank" rel="noopener">Open in Maps</a>`]);
  }
  if (event.cost != null && event.cost !== "") {
    rows.push(["Cost", `<span class="fixture-cost">${formatCost(event.cost)}</span> per player`]);
  }
  if (event.website) {
    rows.push(["Website", `<a href="${escapeHtml(normaliseUrl(event.website))}" target="_blank" rel="noopener">${escapeHtml(stripUrl(event.website))}</a>`]);
  }
  if (event.format) rows.push(["Format", escapeHtml(event.format)]);

  const facts = `<dl class="fixture-facts">${rows
    .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
    .join("")}</dl>`;

  const notes = event.notes
    ? `<div class="fixture-notes">${escapeHtml(event.notes)}</div>`
    : "";

  return facts + notes;
}

function formatCost(cost) {
  const n = Number(cost);
  if (!isFinite(n)) return escapeHtml(cost);
  // Whole pounds look cleaner without trailing zeroes (£45, not £45.00)
  return "£" + (Number.isInteger(n) ? n.toString() : n.toFixed(2));
}

// Committee members will paste "clandongolfclub.co.uk" as often as a full
// URL, so make sure the link still works either way.
function normaliseUrl(url) {
  const trimmed = String(url).trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : "https://" + trimmed;
}

function stripUrl(url) {
  return String(url).trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
