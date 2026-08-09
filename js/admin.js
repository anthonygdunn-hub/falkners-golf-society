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
          .select("*")
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

    // Fetched separately rather than embedded: memberships has two foreign
    // keys to profiles (profile_id and decided_by), so an embed is ambiguous
    // and PostgREST refuses it.
    const profileIds = pending.map(m => m.profile_id).filter(Boolean);
    const eventIds = pending.map(m => m.intended_event_id).filter(Boolean);

    const [{ data: profs }, { data: evs }] = await Promise.all([
          profileIds.length
            ? client.from("profiles").select("id, display_name").in("id", profileIds)
            : Promise.resolve({ data: [] }),
          eventIds.length
            ? client.from("events").select("id, name, event_date").in("id", eventIds)
            : Promise.resolve({ data: [] })
    ]);

    const profById = new Map((profs || []).map(p => [p.id, p]));
    const evById = new Map((evs || []).map(e => [e.id, e]));
    pending.forEach(m => {
          m.profiles = profById.get(m.profile_id) || null;
          m.events = evById.get(m.intended_event_id) || null;
    });
  
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
  populatePlayingEventSelect();
  populatePrizeEventSelect();
  populatePaymentEventSelect();
  populatePotEventSelect();
  refreshPot();
  loadBankDetails();
  renderPlayerManageList();
}

// Every "pick a fixture" dropdown on this page is the same list, so
// they're filled from one place rather than four near-identical copies.
function fillEventSelect(id, { includeBlank = false } = {}) {
  const select = document.getElementById(id);
  if (!select) return null;
  const previous = select.value;
  select.innerHTML =
    (includeBlank ? `<option value="">Not tied to a round</option>` : "") +
    currentEvents.map(e =>
      `<option value="${e.id}">${escapeHtml(e.name)} — ${e.event_date}</option>`
    ).join("");
  if (previous && [...select.options].some(o => o.value === previous)) select.value = previous;
  return select;
}

// ---- Round prizes ----------------------------------------------------

const PRIZE_FIELDS = {
  "prize-first": "first_place",
  "prize-second": "second_place",
  "prize-third": "third_place",
  "prize-pair": "winning_pair",
  "prize-ld-front": "longest_drive_front",
  "prize-ld-back": "longest_drive_back",
  "prize-np-front": "nearest_pin_front",
  "prize-np-back": "nearest_pin_back"
};

function populatePrizeEventSelect() {
  const select = fillEventSelect("prize-event-select");
  if (!select) return;
  select.onchange = () => loadPrizes(select.value);
  if (currentEvents.length) loadPrizes(select.value);
}

async function loadPrizes(eventId) {
  const statusEl = document.getElementById("prize-status");
  Object.keys(PRIZE_FIELDS).forEach(id => { document.getElementById(id).value = ""; });
  if (statusEl) statusEl.textContent = "";
  if (!eventId) return;

  const { data } = await client
    .from("event_prizes").select("*").eq("event_id", eventId).maybeSingle();
  if (!data) return;

  Object.entries(PRIZE_FIELDS).forEach(([id, col]) => {
    document.getElementById(id).value = data[col] ?? "";
  });
}

async function savePrizes(e) {
  e.preventDefault();
  const eventId = document.getElementById("prize-event-select").value;
  const statusEl = document.getElementById("prize-status");
  if (!eventId) return;

  const row = { event_id: eventId, updated_at: new Date().toISOString() };
  Object.entries(PRIZE_FIELDS).forEach(([id, col]) => {
    const value = document.getElementById(id).value.trim();
    row[col] = value === "" ? null : value;
  });

  statusEl.textContent = "Saving…";
  statusEl.className = "small";

  const { error } = await client.from("event_prizes").upsert(row, { onConflict: "event_id" });

  statusEl.textContent = error ? error.message : "Prizes saved — they're on the results page now.";
  statusEl.className = error ? "status-msg err" : "status-msg ok";
}

// ---- The hole-in-one pot ---------------------------------------------

function populatePotEventSelect() {
  fillEventSelect("pot-event", { includeBlank: true });
}

