// ------------------------------------------------------------------
// Logic for results.html — every round that's been scored, grouped by
// season and collapsed like the fixtures list.
//
// Each season starts fresh: the newest year is shown by default, with
// the earlier seasons still one click away rather than scrolled past.
// ------------------------------------------------------------------

let scoredEvents = [];
const resultsByEvent = new Map();
let selectedYear = null;

document.addEventListener("DOMContentLoaded", async () => {
  const listEl = document.getElementById("results-list");

  let events, results;
  try {
    ({ events, results } = await fetchAllData());
  } catch (err) {
    console.error(err);
    listEl.innerHTML = `<li class="empty-state">Couldn't load live data yet — has the Supabase connection been set up? See README.md.</li>`;
    return;
  }

  for (const r of results) {
    if (!resultsByEvent.has(r.event_id)) resultsByEvent.set(r.event_id, []);
    resultsByEvent.get(r.event_id).push(r);
  }

  scoredEvents = events.filter(e => resultsByEvent.has(e.id));

  if (!scoredEvents.length) {
    listEl.innerHTML = `<li class="empty-state">No results logged yet this season. Check back after the first fixture!</li>`;
    return;
  }

  const years = [...new Set(scoredEvents.map(yearOf))].sort().reverse();

  // If we arrived from a fixture's "See results" link, start on that
  // round's season rather than the newest one.
  const deepLinked = (window.location.hash || "").replace("#event-", "");
  const target = scoredEvents.find(e => e.id === deepLinked);
  selectedYear = target ? yearOf(target) : years[0];

  renderYearTabs(years);
  renderSeason();
  wireAccordion(listEl);

  if (target) openEvent(target.id, { scroll: true });

  // Following a "See results" link while already on this page only changes
  // the hash — no reload — so handle that case too.
  window.addEventListener("hashchange", jumpToHashedEvent);
});

function jumpToHashedEvent() {
  const id = (window.location.hash || "").replace("#event-", "");
  const event = scoredEvents.find(e => e.id === id);
  if (!event) return;
  if (yearOf(event) !== selectedYear) selectYear(yearOf(event));
  openEvent(event.id, { scroll: true });
}

function selectYear(year) {
  selectedYear = year;
  document.querySelectorAll(".year-tab").forEach(b => {
    const on = b.dataset.year === selectedYear;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-pressed", on);
  });
  renderSeason();
}

function yearOf(event) {
  return event.event_date.slice(0, 4);
}

function renderYearTabs(years) {
  const el = document.getElementById("year-tabs");
  if (!el) return;

  // One season only? A row of tabs with a single button is just clutter.
  if (years.length < 2) { el.innerHTML = ""; return; }

  el.innerHTML = years.map(y => `
    <button type="button" class="year-tab${y === selectedYear ? ' is-active' : ''}" data-year="${y}"
            aria-pressed="${y === selectedYear}">${y}</button>
  `).join("");

  el.addEventListener("click", (e) => {
    const btn = e.target.closest(".year-tab");
    if (!btn || btn.dataset.year === selectedYear) return;
    selectYear(btn.dataset.year);
  });
}

function renderSeason() {
  const listEl = document.getElementById("results-list");
  const meta = document.getElementById("results-meta");

  // Round order: earliest round of the season first, so Round 1 is at the top.
  const season = scoredEvents
    .filter(e => yearOf(e) === selectedYear)
    .sort((a, b) => a.event_date.localeCompare(b.event_date));

  listEl.innerHTML = season.length
    ? season.map(renderResultItem).join("")
    : `<li class="empty-state">No results logged for ${escapeHtml(selectedYear)}.</li>`;

  if (meta) {
    meta.textContent = season.length
      ? `${season.length} round${season.length === 1 ? "" : "s"} logged in ${selectedYear}`
      : "";
  }
}

function renderResultItem(event) {
  const { day, month } = shortDate(event.event_date);
  const rows = [...(resultsByEvent.get(event.id) || [])]
    .sort((a, b) => Number(b.points) - Number(a.points));
  const winner = rows[0];

  const summary = winner
    ? `Won by ${escapeHtml(winner.players?.name || "Unknown")} — ${winner.points} pts · ${rows.length} player${rows.length === 1 ? "" : "s"}`
    : "No scores recorded";

  return `
    <li class="fixture-item" id="event-${event.id}" data-event-id="${event.id}">
      <button class="fixture-head" type="button" aria-expanded="false" aria-controls="rpanel-${event.id}">
        <span class="fixture-date"><strong>${day}</strong>${month}</span>
        <span class="fixture-body">
          <span class="fixture-title">${escapeHtml(event.name)}${event.venue ? ' — ' + escapeHtml(event.venue) : ''}</span>
          <span class="venue">${summary}</span>
        </span>
        <span class="fixture-chevron" aria-hidden="true">&#9662;</span>
      </button>
      <div class="fixture-panel" id="rpanel-${event.id}" hidden>
        ${renderScoreTable(rows)}
      </div>
    </li>
  `;
}

function renderScoreTable(rows) {
  if (!rows.length) return `<p class="small">No scores recorded for this round.</p>`;
  return `
    <table class="score-table">
      <thead>
        <tr><th>Pos</th><th>Name</th><th class="num">HCap</th><th class="num">Gross</th><th class="num">Points</th></tr>
      </thead>
      <tbody>
        ${rows.map((r, i) => `
          <tr class="${i === 0 ? 'pos-1' : ''}">
            <td class="pos"><span class="pos-badge">${i + 1}</span></td>
            <td>${escapeHtml(r.players?.name || 'Unknown')}</td>
            <td class="num">${r.handicap ?? '—'}</td>
            <td class="num">${r.gross_score ?? '—'}</td>
            <td class="num">${r.points}</td>
          </tr>`).join("")}
      </tbody>
    </table>
  `;
}

function wireAccordion(listEl) {
  listEl.addEventListener("click", (e) => {
    const head = e.target.closest(".fixture-head");
    if (!head) return;
    const item = head.closest(".fixture-item");
    setOpen(item, head.getAttribute("aria-expanded") !== "true");
  });
}

function setOpen(item, open) {
  item.querySelector(".fixture-head").setAttribute("aria-expanded", open ? "true" : "false");
  item.querySelector(".fixture-panel").hidden = !open;
  item.classList.toggle("is-open", open);
}

function openEvent(eventId, opts = {}) {
  const item = document.querySelector(`.fixture-item[data-event-id="${eventId}"]`);
  if (!item) return;
  setOpen(item, true);
  if (opts.scroll) item.scrollIntoView({ behavior: "smooth", block: "center" });
}
