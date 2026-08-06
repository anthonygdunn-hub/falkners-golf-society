// ------------------------------------------------------------------
// Shared across every page: shows "Login" when signed out and
// "Logout" when signed in, and only shows the "My Profile" nav
// link once the person is actually logged in.
// ------------------------------------------------------------------
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
