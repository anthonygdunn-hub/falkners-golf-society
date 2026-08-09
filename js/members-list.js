// ------------------------------------------------------------------
// Logic for members.html — the society directory.
//
// The list comes from the member_directory() database function, which
// returns nothing unless the person asking is an approved member. So
// the gate is enforced in the database, not just hidden in the page:
// there's no request a curious visitor can make to get the names.
// ------------------------------------------------------------------

let client;

document.addEventListener("DOMContentLoaded", async () => {
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const intro = document.getElementById("members-intro");
  const locked = document.getElementById("members-locked");
  const lockedMsg = document.getElementById("members-locked-msg");
  const list = document.getElementById("members-list");

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

  // An approved member always sees at least themselves, so an empty
  // result means the caller hasn't been approved yet.
  if (!rows || !rows.length) {
    showLocked("Your membership is still awaiting approval — once a committee member approves it, you'll be able to see the other members here.");
    return;
  }

  intro.textContent = `${rows.length} member${rows.length === 1 ? "" : "s"}. Click anyone to see their profile.`;
  list.innerHTML = rows.map(renderMember).join("");
  list.style.display = "";

  list.addEventListener("click", (e) => {
    const head = e.target.closest(".fixture-head");
    if (!head) return;
    const item = head.closest(".fixture-item");
    const open = head.getAttribute("aria-expanded") !== "true";
    head.setAttribute("aria-expanded", open ? "true" : "false");
    item.querySelector(".fixture-panel").hidden = !open;
    item.classList.toggle("is-open", open);
  });
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
  facts.push(["Handicap", m.handicap != null ? String(m.handicap) : "Not set"]);
  if (m.role === "committee") facts.push(["Role", "Committee member"]);
  if (m.member_since) facts.push(["Member since", formatJoined(m.member_since)]);

  const bio = m.bio
    ? `<p class="member-bio">${escapeHtml(m.bio)}</p>`
    : `<p class="small">This member hasn't written a bio yet.</p>`;

  return `
    <li class="fixture-item" data-member-id="${escapeAttr(m.id)}">
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
