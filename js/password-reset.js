// ------------------------------------------------------------------
// "Forgotten your password?" for the committee sign-in forms
// (admin.html and newsletter-admin.html). The members' sign-in on
// member.html has its own version in members.js.
//
// Usage: add data-reset-for="<form id>" and data-reset-email="<email
// input id>" to this script tag, plus data-return="admin" or
// "newsletter" so the reset page sends them back to the right login.
//
// Like the members' version, it never says whether an address has an
// account — that would let anyone check who's on the committee.
// ------------------------------------------------------------------
(function () {
  var script = document.currentScript;
  var formId = script && script.getAttribute("data-reset-for");
  var emailId = script && script.getAttribute("data-reset-email");
  var returnTo = (script && script.getAttribute("data-return")) || "member";

  function init() {
    var form = document.getElementById(formId);
    if (!form) return;

    var wrap = document.createElement("div");
    wrap.innerHTML =
      '<p class="small" style="margin-top:10px;"><a href="#" class="forgot-link">Forgotten your password?</a></p>' +
      '<div class="reset-panel" style="display:none; margin-top:14px; padding-top:14px; border-top:1px solid var(--line);">' +
        '<p class="small"><strong>Reset your password.</strong> Enter your email address and we\'ll send you a link to set a new one.</p>' +
        '<div class="form-field"><label for="cmte-reset-email">Email address</label>' +
        '<input id="cmte-reset-email" type="email" autocomplete="email"></div>' +
        '<button class="btn btn-brass" type="button" data-act="send">Send reset link</button>' +
        '<button class="btn btn-outline" type="button" data-act="cancel" style="margin-left:8px;">Cancel</button>' +
        '<div class="reset-status" style="margin-top:12px;"></div>' +
      "</div>";
    form.insertAdjacentElement("afterend", wrap);

    var link = wrap.querySelector(".forgot-link");
    var panel = wrap.querySelector(".reset-panel");
    var input = wrap.querySelector("#cmte-reset-email");
    var send = wrap.querySelector('[data-act="send"]');
    var cancel = wrap.querySelector('[data-act="cancel"]');
    var status = wrap.querySelector(".reset-status");
    var client = null;

    link.addEventListener("click", function (e) {
      e.preventDefault();
      panel.style.display = "block";
      link.style.display = "none";
      var typed = ((document.getElementById(emailId) || {}).value || "").trim();
      if (typed && !input.value) input.value = typed;
      input.focus();
    });

    cancel.addEventListener("click", function () {
      panel.style.display = "none";
      link.style.display = "";
      status.textContent = "";
      status.className = "reset-status";
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); sendReset(); }
    });
    send.addEventListener("click", sendReset);

    async function sendReset() {
      var email = (input.value || "").trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        status.textContent = "Enter a valid email address.";
        status.className = "reset-status status-msg err";
        return;
      }
      if (!client) client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

      send.disabled = true;
      status.textContent = "Sending…";
      status.className = "reset-status status-msg";

      var base = window.location.origin + window.location.pathname.replace(/[^\/]*$/, "");
      var res = await client.auth.resetPasswordForEmail(email, {
        redirectTo: base + "reset-password.html?from=" + encodeURIComponent(returnTo)
      });
      send.disabled = false;

      if (res.error) {
        status.textContent = res.error.message;
        status.className = "reset-status status-msg err";
        return;
      }
      status.textContent = "If that address has an account, a reset link is on its way. Check your inbox and spam folder.";
      status.className = "reset-status status-msg ok";
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
