// ------------------------------------------------------------------
// Shared across every page: shows "Login" when signed out and
// "Logout" when signed in, only shows the "My Profile" nav link once
// the person is actually logged in, and turns the nav into a burger
// menu on small screens.
// ------------------------------------------------------------------

// Builds the burger button in JS rather than putting it in every page's
// markup, so the nav stays in one place and can't drift between pages.
function setupMobileNav() {
  const wrap = document.querySelector(".nav-wrap");
  const nav = wrap && wrap.querySelector(".main-nav");
  if (!wrap || !nav || wrap.querySelector(".nav-toggle")) return;

  if (!nav.id) nav.id = "main-nav";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "nav-toggle";
  btn.setAttribute("aria-label", "Menu");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", nav.id);
  btn.innerHTML = '<span class="nav-toggle-bars" aria-hidden="true"></span>';

  function setOpen(open) {
    wrap.classList.toggle("is-nav-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  btn.addEventListener("click", () => setOpen(!wrap.classList.contains("is-nav-open")));

  // Tapping a link should close the menu, or the next page loads with it open.
  nav.addEventListener("click", (e) => { if (e.target.closest("a")) setOpen(false); });

  // Escape closes it, and returns focus to the button.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && wrap.classList.contains("is-nav-open")) { setOpen(false); btn.focus(); }
  });

  wrap.insertBefore(btn, nav);
}

function initChrome() { setupMobileNav(); setupSocialLinks(); }

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initChrome);
} else {
  initChrome();
}

(async function () {
    const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const profileLink = document.getElementById("nav-my-profile");
    const authBtn = document.getElementById("nav-auth-btn");

   function showLoggedOut() {
         if (profileLink) profileLink.style.display = "none";
         if (authBtn) {
                 authBtn.textContent = "Login";
                 authBtn.setAttribute("href", "member.html");
                 authBtn.onclick = null;
         }
   }

   function showLoggedIn() {
         if (profileLink) profileLink.style.display = "";
         if (authBtn) {
                 authBtn.textContent = "Logout";
                 authBtn.setAttribute("href", "#");
                 authBtn.onclick = async function (e) {
                           e.preventDefault();
                           await client.auth.signOut();
                           window.location.href = "index.html";
                 };
         }
   }

   const { data: { session } } = await client.auth.getSession();
    session ? showLoggedIn() : showLoggedOut();

   client.auth.onAuthStateChange((_event, newSession) => {
         newSession ? showLoggedIn() : showLoggedOut();
   });
})();

// ------------------------------------------------------------------
// Social links. Injected rather than repeated in every page's markup,
// so the addresses only ever live in one place.
// ------------------------------------------------------------------
const SOCIAL = [
  { name: "Facebook",  url: "https://www.facebook.com/profile.php?id=61592532491330", path: "M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z" },
  { name: "Instagram", url: "https://www.instagram.com/thefalknersarmsgolfsociety/",  path: "M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" }
];

function socialMarkup(extraClass) {
  return '<div class="social-links ' + extraClass + '">' + SOCIAL.map(s =>
    '<a href="' + s.url + '" target="_blank" rel="noopener" aria-label="' + s.name + '" title="' + s.name + '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="' + s.path + '"/></svg>' +
    '</a>').join("") + '</div>';
}

function setupSocialLinks() {
  const wrap = document.querySelector(".nav-wrap");
  if (wrap && !wrap.querySelector(".social-links")) {
    const nav = wrap.querySelector(".main-nav");
    const html = socialMarkup("social-header");
    if (nav) nav.insertAdjacentHTML("afterend", html);
    else wrap.insertAdjacentHTML("beforeend", html);
  }

  const footer = document.querySelector(".site-footer .footer-inner");
  if (footer && !footer.querySelector(".social-links")) {
    footer.insertAdjacentHTML("beforeend", socialMarkup("social-footer"));
  }
}
