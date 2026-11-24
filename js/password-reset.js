// ------------------------------------------------------------------
// Forgotten password, by emailed code.
//
// One widget shared by every sign-in screen (My Account, the committee
// admin, the newsletter admin and the scoring app):
//
//   1. They type their email and we ask Supabase to send a recovery email.
//      The "Reset password" email template shows {{ .Token }}, a short
//      numeric code, rather than a link (see README.md).
//   2. They type the code and a new password. verifyOtp() swaps the code
//      for a signed-in session, and updateUser() sets the new password.
//   3. They're now signed in with the new password, and the page carries on.
//
// Like the old link-based reset, we never say whether an address has an
// account. A form that confirms "yes, that person is a member" is a way to
// find out who belongs to the society.
//
// Usage:
//   FGSReset.attach({
//     link:   <a> that opens it,
//     hide:   [elements to hide while it's open, e.g. the sign-in form],
//     mount:  element to build the widget inside,
//     client: an existing Supabase client (optional),
//     emailFrom: the sign-in email <input>, to save retyping (optional),
//     variant: "site" (default) or "app",
//     onDone: function (client) { ... } (default: reload the page)
//   });
// ------------------------------------------------------------------
(function () {
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var RESEND_SECONDS = 60;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function getClient(opts) {
    if (opts.client) return opts.client;
    if (!window.__fgsResetClient) {
      window.__fgsResetClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return window.__fgsResetClient;
  }

  // Supabase's own wording is fine for most errors, but these two come up
  // all the time and read badly.
  function friendly(err) {
    var m = (err && err.message) || "Something went wrong. Try again.";
    if (/expired|invalid|otp/i.test(m) && !/password/i.test(m)) {
      return "That code isn't right or has expired. Check the latest email, or send a new code.";
    }
    if (/security purposes|rate limit|after \d+ seconds/i.test(m)) {
      return "We've only just sent a code. Give it a minute before asking for another.";
    }
    if (/different from the old/i.test(m)) {
      return "Your new password has to be different from your old one.";
    }
    return m;
  }

  function attach(opts) {
    if (!opts || !opts.link || !opts.mount) return;
    var app = opts.variant === "app";
    var hide = (opts.hide || []).filter(Boolean);
    var state = { email: "", verified: false, timer: null };

    // Markup differs only in the class names each stylesheet expects.
    function field(id, label, type, extra) {
      var input = '<input id="' + id + '" type="' + type + '" ' + (extra || "") + ">";
      return app
        ? '<label class="field" for="' + id + '">' + label + input + "</label>"
        : '<div class="form-field"><label for="' + id + '">' + label + "</label>" + input + "</div>";
    }
    var primary = app ? "btn block" : "btn btn-brass";
    var secondary = app ? "btn ghost block" : "btn btn-outline";
    var gap = app ? "margin-top:10px;" : "margin-left:8px;";

    function setStatus(msg, kind) {
      var el = opts.mount.querySelector(".fgs-reset-status");
      if (!el) return;
      el.hidden = !msg;
      el.style.display = msg ? "" : "none";
      el.className = "fgs-reset-status status-msg" + (kind ? " " + kind : "");
      el.textContent = msg || "";
    }

    function close() {
      clearInterval(state.timer);
      opts.mount.innerHTML = "";
      opts.mount.style.display = "none";
      hide.forEach(function (el) { el.style.display = ""; });
      opts.link.style.display = "";
    }

    function open() {
      hide.forEach(function (el) { el.style.display = "none"; });
      opts.link.style.display = "none";
      opts.mount.style.display = "";
      var typed = opts.emailFrom && opts.emailFrom.value ? opts.emailFrom.value.trim() : state.email;
      renderEmailStep(typed);
    }

    // ---------- step 1: which account ----------
    function renderEmailStep(prefill) {
      state.verified = false;
      opts.mount.innerHTML =
        (app ? "<h1>Reset your password</h1>" : "<h3>Reset your password</h3>") +
        '<p class="small' + (app ? " muted" : "") + '">Enter the email address you signed up with and we\'ll email you a code to set a new password.</p>' +
        '<form class="fgs-reset-email" novalidate>' +
          field("fgs-reset-email", "Email address", "email", 'autocomplete="email" required') +
          '<button class="' + primary + '" type="submit">Email me a code</button>' +
          '<button class="' + secondary + ' fgs-reset-cancel" type="button" style="' + gap + '">Back to sign in</button>' +
        "</form>" +
        '<div class="fgs-reset-status status-msg" style="display:none;margin-top:14px;" hidden></div>';

      var input = opts.mount.querySelector("#fgs-reset-email");
      input.value = prefill || "";
      opts.mount.querySelector(".fgs-reset-cancel").addEventListener("click", close);
      opts.mount.querySelector(".fgs-reset-email").addEventListener("submit", function (e) {
        e.preventDefault();
        sendCode(input.value.trim(), e.submitter || opts.mount.querySelector("button[type=submit]"));
      });
      input.focus();
    }

    async function sendCode(email, btn) {
      if (!EMAIL_RE.test(email)) { setStatus("Enter a valid email address.", "err"); return; }
      if (btn) btn.disabled = true;
      setStatus("Sending…");
      var res = await getClient(opts).auth.resetPasswordForEmail(email);
      if (btn) btn.disabled = false;
      if (res.error) { setStatus(friendly(res.error), "err"); return false; }
      state.email = email;
      renderCodeStep();
      return true;
    }

    // ---------- step 2: code and new password ----------
    function renderCodeStep() {
      opts.mount.innerHTML =
        (app ? "<h1>Check your email</h1>" : "<h3>Check your email</h3>") +
        '<p class="small' + (app ? " muted" : "") + '">If <strong>' + esc(state.email) + "</strong> has an account, we've emailed it a code. " +
          "It can take a minute to arrive, so check your spam folder too. The code works once and expires after an hour.</p>" +
        '<form class="fgs-reset-code" novalidate>' +
          field("fgs-reset-token", "Code from the email", "text",
            'inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" required style="letter-spacing:.2em;font-size:1.2rem;"') +
          field("fgs-reset-pw", "New password", "password", 'autocomplete="new-password" minlength="6" required') +
          field("fgs-reset-pw2", "Confirm new password", "password", 'autocomplete="new-password" minlength="6" required') +
          '<button class="' + primary + '" type="submit">Set new password</button>' +
          '<button class="' + secondary + ' fgs-reset-cancel" type="button" style="' + gap + '">Cancel</button>' +
        "</form>" +
        '<p class="small" style="margin-top:12px;">' +
          '<a href="#" class="fgs-reset-resend">Send a new code</a> &middot; ' +
          '<a href="#" class="fgs-reset-change">Use a different email</a>' +
        "</p>" +
        '<div class="fgs-reset-status status-msg" style="display:none;margin-top:14px;" hidden></div>';

      var token = opts.mount.querySelector("#fgs-reset-token");
      token.addEventListener("input", function () { token.value = token.value.replace(/\D/g, ""); });
      opts.mount.querySelector(".fgs-reset-cancel").addEventListener("click", close);
      opts.mount.querySelector(".fgs-reset-change").addEventListener("click", function (e) {
        e.preventDefault(); clearInterval(state.timer); renderEmailStep(state.email);
      });
      wireResend(opts.mount.querySelector(".fgs-reset-resend"));
      opts.mount.querySelector(".fgs-reset-code").addEventListener("submit", function (e) {
        e.preventDefault();
        submitCode(opts.mount.querySelector(".fgs-reset-code button[type=submit]"));
      });
      token.focus();
    }

    function wireResend(a) {
      var left = RESEND_SECONDS;
      function tick() {
        if (left > 0) { a.textContent = "Send a new code (" + left + "s)"; a.style.pointerEvents = "none"; a.style.opacity = ".55"; }
        else { a.textContent = "Send a new code"; a.style.pointerEvents = ""; a.style.opacity = ""; clearInterval(state.timer); }
        left--;
      }
      clearInterval(state.timer);
      tick();
      state.timer = setInterval(tick, 1000);
      a.addEventListener("click", async function (e) {
        e.preventDefault();
        setStatus("Sending a new code…");
        var res = await getClient(opts).auth.resetPasswordForEmail(state.email);
        if (res.error) { setStatus(friendly(res.error), "err"); return; }
        setStatus("New code sent. Use the one in the latest email.", "ok");
        left = RESEND_SECONDS; clearInterval(state.timer); tick(); state.timer = setInterval(tick, 1000);
      });
    }

    async function submitCode(btn) {
      var client = getClient(opts);
      var code = opts.mount.querySelector("#fgs-reset-token").value.trim();
      var pw = opts.mount.querySelector("#fgs-reset-pw").value;
      var pw2 = opts.mount.querySelector("#fgs-reset-pw2").value;

      if (!state.verified && !/^\d{6,10}$/.test(code)) { setStatus("Enter the code from the email.", "err"); return; }
      if (pw.length < 6) { setStatus("Your new password needs to be at least six characters.", "err"); return; }
      if (pw !== pw2) { setStatus("Those two passwords don't match.", "err"); return; }

      btn.disabled = true;
      setStatus("Checking your code…");

      // Once the code has been accepted it's used up, so if the password
      // itself is then refused (too weak, same as before) they can try
      // another without needing a fresh code.
      if (!state.verified) {
        var v = await client.auth.verifyOtp({ email: state.email, token: code, type: "recovery" });
        if (v.error) { btn.disabled = false; setStatus(friendly(v.error), "err"); return; }
        state.verified = true;
        var tokenField = opts.mount.querySelector("#fgs-reset-token");
        tokenField.disabled = true;
      }

      setStatus("Saving your new password…");
      var u = await client.auth.updateUser({ password: pw });
      btn.disabled = false;
      if (u.error) { setStatus(friendly(u.error), "err"); return; }

      clearInterval(state.timer);
      opts.mount.innerHTML =
        (app ? "<h1>Password changed</h1>" : "<h3>Password changed</h3>") +
        '<div class="status-msg ok">All done. You\'re now signed in with your new password.</div>';
      setTimeout(function () {
        if (typeof opts.onDone === "function") opts.onDone(client);
        else window.location.reload();
      }, 1200);
    }

    opts.mount.style.display = "none";
    opts.link.addEventListener("click", function (e) { e.preventDefault(); open(); });
    return { open: open, close: close };
  }

  window.FGSReset = { attach: attach };
})();
