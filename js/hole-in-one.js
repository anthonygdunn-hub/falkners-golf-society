// ------------------------------------------------------------------
// The rolling hole-in-one pot, shown live on hole-in-one.html.
//
// The pot isn't stored as a single number. It's the sum of a ledger:
// money in after each round, money out when somebody finally holes one.
// That way nothing is ever overwritten and the history stays readable.
// ------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  const figure = document.getElementById("pot-figure");
  const caption = document.getElementById("pot-caption");
  const history = document.getElementById("pot-history");
  if (!figure) return;

  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const { data: rows, error } = await client
    .from("hole_in_one_ledger")
    .select("id, amount, note, entry_date, events(name)")
    .order("entry_date", { ascending: false });

  if (error) {
    console.error(error);
    figure.textContent = "£—";
    caption.textContent = "The pot will show here once the committee starts logging it.";
    return;
  }

  if (!rows.length) {
    figure.textContent = "£0.00";
    caption.textContent = "Nothing in the pot yet — it starts building from the first round of the 2027 season.";
    return;
  }

  const total = rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const paidOut = rows.filter(r => Number(r.amount) < 0);

  figure.textContent = formatMoney(total);
  caption.textContent = paidOut.length
    ? `Built back up since the last winner. ${rows.length} entries logged.`
    : `Building since the first round — still nobody's holed one.`;

  history.innerHTML = `
    <h3>How the pot got here</h3>
    <ul>
      ${rows.map(r => {
        const out = Number(r.amount) < 0;
        const where = r.events?.name ? ` · ${escapeHtml(r.events.name)}` : "";
        const note = r.note ? ` — ${escapeHtml(r.note)}` : "";
        return `<li>
          <strong class="${out ? "pot-payout" : ""}">${out ? "−" : "+"}${formatMoney(Math.abs(Number(r.amount)))}</strong>
          <span class="small">${escapeHtml(longDate(r.entry_date))}${where}${note}</span>
        </li>`;
      }).join("")}
    </ul>`;
});

function formatMoney(n) {
  const value = Number(n) || 0;
  return "£" + value.toFixed(2).replace(/\.00$/, "");
}

function longDate(iso) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
