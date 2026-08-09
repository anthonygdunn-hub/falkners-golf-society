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

  let events, results;
  try {
    ({ events, results } = await fetchAllData());
    // Which rounds actually have scores logged — a past fixture with none
    // shouldn't send people to a results page that doesn't list it.
    results.forEach(r => eventsWithResults.add(r.event_id));
  } catch (err) {
    console.error(err);
    listEl.innerHTML = `<li class="empty-state">Couldn't load fixtures yet — has the Supabase connection been set up? See README.md.</li>`;
    return;
  }

  events.forEach(e => eventsById.set(e.id, e));

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
  const { data: rows, error } = await client
    .from("attendance")
    .select("profile_id, player_id")
    .eq("event_id", eventId)
    .order("created_at", { ascending: true });

  if (error) {
    slot.innerHTML = `<p class="small">Couldn't load who's playing yet.</p>`;
    return;
  }

  if (!rows.length) {
    slot.innerHTML = `<p class="small">Nobody's registered yet — be the first!</p>`;
    return;
  }

  const names = await resolveAttendeeNames(rows);

  slot.innerHTML = `<div class="attendee-list">${names
    .map(n => `<span class="attendee-chip">${escapeHtml(n)}</span>`)
    .join("")}</div>`;
}

// Names live in two tables, so they're looked up explicitly rather than
// leaning on an automatic join.
async function resolveAttendeeNames(rows) {
  const profileIds = rows.map(r => r.profile_id).filter(Boolean);
  const playerIds = rows.map(r => r.player_id).filter(Boolean);

  const [profs, plyrs] = await Promise.all([
    profileIds.length
      ? client.from("profiles").select("id, display_name").in("id", profileIds)
      : Promise.resolve({ data: [] }),
    playerIds.length
      ? client.from("players").select("id, name").in("id", playerIds)
      : Promise.resolve({ data: [] })
  ]);

  const profById = new Map((profs.data || []).map(p => [p.id, p.display_name]));
  const playerById = new Map((plyrs.data || []).map(p => [p.id, p.name]));

  return rows.map(r => r.player_id
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

  const { data: myRow } = await client
    .from("attendance")
    .select("id, payment_status, payment_reference")
    .eq("event_id", eventId)
    .eq("profile_id", currentUser.id)
    .maybeSingle();

  drawAttendanceButton(slot, eventId, myRow || null);
}

function drawAttendanceButton(slot, eventId, myRow) {
  const isRegistered = !!myRow;

  slot.innerHTML = isRegistered
    ? `<button class="btn btn-outline" type="button">Can't make it after all</button>`
    : `<button class="btn btn-brass" type="button">I'm playing</button>`;

  slot.querySelector("button").addEventListener("click", async () => {
    const btn = slot.querySelector("button");
    btn.disabled = true;

    if (isRegistered) {
      const { error } = await client.from("attendance").delete()
        .eq("event_id", eventId).eq("profile_id", currentUser.id);
      if (error) return showSlotError(slot, error);
      drawAttendanceButton(slot, eventId, null);
    } else {
      const { data, error } = await client.from("attendance")
        .insert({ event_id: eventId, profile_id: currentUser.id })
        .select("id, payment_status, payment_reference").single();
      if (error) return showSlotError(slot, error);
      drawAttendanceButton(slot, eventId, data);
    }

    refreshAttendees(eventId);
  });

  if (isRegistered) renderPaymentBlock(slot, eventId, myRow);
}

function showSlotError(slot, error) {
  slot.innerHTML = `<p class="status-msg err">${escapeHtml(error.message)}</p>`;
}

// ------------------------------------------------------------------
// Paying for a round. No card processing — the society is paid by
// bank transfer, so nothing sensitive passes through the website and
// there are no fees taken out of the green fee. All the site tracks is
// whether somebody says they've paid, and whether that's been checked.
// ------------------------------------------------------------------
function renderPaymentBlock(slot, eventId, myRow) {
  const event = eventsById.get(eventId);
  const cost = event && event.cost != null ? Number(event.cost) : null;
  if (!cost) return;

  const status = myRow.payment_status || "unpaid";
  const reference = myRow.payment_reference || buildPaymentReference(event);

  const bank = bankDetails && (bankDetails.account_name || bankDetails.account_number)
    ? `<dl class="fixture-facts">
         ${bankDetails.account_name ? `<dt>Account</dt><dd>${escapeHtml(bankDetails.account_name)}</dd>` : ""}
         ${bankDetails.sort_code ? `<dt>Sort code</dt><dd>${escapeHtml(bankDetails.sort_code)}</dd>` : ""}
         ${bankDetails.account_number ? `<dt>Account no.</dt><dd>${escapeHtml(bankDetails.account_number)}</dd>` : ""}
         <dt>Reference</dt><dd class="pay-ref">${escapeHtml(reference)}</dd>
       </dl>
       ${bankDetails.payment_note ? `<p class="small">${escapeHtml(bankDetails.payment_note)}</p>` : ""}`
    : `<p class="small">The committee hasn't added the society's bank details yet — they'll appear here once they do.</p>`;

  let action;
  if (status === "confirmed") {
    action = `<p class="small"><span class="pay-status is-confirmed">Paid</span> Thanks — the committee has this one.</p>`;
  } else if (status === "claimed") {
    action = `<p class="small"><span class="pay-status is-claimed">Awaiting check</span> You've flagged this as paid. A committee member will confirm it once it lands.</p>
              <button class="btn btn-outline btn-small" type="button" data-pay="unpaid">Actually, I haven't paid yet</button>`;
  } else {
    action = `<button class="btn btn-brass" type="button" data-pay="claimed">I've paid</button>`;
  }

  slot.insertAdjacentHTML("beforeend", `
    <div class="pay-box">
      <strong>${formatCost(cost)} to play</strong>
      ${status === "confirmed" ? "" : bank}
      ${action}
      <div class="small" data-pay-status></div>
    </div>`);

  const btn = slot.querySelector("[data-pay]");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const next = btn.dataset.pay;
    const { error } = await client.from("attendance").update({
      payment_status: next,
      payment_reference: next === "claimed" ? reference : null
    }).eq("id", myRow.id);

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