async function refreshPot() {
  const totalEl = document.getElementById("admin-pot-total");
  const listEl = document.getElementById("pot-entries");
  if (!totalEl) return;

  const { data: rows, error } = await client
    .from("hole_in_one_ledger")
    .select("id, amount, note, entry_date, event_id")
    .order("entry_date", { ascending: false });

  if (error) {
    listEl.innerHTML = `<p class="status-msg err">Couldn't load the pot: ${escapeHtml(error.message)}</p>`;
    return;
  }

  const total = (rows || []).reduce((sum, r) => sum + Number(r.amount || 0), 0);
  totalEl.textContent = money(total);

  const nameById = new Map(currentEvents.map(e => [e.id, e.name]));

  listEl.innerHTML = rows.length
    ? rows.map(r => {
        const out = Number(r.amount) < 0;
        const round = r.event_id ? ` · ${escapeHtml(nameById.get(r.event_id) || "Round")}` : "";
        return `
          <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid var(--line);">
            <span class="small"><strong class="${out ? "pot-payout" : ""}">${out ? "−" : "+"}${money(Math.abs(Number(r.amount)))}</strong>
              · ${escapeHtml(r.entry_date)}${round}${r.note ? " · " + escapeHtml(r.note) : ""}</span>
            <button class="btn btn-outline btn-small" type="button" data-remove-pot="${r.id}">Remove</button>
          </div>`;
      }).join("")
    : `<p class="small">No entries yet.</p>`;

  listEl.querySelectorAll("[data-remove-pot]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await client.from("hole_in_one_ledger").delete().eq("id", btn.dataset.removePot);
      refreshPot();
    });
  });
}

async function addPotEntry(e) {
  e.preventDefault();
  const statusEl = document.getElementById("pot-status");
  const amountRaw = document.getElementById("pot-amount").value;
  const isPayout = document.getElementById("pot-is-payout").checked;
  const eventId = document.getElementById("pot-event").value || null;
  const note = document.getElementById("pot-note").value.trim();

  const amount = Math.abs(Number(amountRaw));
  if (!amount) {
    statusEl.textContent = "Enter an amount first.";
    statusEl.className = "status-msg err";
    return;
  }

  // A payout leaves the pot, so it goes in as a negative entry — the
  // running total then takes care of itself.
  const { error } = await client.from("hole_in_one_ledger").insert({
    event_id: eventId,
    amount: isPayout ? -amount : amount,
    note: note || null
  });

  if (error) {
    statusEl.textContent = error.message;
    statusEl.className = "status-msg err";
    return;
  }

  document.getElementById("pot-form").reset();
  await refreshPot();
  statusEl.textContent = isPayout ? "Payout recorded." : "Added to the pot.";
  statusEl.className = "status-msg ok";
}

// ---- Payments --------------------------------------------------------

async function loadBankDetails() {
  const nameEl = document.getElementById("bank-name");
  if (!nameEl) return;

  const { data } = await client.from("society_settings").select("*").maybeSingle();
  if (!data) return;

  nameEl.value = data.account_name ?? "";
  document.getElementById("bank-sort").value = data.sort_code ?? "";
  document.getElementById("bank-number").value = data.account_number ?? "";
  document.getElementById("bank-note").value = data.payment_note ?? "";
}

async function saveBankDetails(e) {
  e.preventDefault();
  const statusEl = document.getElementById("bank-status");
  statusEl.textContent = "Saving…";
  statusEl.className = "small";

  const { error } = await client.from("society_settings").update({
    account_name: document.getElementById("bank-name").value.trim() || null,
    sort_code: document.getElementById("bank-sort").value.trim() || null,
    account_number: document.getElementById("bank-number").value.trim() || null,
    payment_note: document.getElementById("bank-note").value.trim() || null,
    updated_at: new Date().toISOString()
  }).eq("id", true);

  statusEl.textContent = error ? error.message : "Bank details saved. Members will see these when they register.";
  statusEl.className = error ? "status-msg err" : "status-msg ok";
}

function populatePaymentEventSelect() {
  const select = fillEventSelect("pay-event-select");
  if (!select) return;
  select.onchange = () => refreshPaymentList(select.value);
  if (currentEvents.length) refreshPaymentList(select.value);
}

