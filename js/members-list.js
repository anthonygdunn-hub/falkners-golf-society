// ------------------------------------------------------------------
// Logic for members.html / member.html — the society directory.
//
// The list comes from the member_directory() database function, which
// returns nothing unless the person asking is an approved member. So
// the gate is enforced in the database, not just hidden in the page:
// there's no request a curious visitor can make to get the names.
// ------------------------------------------------------------------

(function () {
  let client;

 document.addEventListener("DOMContentLoaded", async () => {
     client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

                             const intro = document.getElementById("members-intro");
     const locked = document.getElementById("members-locked");
     const lockedMsg = document.getElementById("members-locked-msg");
     const list = document.getElementById("members-list");
     if (!intro || !locked || !lockedMsg || !list) return;

                             const showLocked = (html) => {
                                   intro.style.display = "none";
                                   list.style.display = "none";
                                   locked.style.display = "block";
                                   lockedMsg.innerHTML = html;
                             };

                             const { data: { session } } = await client.auth.getSession();
     if (!session) {
           showLocked('The members list is for members only. <a href="member.html">Sign in</a> to see who else plays.');
           return;
     }

                             const { data: rows, error } = await client.rpc("member_directory");

                             if (error) {
                                   console.error(error);
                                   showLocked("Couldn't load the members list just now. Please try again shortly.");
                                   return;
                             }

                             if (!rows || !rows.length) {
                                   showLocked("Your membership is still awaiting approval &mdash; once a committee member approves it, you'll be able to see the other members here.");
                                   return;
                             }

                             intro.textContent = `${rows.length} member${rows.length === 1 ? "" : "s"}. Click anyone to see their profile.`;
     list.innerHTML = rows.map(renderMember).join(""); const searchWrap = document.getElementById("members-search-wrap"); const searchInput = document.getElementById("members-search"); const searchCount = document.getElementById("members-search-count"); if (searchWrap && searchInput) { searchWrap.style.display = ""; searchInput.addEventListener("input", () => { const q = searchInput.value.trim().toLowerCase(); const items = list.querySelectorAll(".fixture-item"); let shown = 0; items.forEach(item => { const name = (item.querySelector(".fixture-title") || {}).textContent || ""; const match = !q || name.toLowerCase().includes(q); item.style.display = match ? "" : "none"; if (match) shown++; }); if (searchCount) { searchCount.style.display = q ? "" : "none"; searchCount.textContent = shown === 0 ? "No members match that name." : shown + " of " + items.length + " members"; } }); }
     list.style.display = ""; if (location.hash && location.hash.indexOf("#m-") === 0) { const target = document.getElementById(location.hash.slice(1)); if (target) { const head = target.querySelector(".fixture-head"); if (head) head.click(); target.scrollIntoView({ behavior: "smooth", block: "center" }); } }

                             list.addEventListener("click", (e) => {
                                   const head = e.target.closest(".fixture-head");
                                   if (!head) return;
                                   const item = head.closest(".fixture-item");
                                   const open = head.getAttribute("aria-expanded") !== "true";
                                   head.setAttribute("aria-expanded", open ? "true" : "false");
                                   item.querySelector(".fixture-panel").hidden = !open;
                                   item.classList.toggle("is-open", open);
                             });

                             const editSelect = document.getElementById("member-edit-select");
     const editCard = document.getElementById("member-edit-card");
     if (editSelect && editCard) {
           const editName = document.getElementById("member-edit-name"); const editHandicap = document.getElementById("member-edit-handicap");
           const editBio = document.getElementById("member-edit-bio");
           const editSave = document.getElementById("member-edit-save");
           const editStatus = document.getElementById("member-edit-status");
           const { data: myMembership } = await client.from("memberships").select("role").eq("profile_id", session.user.id).maybeSingle();
           if (myMembership && myMembership.role === "committee") {
                   editCard.style.display = "";
                   editSelect.innerHTML = rows.map(r => `<option value="${escapeAttr(r.id)}">${escapeHtml(r.display_name || "Member")}</option>`).join("");
                   const fillEditFields = () => {
                             const chosen = rows.find(r => r.id === editSelect.value);
                             if (editName) editName.value = chosen && chosen.display_name ? chosen.display_name : ""; editHandicap.value = chosen && chosen.handicap != null ? chosen.handicap : "";
                             editBio.value = chosen && chosen.bio ? chosen.bio : ""; const egEdit = document.getElementById("member-edit-eg-id"); if (egEdit) { egEdit.value = ""; if (editSelect.value) client.from("profiles").select("england_golf_id").eq("id", editSelect.value).maybeSingle().then(r => { egEdit.value = (r && r.data && r.data.england_golf_id) || ""; }); }
                             editStatus.textContent = "";
                   };
                   editSelect.addEventListener("change", fillEditFields);
                   fillEditFields();
                   editSave.addEventListener("click", async () => {
                             editStatus.textContent = "Saving\u2026";
                             const handicapVal = editHandicap.value === "" ? null : Number(editHandicap.value);
                             const { error: saveError } = await client.from("profiles").update({ display_name: (editName && editName.value.trim()) || null, handicap: handicapVal, bio: editBio.value || null, england_golf_id: ((document.getElementById("member-edit-eg-id") || {}).value || "").trim() || null }).eq("id", editSelect.value);
                             if (saveError) {
                                         editStatus.textContent = "Couldn't save: " + saveError.message;
                                         return;
                             }
                             editStatus.textContent = "Saved.";
                             const { data: refreshed } = await client.rpc("member_directory");
                             if (refreshed) {
                                         list.innerHTML = refreshed.map(renderMember).join("");
                             }
                   });
           }
     }
 });

 function renderMember(m) {
     const initials = (m.display_name || "?")
       .split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase();

    const avatar = m.avatar_url
       ? `<img class="member-avatar" src="${escapeAttr(m.avatar_url)}" alt="">`
          : `<span class="member-avatar member-avatar-initials" aria-hidden="true">${escapeHtml(initials)}</span>`;

    const handicap = m.handicap != null
       ? `Handicap ${m.handicap}`
          : "Handicap not set";

    const committee = m.role === "committee"
       ? ` <span class="member-badge">Committee</span>`
          : "";

    const facts = [];
     facts.push(["Handicap", m.handicap != null ? String(m.handicap) : "Not set"]); if (m.england_golf_id) facts.push(["England Golf ID", String(m.england_golf_id)]);
     if (m.role === "committee") facts.push(["Role", "Committee member"]);
     if (m.member_since) facts.push(["Member since", formatJoined(m.member_since)]);

    const bio = m.bio
       ? `<p class="member-bio">${escapeHtml(m.bio)}</p>`
          : `<p class="small">This member hasn't written a bio yet.</p>`;

    return `
        <li class="fixture-item" id="m-${escapeAttr(m.id)}" data-member-id="${escapeAttr(m.id)}">
              <button class="fixture-head" type="button" aria-expanded="false" aria-controls="member-${escapeAttr(m.id)}">
                      ${avatar}
                              <span class="fixture-body">
                                        <span class="fixture-title">${escapeHtml(m.display_name || "Member")}${committee}</span>
                                                  <span class="venue">${escapeHtml(handicap)}</span>
                                                          </span>
                                                                  <span class="fixture-chevron" aria-hidden="true">&#9662;</span>
                                                                        </button>
                                                                              <div class="fixture-panel" id="member-${escapeAttr(m.id)}" hidden>
                                                                                      <dl class="fixture-facts">
                                                                                                ${facts.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join("")}
                                                                                                        </dl>
                                                                                                                ${bio}
                                                                                                                      </div>
                                                                                                                          </li>
                                                                                                                            `;
 }

 function formatJoined(ts) {
     const d = new Date(ts);
     if (isNaN(d)) return "";
     return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
 }

 function escapeHtml(str) {
     if (str == null) return "";
     return String(str)
       .replaceAll("&", "&amp;")
       .replaceAll("<", "&lt;")
       .replaceAll(">", "&gt;")
       .replaceAll('"', "&quot;");
 }

 function escapeAttr(str) {
     return escapeHtml(str).replaceAll("'", "&#39;");
 }
})();
