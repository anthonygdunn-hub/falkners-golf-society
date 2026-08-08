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
let isApprovedMember = false;
let membershipStatus = null;
const loadedAttendees = new Set();

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
  }

  let events;
  try {
    ({ events } = await fetchAllData());
  } catch (err) {
    console.error(err);
    listEl.innerHTML = `<li class="empty-state">Couldn't load fixtures yet — has the Supabase connection been set up? See README.md.</li>`;
    return;
  }

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

  const { data: rows, error } = await client
    .from("attendance")
    .select("profiles(display_name)")
    .eq("event_id", eventId)
    .order("created_at", { ascending: true });

  if (error) {
    slot.innerHTML = `<p class="small">Couldn't load who's playing yet.</p>`;
    return;
  }

  slot.innerHTML = rows.length
    ? `<div class="attendee-list">${rows
        .map(r => `<span class="attendee-chip">${escapeHtml(r.profiles?.display_name || "Member")}</span>`)
        .join("")}</div>`
    : `<p class="small">Nobody's registered yet — be the first!</p>`;
}

async function renderRegisterControl(eventId) {
  const slot = document.querySelector(`[data-register-for="${eventId}"]`);
  if (!slot) return;

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
    .select("id")
    .eq("event_id", eventId)
    .eq("profile_id", currentUser.id)
    .maybeSingle();

  drawAttendanceButton(slot, eventId, !!myRow);
}

function drawAttendanceButton(slot, eventId, isRegistered) {
  slot.innerHTML = isRegistered
    ? `<button class="btn btn-outline" type="button">Can't make it after all</button>`
    : `<button class="btn btn-brass" type="button">I'm playing</button>`;

  slot.querySelector("button").addEventListener("click", async () => {
    const btn = slot.querySelector("button");
    btn.disabled = true;

    const { error } = isRegistered
      ? await client.from("attendance").delete().eq("event_id", eventId).eq("profile_id", currentUser.id)
      : await client.from("attendance").insert({ event_id: eventId, profile_id: currentUser.id });

    if (error) {
      slot.innerHTML = `<p class="status-msg err">${escapeHtml(error.message)}</p>`;
      return;
    }

    drawAttendanceButton(slot, eventId, !isRegistered);
    refreshAttendees(eventId);
  });
}