async function refreshPaymentList(eventId) {
  const el = document.getElementById("payment-list");
  if (!el || !eventId) return;

  const event = currentEvents.find(e => e.id === eventId);
  const cost = event?.cost;

  const { data: rows, error } = await client
    .from("attendance")
    .select("id, profile_id, player_id, payment_status, payment_reference")
    .eq("event_id", eventId)
    .order("created_at", { ascending: true });

  if (error) {
    el.innerHTML = `<p class="status-msg err">Couldn't load payments: ${escapeHtml(error.message)}</p>`;
    return;
  }

  if (!rows.length) {
    el.innerHTML = `<p class="small">Nobody's on this round yet.</p>`;
    return;
  }

  const profileIds = rows.map(r => r.profile_id).filter(Boolean);
  let profById = new Map();
  if (profileIds.length) {
    const { data: profs } = await client
      .from("profiles").select("id, display_name").in("id", profileIds);
    profById = new Map((profs || []).map(p => [p.id, p.display_name]));
  }
  const playerById = new Map(currentPlayers.map(p => [p.id, p.name]));

  const paid = rows.filter(r => r.payment_status === "confirmed").length;
  const owed = cost ? (rows.length - paid) * Number(cost) : null;

  el.innerHTML = `
    <p class="small">${paid} of ${rows.length} confirmed${owed ? ` · ${money(owed)} still to come in` : ""}.</p>
    ${rows.map(r => {
      const name = r.player_id
        ? (playerById.get(r.player_id) || "Player")
        : (profById.get(r.profile_id) || "Member");
      const status = r.payment_status || "unpaid";
      const label = status === "confirmed" ? "Confirmed" : status === "claimed" ? "Says they've paid" : "Unpaid";
      const cls = status === "confirmed" ? "is-confirmed" : status === "claimed" ? "is-claimed" : "";
      return `
        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 0; border-bottom:1px solid var(--line); flex-wrap:wrap;">
          <span>${escapeHtml(name)}
            <span class="pay-status ${cls}">${label}</span>
            ${r.payment_reference ? `<span class="small pay-ref">${escapeHtml(r.payment_reference)}</span>` : ""}
          </span>
          <span>
            ${status === "confirmed"
              ? `<button class="btn btn-outline btn-small" type="button" data-pay-set="unpaid" data-pay-id="${r.id}">Undo</button>`
              : `<button class="btn btn-brass btn-small" type="button" data-pay-set="confirmed" data-pay-id="${r.id}">Confirm payment</button>`}
          </span>
        </div>`;
    }).join("")}`;

  el.querySelectorAll("[data-pay-id]").forEach(btn => {
    btn.addEventListener("click", () => setPaymentStatus(btn.dataset.payId, btn.dataset.paySet, eventId));
  });
}

async function setPaymentStatus(attendanceId, status, eventId) {
  const patch = { payment_status: status };
  if (status === "confirmed") {
    patch.payment_confirmed_at = new Date().toISOString();
  } else {
    patch.payment_confirmed_at = null;
  }
  await client.from("attendance").update(patch).eq("id", attendanceId);
  await refreshPaymentList(eventId);
}

function money(n) {
  const value = Number(n) || 0;
  return "£" + value.toFixed(2).replace(/\.00$/, "");
}

// ---- Who's playing ---------------------------------------------------
// Members register themselves from the fixtures page, but plenty of
// people play without ever making an account. The committee can add
// those by name here; the name goes into the players table, which is
// what results and the leaderboard already run on.

function populatePlayingEventSelect() {
  const select = document.getElementById("playing-event-select");
  if (!select) return;

  const previous = select.value;
  select.innerHTML = currentEvents.map(e =>
    `<option value="${e.id}">${escapeHtml(e.name)} — ${e.event_date}</option>`
  ).join("");
  if (previous && currentEvents.some(e => e.id === previous)) select.value = previous;

  const datalist = document.getElementById("known-players");
  if (datalist) {
    datalist.innerHTML = currentPlayers
      .map(p => `<option value="${escapeHtml(p.name)}"></option>`)
      .join("");
  }

  select.onchange = () => refreshPlayingList(select.value);
  if (currentEvents.length) refreshPlayingList(select.value);
}

