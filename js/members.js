// ------------------------------------------------------------------
// Logic for member.html — sign up, log in, edit your profile, and
// upload photos to the gallery. Anything that writes data requires
// being signed in AND approved — enforced both here (so the UI makes
// sense) and in the database itself (Row Level Security), so nothing
// here is "trust the browser" security.
// ------------------------------------------------------------------

let client;
let currentUser = null;
let currentMembership = null;
let currentProfile = null;

// Set when this page is reached via "Register to play" on a fixture
// (member.html?event=<id>).
const intendedEventId = new URLSearchParams(window.location.search).get("event");

document.addEventListener("DOMContentLoaded", () => {
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    wireAuthForms();
      wireProfileForms();
        loadEventOptions();
          refreshView();
          });

          async function refreshMemberDashboard() { const memberSelect = document.getElementById("dashboard-content"); if (!memberSelect) return; const loadingEl = document.getElementById("dashboard-loading"); const notLinkedEl = document.getElementById("dashboard-not-linked"); const contentEl = document.getElementById("dashboard-content"); if (!currentUser) return; const { data: player } = await client.from("players").select("id, name").eq("profile_id", currentUser.id).maybeSingle(); if (loadingEl) loadingEl.style.display = "none"; if (!player) { if (notLinkedEl) notLinkedEl.style.display = ""; return; } if (contentEl) contentEl.style.display = ""; const [resultsRes, attendanceRes] = await Promise.all([ client.from("results").select("gross_score, handicap, points, notes, events(name, event_date, venue)").eq("player_id", player.id), client.from("attendance").select("payment_status, events(name, event_date, cost)").eq("profile_id", currentUser.id) ]); const positionEl = document.getElementById("dashboard-position"); if (positionEl && typeof fetchAllData === "function" && typeof buildLeaderboard === "function") { try { const data = await fetchAllData(); const rows = buildLeaderboard(data.results, {}); const idx = rows.findIndex(r => r.name === player.name); if (idx > -1) { positionEl.textContent = `You're currently #${idx + 1} of ${rows.length} with ${rows[idx].totalPoints} points.`; } else { positionEl.textContent = "You haven't played a counting round yet."; } } catch (e) { positionEl.textContent = ""; } } const roundsEl = document.getElementById("dashboard-rounds"); if (roundsEl) { const rows = resultsRes.data || []; roundsEl.innerHTML = rows.length ? rows.map(r => `<li>${escapeHtml(r.events ? r.events.name : "Round")}${r.events && r.events.event_date ? " (" + r.events.event_date + ")" : ""}: ${r.points != null ? r.points + " pts" : "no score entered"}</li>`).join("") : "<li>No rounds recorded yet.</li>"; } const fixturesEl = document.getElementById("dashboard-fixtures"); if (fixturesEl) { const rows = attendanceRes.data || []; fixturesEl.innerHTML = rows.length ? rows.map(a => `<li>${escapeHtml(a.events ? a.events.name : "Fixture")}: ${a.payment_status || "unknown"}</li>`).join("") : "<li>No fixtures registered yet.</li>"; } const feesEl = document.getElementById("dashboard-fees"); if (feesEl) { const unpaid = (attendanceRes.data || []).filter(a => a.payment_status === "unpaid" && a.events && a.events.cost); const total = unpaid.reduce((sum, a) => sum + Number(a.events.cost || 0), 0); feesEl.textContent = unpaid.length ? `\u00a3${total.toFixed(2)} outstanding across ${unpaid.length} fixture${unpaid.length === 1 ? "" : "s"}.` : "Nothing outstanding."; } } async function refreshView() {
            const { data: { session } } = await client.auth.getSession();

              if (!session) {
                  currentUser = null;
                      show("logged-out-panel");
                          return;
                            }

                              currentUser = session.user;

                                const [{ data: profile }, { data: membership }] = await Promise.all([
                                    client.from("profiles").select("*").eq("id", currentUser.id).single(),
                                        client.from("memberships").select("*").eq("profile_id", currentUser.id).single()
                                          ]);

                                            currentProfile = profile;
                                              currentMembership = membership;

                                                if (!membership || membership.status === "pending") {
                                                    show("pending-panel"); describePending(membership);
                                                      } else if (membership.status === "rejected") {
                                                          show("rejected-panel");
                                                            } else {
                                                                if (intendedEventId) { await registerForEventAndRedirect(intendedEventId); return; }
                                                                show("approved-panel");
                                                                    document.getElementById("display-name-input").value = profile?.display_name || "";
                                                                    document.getElementById("handicap-input").value = profile?.handicap ?? "";
                                                                    document.getElementById("bio-input").value = profile?.bio || "";
                                                                        document.getElementById("current-avatar").src = profile?.avatar_url || "assets/logo.jpeg";
                                                                            document.getElementById("welcome-name").textContent = profile?.display_name || "there";
                                                                                loadMyPhotos(); refreshMemberDashboard();
                                                                                  }
                                                                                  }

                                                                                  function show(panelId) {
                                                                                    ["logged-out-panel", "pending-panel", "rejected-panel", "approved-panel"].forEach(id => {
                                                                                        document.getElementById(id).style.display = id === panelId ? "block" : "none";
                                                                                          });
                                                                                          }

                                                                                          function wireAuthForms() {
                                                                                            document.getElementById("signup-form").addEventListener("submit", async (e) => {
                                                                                                e.preventDefault();
                                                                                                    const displayName = document.getElementById("signup-name").value.trim();
                                                                                                        const email = document.getElementById("signup-email").value.trim();
                                                                                                            const password = document.getElementById("signup-password").value;
                                                                                                                const statusEl = document.getElementById("signup-status");
                                                                                                                
                                                                                                                    statusEl.textContent = "Creating your account…";
                                                                                                                        statusEl.className = "status-msg";
                                                                                                                        
                                                                                                                            const { error } = await client.auth.signUp({
                                                                                                                                  email,
                                                                                                                                        password,
                                                                                                                                              options: { data: { display_name: displayName, intended_event_id: intendedEventId || null } }
                                                                                                                                                  });
                                                                                                                                                  
                                                                                                                                                      if (error) {
                                                                                                                                                            statusEl.textContent = error.message;
                                                                                                                                                                  statusEl.className = "status-msg err";
                                                                                                                                                                        return;
                                                                                                                                                                            }
                                                                                                                                                                            
                                                                                                                                                                                statusEl.textContent = "Request sent! A committee member will approve your account, then you can log in.";
                                                                                                                                                                                    statusEl.className = "status-msg ok";
                                                                                                                                                                                        document.getElementById("signup-form").reset();
                                                                                                                                                                                          });
                                                                                                                                                                                          
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
                                                                                                                                                                                                                                              return;
                                                                                                                                                                                                                                                  }
                                                                                                                                                                                                                                                  
                                                                                                                                                                                                                                                      await refreshView();
                                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                                        
                                                                                                                                                                                                                                                          wirePasswordReset();

  document.querySelectorAll(".logout-btn").forEach(btn => {
                                                                                                                                                                                                                                                              btn.addEventListener("click", async () => {
                                                                                                                                                                                                                                                                    await client.auth.signOut();
                                                                                                                                                                                                                                                                          await refreshView();
                                                                                                                                                                                                                                                                              });
                                                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                                                }
                                                                                                                                                                                                                                                                                
                                                                                                                                                                                                                                                                                function wireProfileForms() {
                                                                                                                                                                                                                                                                                  document.getElementById("profile-form").addEventListener("submit", async (e) => {
                                                                                                                                                                                                                                                                                      e.preventDefault();
                                                                                                                                                                                                                                                                                          const name = document.getElementById("display-name-input").value.trim();
    const handicapRaw = document.getElementById("handicap-input").value.trim();
    const bio = document.getElementById("bio-input").value.trim();
                                                                                                                                                                                                                                                                                              const statusEl = document.getElementById("profile-status");
                                                                                                                                                                                                                                                                                                  if (!name) return;
                                                                                                                                                                                                                                                                                                  
                                                                                                                                                                                                                                                                                                      const { error } = await client.from("profiles").update({
      display_name: name,
      handicap: handicapRaw === "" ? null : Number(handicapRaw),
      bio: bio || null
    }).eq("id", currentUser.id);
                                                                                                                                                                                                                                                                                                          statusEl.textContent = error ? error.message : "Saved.";
                                                                                                                                                                                                                                                                                                              statusEl.className = error ? "status-msg err" : "status-msg ok";
                                                                                                                                                                                                                                                                                                                  if (!error) document.getElementById("welcome-name").textContent = name;
                                                                                                                                                                                                                                                                                                                    });
                                                                                                                                                                                                                                                                                                                    
                                                                                                                                                                                                                                                                                                                      document.getElementById("avatar-input").addEventListener("change", async (e) => {
                                                                                                                                                                                                                                                                                                                          const file = e.target.files[0];
                                                                                                                                                                                                                                                                                                                              if (!file) return;
                                                                                                                                                                                                                                                                                                                                  const statusEl = document.getElementById("profile-status");
                                                                                                                                                                                                                                                                                                                                      statusEl.textContent = "Uploading photo…";
                                                                                                                                                                                                                                                                                                                                          statusEl.className = "status-msg";
                                                                                                                                                                                                                                                                                                                                          
                                                                                                                                                                                                                                                                                                                                              const path = `${currentUser.id}/${Date.now()}-${file.name}`;
                                                                                                                                                                                                                                                                                                                                                  const { error: uploadError } = await client.storage.from("avatars").upload(path, file, { upsert: true });
                                                                                                                                                                                                                                                                                                                                                      if (uploadError) {
                                                                                                                                                                                                                                                                                                                                                            statusEl.textContent = uploadError.message;
                                                                                                                                                                                                                                                                                                                                                                  statusEl.className = "status-msg err";
                                                                                                                                                                                                                                                                                                                                                                        return;
                                                                                                                                                                                                                                                                                                                                                                            }
                                                                                                                                                                                                                                                                                                                                                                            
                                                                                                                                                                                                                                                                                                                                                                                const { data: urlData } = client.storage.from("avatars").getPublicUrl(path);
                                                                                                                                                                                                                                                                                                                                                                                    const { error: updateError } = await client.from("profiles").update({ avatar_url: urlData.publicUrl }).eq("id", currentUser.id);
                                                                                                                                                                                                                                                                                                                                                                                    
                                                                                                                                                                                                                                                                                                                                                                                        if (updateError) {
                                                                                                                                                                                                                                                                                                                                                                                              statusEl.textContent = updateError.message;
                                                                                                                                                                                                                                                                                                                                                                                                    statusEl.className = "status-msg err";
                                                                                                                                                                                                                                                                                                                                                                                                          return;
                                                                                                                                                                                                                                                                                                                                                                                                              }
                                                                                                                                                                                                                                                                                                                                                                                                              
                                                                                                                                                                                                                                                                                                                                                                                                                  document.getElementById("current-avatar").src = urlData.publicUrl;
                                                                                                                                                                                                                                                                                                                                                                                                                      statusEl.textContent = "Profile picture updated.";
                                                                                                                                                                                                                                                                                                                                                                                                                          statusEl.className = "status-msg ok";
                                                                                                                                                                                                                                                                                                                                                                                                                            });
                                                                                                                                                                                                                                                                                                                                                                                                                            
  // Photos can be picked in a batch — people usually come back from a
  // round with a handful, not one. Each is uploaded in turn so that one
  // bad file doesn't lose the rest, and the caption (if given) is
  // applied to all of them.
  document.getElementById("photo-upload-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const eventId = document.getElementById("photo-event-select").value;
    const caption = document.getElementById("photo-caption").value.trim();
    const files = Array.from(document.getElementById("photo-file-input").files || []);
    const statusEl = document.getElementById("photo-upload-status");

    if (!eventId || !files.length) {
      statusEl.textContent = "Pick a round and at least one photo first.";
      statusEl.className = "status-msg err";
      return;
    }

    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    let done = 0;
    const failed = [];

    for (const file of files) {
      statusEl.textContent = files.length > 1
        ? `Uploading photo ${done + 1} of ${files.length}…`
        : "Uploading…";
      statusEl.className = "status-msg";

      // Strip anything awkward out of the filename — phone cameras and
      // cloud photo libraries produce some unusual ones.
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${eventId}/${currentUser.id}-${Date.now()}-${done}-${safeName}`;

      const { error: uploadError } = await client.storage.from("gallery").upload(path, file);
      if (uploadError) { failed.push(`${file.name}: ${uploadError.message}`); continue; }

      const { error: insertError } = await client.from("photos").insert({
        event_id: eventId,
        uploader_id: currentUser.id,
        storage_path: path,
        caption: caption || null
      });
      if (insertError) { failed.push(`${file.name}: ${insertError.message}`); continue; }

      done++;
    }

    if (submitBtn) submitBtn.disabled = false;

    if (done && !failed.length) {
      statusEl.textContent = done === 1
        ? "Photo added to the gallery!"
        : `${done} photos added to the gallery!`;
      statusEl.className = "status-msg ok";
      document.getElementById("photo-upload-form").reset();
    } else if (done && failed.length) {
      statusEl.textContent = `Added ${done}, but ${failed.length} didn't upload — ${failed[0]}`;
      statusEl.className = "status-msg err";
    } else {
      statusEl.textContent = failed[0] || "Nothing was uploaded.";
      statusEl.className = "status-msg err";
    }

    loadMyPhotos(); refreshMemberDashboard();
  });
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  async function loadEventOptions() {
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    const c = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      const { data: events } = await c.from("events").select("*").order("event_date", { ascending: false });
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        const select = document.getElementById("photo-event-select");
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          if (!select || !events) return;
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            select.innerHTML = events.map(e => `<option value="${e.id}">${escapeHtml(e.name)} — ${e.event_date}</option>`).join("");
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            async function loadMyPhotos() {
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              const { data: photos } = await client
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  .from("photos")
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      .select("*, events(name, event_date)")
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          .eq("uploader_id", currentUser.id)
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              .order("created_at", { ascending: false });
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                const container = document.getElementById("my-photos");
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  if (!photos || !photos.length) {
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      container.innerHTML = `<p class="small">You haven't uploaded any photos yet.</p>`;
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          return;
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              container.innerHTML = `<div class="gallery-grid">${photos.map(p => {
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  const { data: urlData } = client.storage.from("gallery").getPublicUrl(p.storage_path);
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      return `
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            <div class="gallery-item">
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    <img src="${urlData.publicUrl}" alt="${escapeHtml(p.caption || '')}">
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            <div class="gallery-caption">
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      <strong>${escapeHtml(p.events?.name || 'Round')}</strong>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                ${p.caption ? `<span>${escapeHtml(p.caption)}</span>` : ''}
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        </div>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              </div>`;
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                }).join("")}</div>`;
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                function escapeHtml(str) {
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  if (str == null) return "";
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    return String(str)
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        .replaceAll("&", "&amp;")
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            .replaceAll("<", "&lt;")
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                .replaceAll(">", "&gt;")
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    .replaceAll('"', "&quot;");
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    


// ------------------------------------------------------------------
// Registering for a specific fixture (added with the fixtures accordion)
// ------------------------------------------------------------------

function formatEventDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// Banner reminding people which round they are registering for.
async function showEventContext() {
  if (!intendedEventId) return;
  const banner = document.getElementById("event-context");
  if (!banner) return;
  const { data: event } = await client.from("events")
    .select("name, venue, event_date").eq("id", intendedEventId).single();
  banner.style.display = "block";
  banner.textContent = event
    ? "Registering to play: " + event.name + (event.venue ? " - " + event.venue : "") + " (" + formatEventDate(event.event_date) + ")"
    : "Registering for a fixture - sign in or request to join below.";
}

// Tell a pending member which round they will be registered for on approval.
async function describePending(membership) {
  const msgEl = document.getElementById("pending-message");
  if (!msgEl) return;
  const eventId = (membership && membership.intended_event_id) || intendedEventId;
  if (!eventId) return;
  const { data: event } = await client.from("events").select("name").eq("id", eventId).single();
  if (event) {
    msgEl.textContent = "A committee member needs to approve your account first - the moment they do, you will be automatically registered for " + event.name + ". Check back soon.";
  }
}

// Already approved: register for the fixture, then back to the list.
async function registerForEventAndRedirect(eventId) {
  await client.from("attendance").insert({ event_id: eventId, profile_id: currentUser.id });
  window.location.href = "fixtures.html?registered=" + eventId;
}

document.addEventListener("DOMContentLoaded", () => { setTimeout(showEventContext, 0); });


// Forgotten password. Its own small form rather than borrowing the
// sign-in email box, so it's obvious what's being asked for.
//
// Supabase only ever sends to addresses that actually have an account,
// but it deliberately doesn't say which — and neither do we, because a
// form that confirms "yes, that person is a member" is a way to find
// out who belongs to the society.
// ------------------------------------------------------------------
function wirePasswordReset() {
  const link = document.getElementById("forgot-password-link");
  const panel = document.getElementById("reset-request-panel");
  const emailEl = document.getElementById("reset-email");
  const submit = document.getElementById("reset-submit");
  const cancel = document.getElementById("reset-cancel");
  if (!link || !panel || !emailEl || !submit) return;

  link.addEventListener("click", (e) => {
    e.preventDefault();
    panel.style.display = "block";
    link.style.display = "none";
    // Save them retyping it if they already started signing in.
    const typed = (document.getElementById("login-email") || {}).value || "";
    if (typed && !emailEl.value) emailEl.value = typed.trim();
    emailEl.focus();
  });

  if (cancel) cancel.addEventListener("click", () => {
    panel.style.display = "none";
    link.style.display = "";
    document.getElementById("reset-request-status").textContent = "";
  });

  submit.addEventListener("click", sendPasswordReset);

  // Enter inside this box should send the reset, not submit the sign-in form.
  emailEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); sendPasswordReset(); }
  });
}

async function sendPasswordReset() {
  const statusEl = document.getElementById("reset-request-status");
  const submit = document.getElementById("reset-submit");
  const email = (document.getElementById("reset-email").value || "").trim();

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    statusEl.textContent = "Enter a valid email address.";
    statusEl.className = "status-msg err";
    return;
  }

  submit.disabled = true;
  statusEl.textContent = "Sending\u2026";
  statusEl.className = "status-msg";

  const redirectTo = window.location.origin +
    window.location.pathname.replace(/member\.html$/, "") + "reset-password.html";
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });

  submit.disabled = false;

  if (error) {
    statusEl.textContent = error.message;
    statusEl.className = "status-msg err";
    return;
  }

  statusEl.textContent = "If that address has an account, a reset link is on its way. Check your inbox and spam folder.";
  statusEl.className = "status-msg ok";
}
