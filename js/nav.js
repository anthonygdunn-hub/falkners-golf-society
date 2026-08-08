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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupMobileNav);
} else {
  setupMobileNav();
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
