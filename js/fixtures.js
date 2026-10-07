// ------------------------------------------------------------------
// Logic for fixtures.html — the season fixture list, where each round
// expands in place to show its full details, who's playing, and a way
// to register.
//
// Anyone can browse and expand. Registering requires being a signed-in,
// approved member; anyone else is sent to member.html tagged with the
// fixture they wanted, and is registered automatically once a committee
// member approves them.
// ------------------------------------------------------------------

let client;
let currentUser = null;
let currentDisplayName = "";
let isApprovedMember = false;
let membershipStatus = null;
let bankDetails = null;
let leagueSettings = { max_players: 32, close_days: 7 };
const loadedAttendees = new Set();
const eventsWithResults = new Set();
const eventsById = new Map();

document.addEventListener("DOMContentLoaded", async () => {
  client = getClient();
  const listEl = document.getElementById("fixture-list");

  const { data: { session } } = await client.auth.getSession();
  if (session) {
    currentUser = session.user;
    const { data: membership } = await client
      .from("memberships")
      .select("status")
      .eq("profile_id", currentUser.id)
      .maybeSingle();
    membershipStatus = membership?.status || null;
    isApprovedMember = membershipStatus === "approved";

    if (isApprovedMember) {
      // Both only readable once you're an approved member, which is
      // exactly the point — the bank details aren't public.
      const [{ data: profile }, { data: settings }] = await Promise.all([
        client.from("profiles").select("display_name").eq("id", currentUser.id).maybeSingle(),
        client.from("society_settings").select("*").maybeSingle()
      ]);
      currentDisplayName = profile?.display_name || "";
      bankDetails = settings || null;
    }
  }

  try {
    const { data: ls } = await client.from("league_settings").select("max_players, close_days").maybeSingle();
    if (ls) leagueSettings = { max_players: ls.max_players || 32, close_days: ls.close_days == null ? 7 : ls.close_days };
  } catch (lsErr) { console.error(lsErr); }

  let events, results;
  try {
    ({ events, results } = await fetchAllData());
    // Which rounds actually have scores logged — a past fixture with none
    // shouldn't send people to a results page that doesn't list it.
    results.forEach(r => eventsWithResults.add(r.event_id));
  } catch (err) {
    console.error(err);
    listEl.innerHTML = `<li class="empty-state">Couldn't load fixtures yet — please try again in a moment.</li>`;
    return;
  }

  events.forEach(e => eventsById.set(e.id, e)); try { const att = (await client.from("attendance").select("event_id, player_id, profile_id").eq("status", "playing")).data || []; const plyrs = (await client.from("players").select("id, profile_id")).data || []; events.forEach(e => { const seen = new Set(); att.filter(a => a.event_id === e.id).forEach(a => { let key = a.profile_id; if (!key && a.player_id) { const pl = plyrs.find(p => p.id === a.player_id); key = (pl && pl.profile_id) ? pl.profile_id : "p:" + a.player_id; } if (key) seen.add(key); }); const played = results.filter(r => r.event_id === e.id).length; e.playerCount = played > 0 ? played : seen.size; }); } catch (countErr) { console.error(countErr); }

  const sorted = [...events].sort((a, b) => a.event_date.localeCompare(b.event_date));
  listEl.innerHTML = sorted.length
    ? sorted.map(e => renderFixtureItem(e)).join("")
    : `<li class="empty-state">No fixtures posted yet.</li>`;

  wireAccordion(listEl);
  handleArrivalFromRegistration(sorted);
});

function wireAccordion(listEl) {
  listEl.addEventListener("click", (e) => {
    const head = e.target.closest(".fixture-head");
    if (!head) return;
    const item = head.closest(".fixture-item");
    toggleItem(item, head.getAttribute("aria-expanded") !== "true");
  });
}

function toggleItem(item, open) {
  const head = item.querySelector(".fixture-head");
  const panel = item.querySelector(".fixture-panel");
  const eventId = item.dataset.eventId;

  head.setAttribute("aria-expanded", open ? "true" : "false");
  panel.hidden = !open;
  item.classList.toggle("is-open", open);

  // Only hit the database the first time a given fixture is opened.
  if (open && !loadedAttendees.has(eventId)) {
    loadedAttendees.add(eventId);
    renderRegisterControl(eventId);
    refreshAttendees(eventId);
    refreshGroups(eventId);
  }
}

