// ------------------------------------------------------------------
// Committee admin page logic: login, and logging results / fixtures /
// players. Anything that writes to the database requires being
// signed in — enforced both here (UI) and in the database itself
// (Row Level Security, see sql/schema.sql), so this page is safe
// even though the URL isn't secret.
// ------------------------------------------------------------------

let client;
let currentPlayers = [];
let currentEvents = [];

document.addEventListener("DOMContentLoaded", () => {
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  wireLogin();
  wireLogout();
  wireForms();
  checkSession();
});

async function checkSession() {
  const { data: { session } } = await client.auth.getSession();
  if (session) showDashboard();
  else showLogin();
}

function showLogin() {
  document.getElementById("login-panel").style.display = "block";
  document.getElementById("dashboard").style.display = "none";
}

async function showDashboard() {
  document.getElementById("login-panel").style.display = "none";
  document.getElementById("dashboard").style.display = "block";
  await refreshData();
}

function wireLogin() {
  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const statusEl = document.getElementById("login-status");
    statusEl.textContent = "Signing in…";
    statusEl.className = "status-msg";

    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      statusEl.textContent = error.message;
      statusEl.className = "status-msg err";
    } else {
      await showDashboard();
    }
  });
}

function wireLogout() {
  document.getElementById("logout-btn").addEventListener("click", async () => {
    await client.auth.signOut();
    showLogin();
  });
}

async function refreshData() {
  const [{ data: players }, { data: events }] = await Promise.all([
    client.from("players").select("*").order("name", { ascending: true }),
    client.from("events").select("*").order("event_date", { ascending: false })
  ]);
  currentPlayers = players || [];
  currentEvents = events || [];

  populateEventSelect();
  renderPlayerManageList();
}

function populateEventSelect() {
  const select = document.getElementById("event-select");
  select.innerHTML = currentEvents.map(e =>
    `<option value="${e.id}">${escapeHtml(e.name)} — ${e.event_date} — ${escapeHtml(e.venue || 'Venue TBC')}</option>`
  ).join("");
  if (currentEvents.length) loadResultsFormFor(currentEvents[0].id);
  select.onchange = () => loadResultsFormFor(select.value);
}

async function loadResultsFormFor(eventId) {
  const { data: existing } = await client.from("results").select("*").eq("event_id", eventId);
  const existingByPlayer = new Map((existing || []).map(r => [r.player_id, r]));

  const container = document.getElementById("results-entry-rows");
  const activePlayers = currentPlayers.filter(p => p.active);

  container.innerHTML = activePlayers.map(p => {
    const ex = existingByPlayer.get(p.id);
    return `
      <div class="entry-row" data-player-id="${p.id}">
        <div class="player-name">${escapeHtml(p.name)}</div>
        <input type="number" step="0.1" placeholder="HCap" class="hcap-input" value="${ex?.handicap ?? p.handicap ?? ''}">
        <input type="number" step="1" placeholder="Gross" class="gross-input" value="${ex?.gross_score ?? ''}">
        <input type="number" step="0.1" placeholder="Points" class="points-input" value="${ex?.points ?? ''}">
      </div>
    `;
  }).join("");
}

function wireForms() {
  document.getElementById("save-results-btn").addEventListener("click", saveResults);
  document.getElementById("add-player-form").addEventListener("submit", addPlayer);
  document.getElementById("add-event-form").addEventListener("submit", addEvent);
}

async function saveResults() {
  const eventId = document.getElementById("event-select").value;
  const statusEl = document.getElementById("results-status");
  if (!eventId) return;

  const rows = document.querySelectorAll("#results-entry-rows .entry-row");
  const upserts = [];

  rows.forEach(row => {
    const points = row.querySelector(".points-input").value;
    if (points === "") return; // skip players with no points entered — no result for this round
    upserts.push({
      event_id: eventId,
      player_id: row.dataset.playerId,
      handicap: row.querySelector(".hcap-input").value || null,
      gross_score: row.querySelector(".gross-input").value || null,
      points: Number(points)
    });
  });

  if (!upserts.length) {
    statusEl.textContent = "Enter at least one player's points before saving.";
    statusEl.className = "status-msg err";
    return;
  }

  statusEl.textContent = "Saving…";
  statusEl.className = "status-msg";

  const { error } = await client.from("results").upsert(upserts, { onConflict: "event_id,player_id" });

  if (error) {
    statusEl.textContent = "Something went wrong: " + error.message;
    statusEl.className = "status-msg err";
    return;
  }

  await client.from("events").update({ results_entered: true }).eq("id", eventId);

  statusEl.textContent = `Saved ${upserts.length} result(s). Leaderboard and results page are now up to date.`;
  statusEl.className = "status-msg ok";
}

async function addPlayer(e) {
  e.preventDefault();
  const name = document.getElementById("new-player-name").value.trim();
  const handicap = document.getElementById("new-player-handicap").value || null;
  const statusEl = document.getElementById("player-status");
  if (!name) return;

  const { error } = await client.from("players").insert({ name, handicap });
  statusEl.textContent = error ? error.message : `Added ${name}.`;
  statusEl.className = error ? "status-msg err" : "status-msg ok";
  if (!error) {
    document.getElementById("add-player-form").reset();
    await refreshData();
  }
}

async function addEvent(e) {
  e.preventDefault();
  const name = document.getElementById("new-event-name").value.trim();
  const venue = document.getElementById("new-event-venue").value.trim();
  const address = document.getElementById("new-event-address").value.trim();
  const event_date = document.getElementById("new-event-date").value;
  const statusEl = document.getElementById("event-status");
  if (!name || !event_date) return;

  const { error } = await client.from("events").insert({ name, venue, address, event_date });
  statusEl.textContent = error ? error.message : `Added ${name}.`;
  statusEl.className = error ? "status-msg err" : "status-msg ok";
  if (!error) {
    document.getElementById("add-event-form").reset();
    await refreshData();
  }
}

function renderPlayerManageList() {
  const el = document.getElementById("player-manage-list");
  el.innerHTML = currentPlayers.map(p => `
    <div class="small" style="padding:6px 0; display:flex; justify-content:space-between; border-bottom:1px solid var(--line);">
      <span>${escapeHtml(p.name)} ${p.handicap != null ? `(hcap ${p.handicap})` : ''}</span>
      <span>${p.active ? '' : '<em>inactive</em>'}</span>
    </div>
  `).join("");
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
