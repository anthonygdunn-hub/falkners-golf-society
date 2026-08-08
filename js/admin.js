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
    await refreshPendingMembers();
}

async function refreshPendingMembers() {
    const container = document.getElementById("pending-members-list");
    if (!container) return;
  
    const { data: pending, error } = await client
          .from("memberships")
          .select("*, profiles(display_name), events:intended_event_id(name, event_date)")
          .eq("status", "pending")
          .order("requested_at", { ascending: true });
  
    if (error) {
          container.innerHTML = `<p class="small">Couldn't load requests: ${error.message}</p>`;
          return;
    }
  
    if (!pending.length) {
          container.innerHTML = `<p class="small">No pending requests right now.</p>`;
          return;
    }
  
    container.innerHTML = pending.map(m => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--line);">
              <span>${escapeHtml(m.profiles?.display_name || 'Unknown')}${m.events ? `<br><span class="small">Wants to play in ${escapeHtml(m.events.name)} (${m.events.event_date})</span>` : ''}</span>
                    <span>
                            <button class="btn btn-brass" style="padding:6px 12px; font-size:0.75rem;" data-approve="${m.profile_id}" data-event="${m.intended_event_id || ''}">Approve</button>
                                    <button class="btn btn-outline" style="padding:6px 12px; font-size:0.75rem;" data-reject="${m.profile_id}">Reject</button>
                                          </span>
                                              </div>
                                                `).join("");
  
    container.querySelectorAll("[data-approve]").forEach(btn => {
          btn.addEventListener("click", () => decideMembership(btn.dataset.approve, "approved", btn.dataset.event || null));
});
  container.querySelectorAll("[data-reject]").forEach(btn => {
        btn.addEventListener("click", () => decideMembership(btn.dataset.reject, "rejected"));
});
}

async function decideMembership(profileId, status, intendedEventId) {
    const { data: { user } } = await client.auth.getUser();
    await client.from("memberships").update({
          status,
          decided_at: new Date().toISOString(),
          decided_by: user?.id || null
    }).eq("profile_id", profileId);

    // Approving someone who signed up specifically to play in a fixture
    // also registers them for it — no separate step for the new member.
    if (status === "approved" && intendedEventId) {
          await client.from("attendance").insert({ event_id: intendedEventId, profile_id: profileId });
    }

    await refreshPendingMembers();
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
  populateEditEventSelect();
  renderPlayerManageList();
}

// ---- Editing an existing fixture -------------------------------------

function populateEditEventSelect() {
  const select = document.getElementById("edit-event-select");
  if (!select) return;

  const previous = select.value;
  select.innerHTML = currentEvents.map(e =>
    `<option value="${e.id}">${escapeHtml(e.name)} — ${e.event_date}</option>`
  ).join("");

  // Keep the committee on the fixture they were already editing after a save.
  if (previous && currentEvents.some(e => e.id === previous)) select.value = previous;

  if (currentEvents.length) loadEventIntoEditForm(select.value);
  select.onchange = () => loadEventIntoEditForm(select.value);
}

function loadEventIntoEditForm(eventId) {
  const event = currentEvents.find(e => e.id === eventId);
  if (!event) return;
  const set = (id, val) => { document.getElementById(id).value = val ?? ""; };
  set("edit-event-name", event.name);
  set("edit-event-date", event.event_date);
  set("edit-event-venue", event.venue);
  set("edit-event-meet-time", (event.meet_time || "").slice(0, 5));
  set("edit-event-tee-time", (event.tee_time || "").slice(0, 5));
  set("edit-event-cost", event.cost);
  set("edit-event-address", event.address);
  set("edit-event-website", event.website);
  set("edit-event-format", event.format);
  set("edit-event-notes", event.notes);
  document.getElementById("edit-event-status").textContent = "";
}

async function saveEventEdits(e) {
  e.preventDefault();
  const eventId = document.getElementById("edit-event-select").value;
  const statusEl = document.getElementById("edit-event-status");
  if (!eventId) return;

  const val = id => document.getElementById(id).value.trim();
  const costRaw = val("edit-event-cost");

  const patch = {
    name: val("edit-event-name"),
    event_date: val("edit-event-date"),
    venue: val("edit-event-venue") || null,
    meet_time: val("edit-event-meet-time") || null,
    tee_time: val("edit-event-tee-time") || null,
    address: val("edit-event-address") || null,
    website: val("edit-event-website") || null,
    format: val("edit-event-format") || null,
    notes: val("edit-event-notes") || null,
    cost: costRaw === "" ? null : Number(costRaw)
  };

  if (!patch.name || !patch.event_date) {
    statusEl.textContent = "A round name and date are both required.";
    statusEl.className = "status-msg err";
    return;
  }

  statusEl.textContent = "Saving…";
  statusEl.className = "status-msg";

  const { error } = await client.from("events").update(patch).eq("id", eventId);

  if (error) {
    statusEl.textContent = error.message;
    statusEl.className = "status-msg err";
    return;
  }

  // Refresh first: reloading the form clears the status line, so the
  // confirmation has to be written after that, or it vanishes instantly.
  await refreshData();
  statusEl.textContent = "Saved. This is live on the Fixtures page now.";
  statusEl.className = "status-msg ok";
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
  document.getElementById("edit-event-form").addEventListener("submit", saveEventEdits);
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
  const website = document.getElementById("new-event-website").value.trim();
  const meetTime = document.getElementById("new-event-meet-time").value;
  const teeTime = document.getElementById("new-event-tee-time").value;
  const notes = document.getElementById("new-event-notes").value.trim();
  const costRaw = document.getElementById("new-event-cost").value.trim();
  const event_date = document.getElementById("new-event-date").value;
  const statusEl = document.getElementById("event-status");
  if (!name || !event_date) return;

  const { error } = await client.from("events").insert({
    name,
    event_date,
    venue: venue || null,
    address: address || null,
    meet_time: meetTime || null,
    tee_time: teeTime || null,
    website: website || null,
    notes: notes || null,
    cost: costRaw === "" ? null : Number(costRaw)
  });
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