// If we've just come back from registering via the join/sign-in page,
// open that fixture straight away and confirm it worked.
function handleArrivalFromRegistration(events) {
  const params = new URLSearchParams(window.location.search);
  const registeredId = params.get("registered");
  const target = registeredId || (window.location.hash || "").replace("#event-", "");
  if (!target) return;

  const item = document.querySelector(`.fixture-item[data-event-id="${target}"]`);
  if (!item) return;

  toggleItem(item, true);
  if (registeredId) {
    const slot = item.querySelector(".register-slot");
    slot.insertAdjacentHTML("beforebegin", `<p class="status-msg ok">You're registered — see you there!</p>`);
  }
  item.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function refreshAttendees(eventId) {
  const slot = document.querySelector(`[data-attendees-for="${eventId}"]`);
  if (!slot) return;

  // The playing list holds two kinds of people: members who registered
  // themselves, and anyone the committee added by hand — guests, or
  // players who don't use the website. Both belong on the list.
  const { data: allRows, error } = await client
    .from("attendance")
    .select("profile_id, player_id, status")
    .eq("event_id", eventId)
    .order("created_at", { ascending: true });

  if (error) {
    slot.innerHTML = `<p class="small">Couldn't load who's playing yet.</p>`;
    return;
  }

  const rows = allRows.filter(r => r.status !== "waiting");
  const waitingRows = allRows.filter(r => r.status === "waiting");
  const event = eventsById.get(eventId);
  const cap = capFor(event);
  const isPastRound = (slot.closest(".fixture-item") || {}).dataset?.past === "true";

  if (!rows.length) {
    const item = slot.closest(".fixture-item");
    const isPast = item && item.dataset.past === "true";
    slot.innerHTML = isPast
      ? `<p class="small">This round has been completed.</p>`
      : `<p class="small">Nobody's registered yet — be the first!</p>`;
    return;
  }

  const names = await resolveAttendeeNames(rows);

  /* Alphabetical rather than the order people registered, so the list
     reads like a team sheet. Each name carries its handicap in
     brackets, so the sort ignores that and compares the name itself. */
  const waitingNames = waitingRows.length ? await resolveAttendeeNames(waitingRows) : [];

  slot.innerHTML = (isPastRound ? "" : `<p class="small" style="margin:0 0 6px;"><strong>${rows.length}</strong> of ${cap} places taken${rows.length >= cap ? " · full" : ""}</p>`) +
    `<div class="attendee-list">${names
    .slice()
    .sort((a, b) => bareName(a).localeCompare(bareName(b)))
    .map(n => `<span class="attendee-chip">${escapeHtml(n)}</span>`)
    .join("")}</div>` +
    (waitingNames.length && !isPastRound
      ? `<p class="small" style="margin:12px 0 6px;">Waiting list, in order</p><div class="attendee-list">${waitingNames.map(n => `<span class="attendee-chip" style="opacity:.7;">${escapeHtml(n)}</span>`).join("")}</div>`
      : "");
}

// ---- Places and closing date -----------------------------------------
// The database enforces both; these just let the page say so up front.
function capFor(event) {
  return (event && event.max_players) || leagueSettings.max_players || 32;
}
function closesOn(event) {
  const p = String(event.event_date).split("-");
  const d = new Date(+p[0], +p[1] - 1, +p[2]);
  d.setDate(d.getDate() - (leagueSettings.close_days == null ? 7 : leagueSettings.close_days));
  return d;
}
function isClosed(event) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return today > closesOn(event);
}
function niceDay(d) {
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

/* "Alan Dunn (13.2)" sorts as "Alan Dunn". */
function bareName(s) {
  return String(s).replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/* The tee draw and the pairs draw, both read from the same groupings
   table and told apart by group_type. Nothing shows at all until the
   committee has posted a draw, so an ungrouped round just looks like a
   normal one rather than carrying an empty heading, and a round with
   pairs but no tee draw shows only the pairs.

   Each group is a card with the names stacked underneath, and the cards
   sit side by side across the fixture, so a four is read down a column
   rather than along a line. A player may appear in two pairs on an odd
   turnout, which needs nothing special here: rows are grouped by number
   and whoever is in a group is listed. */
async function refreshGroups(eventId) {
  const slot = document.querySelector(`[data-groups-for="${eventId}"]`);
  if (!slot) return;

  const { data: rows, error } = await client
    .from("groupings")
    .select("profile_id, player_id, group_number, position, group_type")
    .eq("event_id", eventId)
    .order("group_number", { ascending: true });

  if (error || !rows || !rows.length) return;

  const names = await resolveAttendeeNames(rows);

  const collect = (type) => {
    const byNumber = new Map();
    rows.forEach((r, i) => {
      if ((r.group_type || "fours") !== type) return;
      if (!byNumber.has(r.group_number)) byNumber.set(r.group_number, []);
      byNumber.get(r.group_number).push(names[i]);
    });
    /* Groups in number order, and the names inside each group
       alphabetical, since who is listed first in a four means nothing. */
    byNumber.forEach(list => list.sort((a, b) => bareName(a).localeCompare(bareName(b))));
    return [...byNumber.entries()].sort((a, b) => a[0] - b[0]);
  };

  const block = (label, word, entries) => entries.length ? `
    <div class="fixture-section-label">${label}</div>
    <div class="tee-groups">
      ${entries.map(([number, players]) => `
        <div class="tee-group">
          <span class="tee-group-label">${word} ${number}</span>
          <ul class="tee-group-names">
            ${players.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}
          </ul>
        </div>`).join("")}
    </div>` : "";

  slot.innerHTML = block("Tee groups", "Group", collect("fours")) +
    block("Pairs", "Pair", collect("pairs"));
}

// Names live in two tables, so they're looked up explicitly rather than
// leaning on an automatic join.
function hcapSuffix(h) { return (h === null || h === undefined || h === "") ? "" : " (" + h + ")"; } async function resolveAttendeeNames(rows) {
  const profileIds = rows.map(r => r.profile_id).filter(Boolean);
  const playerIds = rows.map(r => r.player_id).filter(Boolean);

  const [profs, plyrs] = await Promise.all([
    profileIds.length
      ? client.from("profiles").select("id, display_name, handicap").in("id", profileIds)
      : Promise.resolve({ data: [] }),
    playerIds.length
      ? client.from("players").select("id, name, handicap, profile_id").or("id.in.(" + (playerIds.length ? playerIds.join(",") : "00000000-0000-0000-0000-000000000000") + "),profile_id.in.(" + (profileIds.length ? profileIds.join(",") : "00000000-0000-0000-0000-000000000000") + ")")
      : Promise.resolve({ data: [] })
  ]);

  const profById = new Map((profs.data || []).map(p => [p.id, p.display_name + hcapSuffix(p.handicap != null ? p.handicap : (((plyrs.data || []).find(pl => pl.profile_id === p.id) || {}).handicap))]));
  const playerById = new Map((plyrs.data || []).map(p => [p.id, p.name + hcapSuffix(p.handicap)]));

  return rows.filter(r => { if (!r.player_id) return true; const pl = (plyrs.data || []).find(p => p.id === r.player_id); return !(pl && pl.profile_id && profileIds.indexOf(pl.profile_id) !== -1); }).map(r => r.player_id
    ? (playerById.get(r.player_id) || "Player")
    : (profById.get(r.profile_id) || "Member"));
}

async function renderRegisterControl(eventId) {
  const slot = document.querySelector(`[data-register-for="${eventId}"]`);
  if (!slot) return;

  // A round that's already been played can't be registered for — offer its
  // results instead, but only if the committee has actually logged them.
  const item = slot.closest(".fixture-item");
  if (item && item.dataset.past === "true") {
    slot.innerHTML = eventsWithResults.has(eventId)
      ? `<a class="btn btn-brass" href="results.html#event-${eventId}">See results</a>`
      : `<p class="small">This round has been played — results will appear here once the committee logs them.</p>`;
    return;
  }

  if (!currentUser) {
    slot.innerHTML = `
      <a class="btn btn-brass" href="member.html?event=${eventId}">Register to play</a>
      <p class="small" style="margin-top:8px;">Already a member? You'll just need to sign in there. New here? You'll be asked to request to join — a committee member approves new members, and you'll be automatically registered for this round the moment that happens.</p>`;
    return;
  }

  if (!isApprovedMember) {
    slot.innerHTML = membershipStatus === "rejected"
      ? `<p class="small">Your membership request wasn't approved, so you can't register for rounds. Get in touch via the <a href="contact.html">contact page</a> if that's a mistake.</p>`
      : `<p class="small">Your member account is still pending approval — once a committee member approves it, you'll be able to register here.</p>`;
    return;
  }

  const event = eventsById.get(eventId);
  const [{ data: myRow }, { data: myGuests }, { data: everyone }] = await Promise.all([
    client.from("attendance_payments")
      .select("id, payment_status, payment_reference, status, created_at")
      .eq("event_id", eventId).eq("profile_id", currentUser.id).maybeSingle(),
    client.from("attendance_payments")
      .select("id, player_id, payment_status, status")
      .eq("event_id", eventId).eq("guest_of", currentUser.id),
    client.from("attendance").select("id, status, created_at").eq("event_id", eventId).order("created_at", { ascending: true })
  ]);

  let guests = myGuests || [];
  if (guests.length) {
    const { data: gp } = await client.from("players").select("id, name").in("id", guests.map(g => g.player_id));
    const byId = new Map((gp || []).map(p => [p.id, p.name]));
    guests = guests.map(g => Object.assign({}, g, { name: byId.get(g.player_id) || "Guest" }));
  }

  const all = everyone || [];
  const taken = all.filter(r => r.status !== "waiting").length;
  const waitingOrder = all.filter(r => r.status === "waiting").map(r => r.id);
  drawAttendanceButton(slot, eventId, myRow || null, { event, taken, cap: capFor(event), guests, waitingOrder });
}

function drawAttendanceButton(slot, eventId, myRow, ctx) {
  const isRegistered = !!myRow;
  const event = ctx.event;
  const closed = isClosed(event);
  const full = ctx.taken >= ctx.cap;
  const left = Math.max(0, ctx.cap - ctx.taken);

  if (!isRegistered) {
    if (closed) {
      slot.innerHTML = `<p class="small">Sign-ups for this round closed on ${niceDay(closesOn(event))}. If you still want to play, ask a committee member.</p>`;
      return;
    }
    slot.innerHTML = full
      ? `<button class="btn btn-brass" type="button" data-join>Join the waiting list</button>
         <p class="small" style="margin-top:8px;">All ${ctx.cap} places are taken. If one comes free, the committee will offer it to the waiting list in order.</p>`
      : `<button class="btn btn-brass" type="button" data-join>I'm playing</button>
         <p class="small" style="margin-top:8px;">${left} of ${ctx.cap} places left. Sign-ups close ${niceDay(closesOn(event))}.</p>`;
    slot.querySelector("[data-join]").addEventListener("click", async (e) => {
      e.target.disabled = true;
      const myPlayers = ((await client.from("players").select("id").eq("profile_id", currentUser.id)).data) || [];
      if (myPlayers.length) { await client.from("attendance").delete().eq("event_id", eventId).in("player_id", myPlayers.map(p => p.id)); }
      const { error } = await client.from("attendance").insert({ event_id: eventId, profile_id: currentUser.id });
      if (error) return showSlotError(slot, error);
      await renderRegisterControl(eventId);
      refreshAttendees(eventId);
    });
    return;
  }

  if (myRow.status === "waiting") {
    const pos = ctx.waitingOrder.indexOf(myRow.id) + 1;
    slot.innerHTML = `<p class="small"><span class="pay-status is-claimed">Waiting list${pos ? " · " + ordinal(pos) : ""}</span> The round is full. If a place comes up, a committee member will move you onto it, and you'll pay then.</p>
      <button class="btn btn-outline btn-small" type="button" data-leave>Take me off the waiting list</button>`;
    slot.querySelector("[data-leave]").addEventListener("click", () => leaveRound(slot, eventId));
    return;
  }

  slot.innerHTML = `<p class="small"><span class="pay-status is-confirmed">You're playing</span></p>
    <button class="btn btn-outline btn-small" type="button" data-leave>Can't make it after all</button>
    ${ctx.guests.length ? `<p class="small" style="margin-top:6px;">If you pull out, your ${ctx.guests.length === 1 ? "guest stays" : "guests stay"} on the list until you remove them below or the committee does.</p>` : ""}`;
  slot.querySelector("[data-leave]").addEventListener("click", () => leaveRound(slot, eventId));

  renderGuestBlock(slot, eventId, ctx, closed);
  renderPaymentBlock(slot, eventId, myRow, ctx.guests);
}

async function leaveRound(slot, eventId) {
  slot.querySelectorAll("button").forEach(b => b.disabled = true);
  const { error } = await client.from("attendance").delete()
    .eq("event_id", eventId).eq("profile_id", currentUser.id);
  if (error) return showSlotError(slot, error);
  await renderRegisterControl(eventId);
  refreshAttendees(eventId);
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---- Guests ----------------------------------------------------------
// A member can bring guests. Each guest takes a place (or goes on the
// waiting list if the round is full) and the member pays for them.
function renderGuestBlock(slot, eventId, ctx, closed) {
  const list = ctx.guests.map(g => `
      <li style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:6px 0; border-bottom:1px solid var(--line);">
        <span>${escapeHtml(g.name)}
          ${g.status === "waiting" ? `<span class="pay-status is-claimed">Waiting list</span>` : ""}
          ${g.payment_status === "confirmed" ? `<span class="pay-status is-confirmed">Paid</span>` : ""}
        </span>
        ${g.payment_status === "confirmed" ? "" : `<button class="btn btn-outline btn-small" type="button" data-remove-guest="${g.id}">Remove</button>`}
      </li>`).join("");

  slot.insertAdjacentHTML("beforeend", `
    <div class="pay-box guest-box">
      <strong>Your guests</strong>
      ${ctx.guests.length ? `<ul style="list-style:none; margin:6px 0 10px; padding:0;">${list}</ul>` : `<p class="small">Bringing someone? Add them here. They take a place on the round and you pay for them.</p>`}
      ${closed
        ? `<p class="small">Sign-ups have closed, so guests can only be added by a committee member now.</p>`
        : `<form data-guest-form style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end;">
             <div class="form-field" style="flex:1 1 200px; margin:0;">
               <label for="guest-name-${eventId}">Guest's full name</label>
               <input id="guest-name-${eventId}" required minlength="2" autocomplete="off" placeholder="First and last name">
             </div>
             <button class="btn btn-outline btn-small" type="submit">Add guest</button>
           </form>`}
      <div class="small" data-guest-status style="margin-top:6px;"></div>
    </div>`);

  const box = slot.querySelector(".guest-box");
  const status = box.querySelector("[data-guest-status]");
  const form = box.querySelector("[data-guest-form]");
  if (form) form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = form.querySelector("input");
    const btn = form.querySelector("button");
    btn.disabled = true;
    const { error } = await client.rpc("register_guest", { p_event: eventId, p_name: input.value });
    if (error) { status.innerHTML = `<span class="status-msg err">${escapeHtml(error.message)}</span>`; btn.disabled = false; return; }
    await renderRegisterControl(eventId);
    refreshAttendees(eventId);
  });
  box.querySelectorAll("[data-remove-guest]").forEach(b => b.addEventListener("click", async () => {
    b.disabled = true;
    const { error } = await client.rpc("remove_guest", { p_attendance: b.dataset.removeGuest });
    if (error) { status.innerHTML = `<span class="status-msg err">${escapeHtml(error.message)}</span>`; b.disabled = false; return; }
    await renderRegisterControl(eventId);
    refreshAttendees(eventId);
  }));
}

function showSlotError(slot, error) {
  slot.innerHTML = `<p class="status-msg err">${escapeHtml(error.message)}</p>`;
}

// ------------------------------------------------------------------
// Paying for a round. No card processing — the society is paid by
// bank transfer, so nothing sensitive passes through the website and
// there are no fees taken out of the green fee. All the site tracks is
// whether somebody says they've paid, and whether that's been checked.
// A member pays for themselves and any guests with a place, in one go.
// ------------------------------------------------------------------
function renderPaymentBlock(slot, eventId, myRow, guests) {
  const event = eventsById.get(eventId);
  const cost = event && event.cost != null ? Number(event.cost) : null;
  if (!cost) return;

  const covered = [{ name: "You", payment_status: myRow.payment_status || "unpaid" }]
    .concat((guests || []).filter(g => g.status !== "waiting").map(g => ({ name: g.name, payment_status: g.payment_status || "unpaid" })));
  const outstanding = covered.filter(c => c.payment_status !== "confirmed");
  const status = !outstanding.length ? "confirmed"
    : outstanding.every(c => c.payment_status === "claimed") ? "claimed" : "unpaid";
  const reference = myRow.payment_reference || buildPaymentReference(event);
  const owed = outstanding.length * cost;

  const bank = bankDetails && (bankDetails.account_name || bankDetails.account_number)
    ? `<dl class="fixture-facts">
         ${bankDetails.account_name ? `<dt>Account</dt><dd>${escapeHtml(bankDetails.account_name)}</dd>` : ""}
         ${bankDetails.sort_code ? `<dt>Sort code</dt><dd>${escapeHtml(bankDetails.sort_code)}</dd>` : ""}
         ${bankDetails.account_number ? `<dt>Account no.</dt><dd>${escapeHtml(bankDetails.account_number)}</dd>` : ""}
         <dt>Reference</dt><dd class="pay-ref">${escapeHtml(reference)}</dd>
       </dl>
       ${bankDetails.payment_note ? `<p class="small">${escapeHtml(bankDetails.payment_note)}</p>` : ""}`
    : `<p class="small">The committee hasn't added the society's bank details yet — they'll appear here once they do.</p>`;

  const heading = covered.length > 1
    ? `${formatCost(owed || cost * covered.length)} to play <span class="small">(you + ${covered.length - 1} ${covered.length === 2 ? "guest" : "guests"} at ${formatCost(cost)} each${outstanding.length < covered.length && outstanding.length ? ", " + (covered.length - outstanding.length) + " already paid" : ""})</span>`
    : `${formatCost(cost)} to play`;

  let action;
  if (status === "confirmed") {
    action = `<p class="small"><span class="pay-status is-confirmed">Paid</span> Thanks — the committee has this one.</p>`;
  } else if (status === "claimed") {
    action = `<p class="small"><span class="pay-status is-claimed">Awaiting check</span> You've flagged this as paid. A committee member will confirm it once it lands.</p>
              <button class="btn btn-outline btn-small" type="button" data-pay="unpaid">Actually, I haven't paid yet</button>`;
  } else {
    action = `<button class="btn btn-brass" type="button" data-pay="claimed">I've paid${outstanding.length > 1 ? " " + formatCost(owed) : ""}</button>`;
  }

  slot.insertAdjacentHTML("beforeend", `
    <div class="pay-box">
      <strong>${heading}</strong>
      ${status === "confirmed" ? "" : bank}
      ${action}
      <div class="small" data-pay-status></div>
    </div>`);

  const btn = slot.querySelector("[data-pay]");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const { error } = await client.rpc("claim_round_payment", {
      p_event: eventId, p_status: btn.dataset.pay, p_reference: reference
    });

    if (error) {
      slot.querySelector("[data-pay-status]").innerHTML =
        `<span class="status-msg err">${escapeHtml(error.message)}</span>`;
      btn.disabled = false;
      return;
    }

    renderRegisterControl(eventId);
  });
}

// Something short that the treasurer can match against a bank line:
// the round, then the member's surname.
function buildPaymentReference(event) {
  const round = (event.name.match(/\d+/) || [])[0];
  const surname = (currentDisplayName.trim().split(/\s+/).pop() || "MEMBER").toUpperCase();
  return `${round ? "R" + round : "FAGS"} ${surname}`.slice(0, 18);
}