async function refreshPlayingList(eventId) {
  const el = document.getElementById("playing-list");
  if (!el || !eventId) return;

  const { data: rows, error } = await client
    .from("attendance")
    .select("id, profile_id, player_id, created_at")
    .eq("event_id", eventId)
    .order("created_at", { ascending: true });

  if (error) {
    el.innerHTML = `<p class="status-msg err">Couldn't load the playing list: ${escapeHtml(error.message)}</p>`;
    return;
  }

  if (!rows.length) {
    el.innerHTML = `<p class="small">Nobody on this round yet.</p>`;
    return;
  }

  // Look the names up separately rather than letting the database join
  // them for us — attendance points at two different name tables, and
  // spelling the join out here keeps it unambiguous.
  const profileIds = rows.map(r => r.profile_id).filter(Boolean);
  let profById = new Map();
  if (profileIds.length) {
    const { data: profs } = await client
      .from("profiles").select("id, display_name").in("id", profileIds);
    profById = new Map((profs || []).map(p => [p.id, p.display_name]));
  }
  const playerById = new Map(currentPlayers.map(p => [p.id, p.name]));

  el.innerHTML = rows.map(r => {
    const isGuest = !!r.player_id;
    const name = isGuest
      ? (playerById.get(r.player_id) || "Player")
      : (profById.get(r.profile_id) || "Member");
    const tag = isGuest
      ? `<span class="small" style="color:var(--muted);">added by the committee</span>`
      : `<span class="small" style="color:var(--muted);">registered online</span>`;
    return `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid var(--line);">
        <span>${escapeHtml(name)} ${tag}</span>
        <button class="btn btn-outline btn-small" type="button" data-remove-attendance="${r.id}">Remove</button>
      </div>`;
  }).join("");

  el.querySelectorAll("[data-remove-attendance]").forEach(btn => {
    btn.addEventListener("click", () => removeFromRound(btn.dataset.removeAttendance, eventId));
  });
}

async function removeFromRound(attendanceId, eventId) {
  const statusEl = document.getElementById("guest-status");
  const { error } = await client.from("attendance").delete().eq("id", attendanceId);
  if (error) {
    statusEl.textContent = "Couldn't remove them: " + error.message;
    statusEl.className = "status-msg err";
    return;
  }
  statusEl.textContent = "";
  statusEl.className = "small";
  await refreshPlayingList(eventId);
}

async function addGuest(e) {
  e.preventDefault();
  const eventId = document.getElementById("playing-event-select").value;
  const nameInput = document.getElementById("guest-name");
  const handicapInput = document.getElementById("guest-handicap");
  const statusEl = document.getElementById("guest-status");
  const name = nameInput.value.trim();

  if (!eventId || !name) return;

  statusEl.textContent = "Adding…";
  statusEl.className = "small";

  // Typing a name that already exists should reuse that player rather
  // than creating a second copy of the same person.
  let player = currentPlayers.find(p => p.name.toLowerCase() === name.toLowerCase());

  if (!player) {
    const handicap = handicapInput.value === "" ? null : Number(handicapInput.value);
    const { data: created, error: createErr } = await client
      .from("players").insert({ name, handicap }).select().single();
    if (createErr) {
      statusEl.textContent = "Couldn't add that player: " + createErr.message;
      statusEl.className = "status-msg err";
      return;
    }
    player = created;
    currentPlayers.push(created);
  }

  const { error } = await client
    .from("attendance").insert({ event_id: eventId, player_id: player.id });

  if (error) {
    statusEl.textContent = error.code === "23505"
      ? `${name} is already on this round.`
      : "Couldn't add them to the round: " + error.message;
    statusEl.className = "status-msg err";
    return;
  }

  nameInput.value = "";
  handicapInput.value = "";
  statusEl.textContent = `${name} is on this round.`;
  statusEl.className = "status-msg ok";
  await refreshData();
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
  document.getElementById("add-guest-form").addEventListener("submit", addGuest);
  document.getElementById("prize-form").addEventListener("submit", savePrizes);
  document.getElementById("pot-form").addEventListener("submit", addPotEntry);
  document.getElementById("bank-form").addEventListener("submit", saveBankDetails);
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
