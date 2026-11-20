// ------------------------------------------------------------------
// Meal choices on a fixture (e.g. the Christmas meal after Round 9).
//
// Shows on any round the committee has put a menu on. Players in the
// round choose their own meal until it closes; the committee can choose
// for anyone in the round at any time. Every signed-in member sees who's
// having what, with totals for the kitchen.
//
// Used by fixtures.js: renderMeals(client, eventId, ctx) where ctx has
// { user, approved, committee }.
// ------------------------------------------------------------------

(function () {
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function niceClose(iso) {
    try {
      return new Date(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" });
    } catch (e) { return ""; }
  }

  // "Sticky toffee pudding with custard"
  function describe(menu, row, key) {
    if (!row || row.not_eating || !row.choices) return "";
    const v = row.choices[key];
    if (!v) return "";
    const extra = row.choices[key + "_extra"];
    return extra ? `${v} with ${extra.toLowerCase()}` : v;
  }

  function totals(menu, board) {
    const parts = [];
    menu.courses.forEach(c => {
      c.options.forEach(o => {
        const having = board.filter(b => !b.not_eating && b.choices && b.choices[c.key] === o.name);
        if (!having.length) { parts.push(`<span class="meal-total"><b>0</b> ${esc(o.name)}</span>`); return; }
        let extra = "";
        if (o.extras && o.extras.length) {
          extra = " (" + o.extras.map(x => `${having.filter(b => b.choices[c.key + "_extra"] === x).length} ${esc(x.toLowerCase())}`).join(", ") + ")";
        }
        parts.push(`<span class="meal-total"><b>${having.length}</b> ${esc(o.name)}${extra}</span>`);
      });
    });
    const out = board.filter(b => b.not_eating).length;
    const waiting = board.filter(b => !b.not_eating && !b.choices).length;
    if (out) parts.push(`<span class="meal-total"><b>${out}</b> not eating</span>`);
    parts.push(`<span class="meal-total meal-total-wait"><b>${waiting}</b> still to choose</span>`);
    return parts.join("");
  }

  function form(menu, who, row, canSave) {
    const radios = menu.courses.map(c => {
      const picked = row && row.choices ? row.choices[c.key] : "";
      const opts = c.options.map(o => {
        const extras = (o.extras || []).length
          ? `<span class="meal-extras" data-extras-for="${esc(c.key)}" data-option="${esc(o.name)}" ${picked === o.name ? "" : "hidden"}>
              ${o.extras.map(x => `<label class="meal-chip"><input type="radio" name="${esc(c.key)}_extra" value="${esc(x)}" ${row && row.choices && row.choices[c.key + "_extra"] === x ? "checked" : ""}> with ${esc(x.toLowerCase())}</label>`).join("")}
            </span>` : "";
        return `<label class="meal-option"><input type="radio" name="${esc(c.key)}" value="${esc(o.name)}" ${picked === o.name ? "checked" : ""}>
          <span>${esc(o.name)}${o.note ? ` <em class="meal-note">${esc(o.note)}</em>` : ""}</span></label>${extras}`;
      }).join("");
      return `<fieldset class="meal-course"><legend>${esc(c.label)}</legend>${opts}</fieldset>`;
    }).join("");
    return `
      <form class="meal-form" data-player="${esc(who.player_id)}">
        <p class="small meal-for">${who.mine ? "Your meal" : `Choosing for <b>${esc(who.name)}</b>`}</p>
        ${radios}
        <label class="meal-option meal-out"><input type="checkbox" name="not_eating" ${row && row.not_eating ? "checked" : ""}> <span>${who.mine ? "I'm" : "They're"} not having the meal</span></label>
        <div class="meal-actions">
          <button class="btn btn-brass" type="submit" ${canSave ? "" : "disabled"}>${row && (row.choices || row.not_eating) ? "Update choice" : "Save my choice"}</button>
          ${who.mine ? "" : `<button class="btn btn-ghost meal-cancel" type="button">Cancel</button>`}
        </div>
        <p class="small meal-msg" role="status"></p>
      </form>`;
  }

  window.renderMeals = async function (client, eventId, ctx) {
    const slot = document.querySelector(`[data-meal-for="${eventId}"]`);
    if (!slot) return;
    const { data: menu } = await client.from("event_menus").select("*").eq("event_id", eventId).maybeSingle();
    if (!menu) { slot.innerHTML = ""; return; }
    const closed = menu.closes_at && new Date() > new Date(menu.closes_at);
    const head = `<div class="fixture-section-label">${esc(menu.title || "Meal choices")}</div>
      <p class="small meal-closes">${closed ? "Choices have closed." : menu.closes_at ? `Choose by ${esc(niceClose(menu.closes_at))}.` : ""}</p>`;

    if (!ctx.user || !ctx.approved) {
      slot.innerHTML = `<div class="meal-box">${head}<p class="small"><a href="member.html?event=${eventId}">Sign in</a> to choose your meal and see who's having what.</p></div>`;
      return;
    }

    const { data: board, error } = await client.rpc("meal_board", { p_event: eventId });
    if (error) { slot.innerHTML = `<div class="meal-box">${head}<p class="small">Couldn't load the meal choices just now.</p></div>`; return; }
    const rows = board || [];
    const me = rows.find(b => b.mine);
    let editing = me || null;

    function draw() {
      const canSave = editing && (!closed || ctx.committee);
      const formHtml = editing
        ? (closed && !ctx.committee
          ? `<p class="small">${me && (me.choices || me.not_eating) ? `You chose: <b>${esc(me.not_eating ? "not having the meal" : menu.courses.map(c => describe(menu, me, c.key)).join(", then "))}</b>.` : "You didn't choose a meal."} Ask the committee if you need to change it.</p>`
          : form(menu, editing, editing, canSave))
        : `<p class="small">Only players in this round choose a meal.${ctx.committee ? " Tap a name below to choose for them." : ""}</p>`;
      const list = rows.map(b => {
        const meal = b.not_eating ? `<span class="muted">Not eating</span>`
          : b.choices ? menu.courses.map(c => esc(describe(menu, b, c.key))).join(" · ")
          : `<span class="muted">Not chosen yet</span>`;
        const edit = ctx.committee ? `<button class="meal-edit" type="button" data-player="${esc(b.player_id)}">Change</button>` : "";
        return `<li class="${b.mine ? "is-me" : ""}"><span class="meal-name">${esc(b.name)}</span><span class="meal-pick">${meal}</span>${edit}</li>`;
      }).join("");
      slot.innerHTML = `<div class="meal-box">${head}
        ${formHtml}
        <div class="meal-totals">${totals(menu, rows)}</div>
        <ul class="meal-list">${list}</ul></div>`;
      wire();
    }

    function wire() {
      const f = slot.querySelector(".meal-form");
      slot.querySelectorAll(".meal-edit").forEach(b => b.addEventListener("click", () => {
        editing = rows.find(r => r.player_id === b.dataset.player) || null;
        draw();
        const nf = slot.querySelector(".meal-form");
        if (nf) nf.scrollIntoView({ behavior: "smooth", block: "center" });
      }));
      if (!f) return;
      const cancel = f.querySelector(".meal-cancel");
      if (cancel) cancel.addEventListener("click", () => { editing = me || null; draw(); });
      // Extras only show for the option that has them.
      f.addEventListener("change", (e) => {
        if (e.target.type === "radio" && !e.target.name.endsWith("_extra")) {
          f.querySelectorAll(`[data-extras-for="${e.target.name}"]`).forEach(x => { x.hidden = x.dataset.option !== e.target.value; });
        }
        const out = f.querySelector("[name=not_eating]").checked;
        f.querySelectorAll(".meal-course").forEach(fs => { fs.disabled = out; fs.classList.toggle("is-off", out); });
      });
      const out0 = f.querySelector("[name=not_eating]").checked;
      f.querySelectorAll(".meal-course").forEach(fs => { fs.disabled = out0; fs.classList.toggle("is-off", out0); });
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const msg = f.querySelector(".meal-msg");
        const btn = f.querySelector("button[type=submit]");
        const notEating = f.querySelector("[name=not_eating]").checked;
        const choices = {};
        menu.courses.forEach(c => {
          const v = f.querySelector(`[name="${c.key}"]:checked`);
          if (v) choices[c.key] = v.value;
          const x = f.querySelector(`[data-extras-for="${c.key}"]:not([hidden]) [name="${c.key}_extra"]:checked`);
          if (x) choices[c.key + "_extra"] = x.value;
        });
        btn.disabled = true; msg.textContent = "Saving…";
        const { data, error } = await client.rpc("set_meal_choice", { p_event: eventId, p_player: f.dataset.player, p_choices: choices, p_not_eating: notEating });
        btn.disabled = false;
        if (error) { msg.textContent = error.message; msg.classList.add("is-error"); return; }
        const row = rows.find(r => r.player_id === f.dataset.player);
        if (row) { row.choices = notEating ? null : data.choices; row.not_eating = data.not_eating; row.updated_at = data.updated_at; }
        editing = me || null;
        draw();
        const m2 = slot.querySelector(".meal-msg");
        if (m2) m2.textContent = "Saved. Thanks!";
      });
    }

    draw();
  };
})();
