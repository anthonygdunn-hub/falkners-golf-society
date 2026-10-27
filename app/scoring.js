// ------------------------------------------------------------------
// Scoring maths for the society app. No DOM, no network — just
// numbers in, numbers out, so it can be tested on its own.
//
// Holes are { hole, par, stroke_index }. A player's scores are a map
// of hole number -> { strokes, picked_up }.
// ------------------------------------------------------------------
(function (root) {
  "use strict";

  const round = n => Math.round(n);

  // WHS course handicap: Index × (Slope ÷ 113) + (Course Rating − Par),
  // rounded to the nearest whole number.
  function courseHandicap(index, slope, rating, par) {
    if (index == null || index === "") return null;
    const i = Number(index);
    if (!slope || rating == null || par == null) return round(i);
    return round(i * (Number(slope) / 113) + (Number(rating) - Number(par)));
  }

  // The handicap a player actually plays off on the day.
  //  - whs:     course handicap from the tee, then the allowance
  //  - profile: the handicap on file, then the allowance
  //  - manual:  whatever the committee typed (override)
  // An override always wins, whatever the method.
  function playingHandicap({ method, allowance, index, override, tee, par }) {
    if (override != null && override !== "") return round(Number(override));
    if (index == null || index === "") return null;
    const pct = allowance == null ? 100 : Number(allowance);
    if (method === "manual") return null;
    if (method === "profile") return round(Number(index) * pct / 100);
    const ch = courseHandicap(index, tee && tee.slope, tee && tee.course_rating, par);
    return round(ch * pct / 100);
  }

  // Shots received on a hole. Plus handicaps give shots back on the
  // easiest holes (highest stroke index first).
  function shotsOnHole(ph, si, holeCount) {
    const n = holeCount || 18;
    if (ph == null) return 0;
    if (ph >= 0) {
      return Math.floor(ph / n) + (si <= ph % n ? 1 : 0);
    }
    const back = -ph;
    return -(Math.floor(back / n) + (si > n - (back % n) ? 1 : 0));
  }

  function stablefordPoints(par, strokes, shots, pickedUp) {
    if (pickedUp || strokes == null) return 0;
    return Math.max(0, 2 + par + shots - strokes);
  }

  // Everything about one player's round so far.
  function summarise(holes, scores, ph) {
    const out = {
      thru: 0, gross: 0, net: 0, points: 0, parPlayed: 0,
      pickups: 0, complete: false, holes: {},
      front: 0, back: 0, // stableford by nine
    };
    const s = scores || {};
    holes.forEach(h => {
      const sc = s[h.hole];
      const shots = shotsOnHole(ph, h.stroke_index, holes.length);
      if (!sc || (sc.strokes == null && !sc.picked_up)) {
        out.holes[h.hole] = { shots, played: false };
        return;
      }
      const pts = stablefordPoints(h.par, sc.strokes, shots, sc.picked_up);
      out.thru++;
      out.points += pts;
      if (h.hole <= 9) out.front += pts; else out.back += pts;
      out.parPlayed += h.par;
      if (sc.picked_up) out.pickups++;
      else { out.gross += sc.strokes; out.net += sc.strokes - shots; }
      out.holes[h.hole] = {
        shots, played: true, strokes: sc.strokes, picked_up: !!sc.picked_up,
        points: pts, net: sc.picked_up ? null : sc.strokes - shots,
      };
    });
    out.complete = out.thru === holes.length && holes.length > 0;
    // Gross and net only mean something with every hole holed out.
    if (out.pickups) { out.gross = null; out.net = null; }
    out.grossToPar = out.gross == null ? null : out.gross - out.parPlayed;
    out.netToPar = out.net == null ? null : out.net - out.parPlayed;
    return out;
  }

  // Standard countback on the last 9, 6, 3 and 1 holes (by hole number,
  // which is how a society card is read).
  function countback(holes, sum, key) {
    const last = n => holes.slice(-n).reduce((t, h) => {
      const r = sum.holes[h.hole];
      if (!r || !r.played) return t;
      if (key === "points") return t + r.points;
      return t + (r.net == null ? 99 : r.net);
    }, 0);
    return [last(9), last(6), last(3), last(1)];
  }

  function compareArrays(a, b, desc) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return desc ? b[i] - a[i] : a[i] - b[i];
    }
    return 0;
  }

  function addPositions(rows, sameAs) {
    rows.forEach((r, i) => {
      if (i > 0 && sameAs(rows[i - 1], r)) { r.pos = rows[i - 1].pos; r.tied = rows[i - 1].tied = true; }
      else r.pos = i + 1;
    });
    return rows;
  }

  // players: [{ id, name, ph, scores }]
  function stablefordBoard(holes, players) {
    const rows = players.map(p => {
      const sum = summarise(holes, p.scores, p.ph);
      return { player: p, sum, cb: countback(holes, sum, "points") };
    });
    rows.sort((a, b) =>
      (b.sum.points - a.sum.points) ||
      (a.sum.complete && b.sum.complete ? compareArrays(a.cb, b.cb, true) : 0) ||
      (b.sum.thru - a.sum.thru) ||
      a.player.name.localeCompare(b.player.name));
    return addPositions(rows, (x, y) => x.sum.points === y.sum.points &&
      !(x.sum.complete && y.sum.complete && compareArrays(x.cb, y.cb, true) !== 0));
  }

  // Medal: net to par so far. Anybody who picked up is "NR" and goes last.
  function medalBoard(holes, players, gross) {
    const rows = players.map(p => {
      const sum = summarise(holes, p.scores, p.ph);
      return { player: p, sum, cb: countback(holes, sum, "net"),
               score: gross ? sum.grossToPar : sum.netToPar };
    });
    const live = rows.filter(r => r.score != null && r.sum.thru > 0);
    const rest = rows.filter(r => !(r.score != null && r.sum.thru > 0));
    live.sort((a, b) =>
      (a.score - b.score) ||
      (a.sum.complete && b.sum.complete && !gross ? compareArrays(a.cb, b.cb, false) : 0) ||
      (b.sum.thru - a.sum.thru) ||
      a.player.name.localeCompare(b.player.name));
    addPositions(live, (x, y) => x.score === y.score &&
      !(x.sum.complete && y.sum.complete && !gross && compareArrays(x.cb, y.cb, false) !== 0));
    rest.forEach(r => { r.pos = null; r.nr = r.sum.pickups > 0; });
    return live.concat(rest);
  }

  // Skins with carry-overs. A hole is only decided once everybody in the
  // skins game has a score on it; a pick-up can't win.
  function skins(holes, players, mode) {
    const net = mode !== "gross";
    const totals = new Map(players.map(p => [p.id, { player: p, skins: 0, holes: [] }]));
    const results = [];
    let carry = 0;
    let pending = false;
    holes.forEach(h => {
      if (pending || !players.length) { results.push({ hole: h.hole, status: "pending" }); return; }
      const entries = players.map(p => {
        const sc = p.scores && p.scores[h.hole];
        if (!sc || (sc.strokes == null && !sc.picked_up)) return null;
        if (sc.picked_up) return { p, score: Infinity };
        const shots = net ? shotsOnHole(p.ph, h.stroke_index, holes.length) : 0;
        return { p, score: sc.strokes - shots };
      });
      if (entries.some(e => e === null)) {
        pending = true; // stop at the first undecided hole so carries stay in order
        results.push({ hole: h.hole, status: "pending" });
        return;
      }
      const best = Math.min(...entries.map(e => e.score));
      const winners = entries.filter(e => e.score === best);
      const value = 1 + carry;
      if (best === Infinity || winners.length > 1) {
        carry = value;
        results.push({ hole: h.hole, status: "carried", value });
      } else {
        const w = totals.get(winners[0].p.id);
        w.skins += value; w.holes.push(h.hole);
        carry = 0;
        results.push({ hole: h.hole, status: "won", value, winner: winners[0].p, score: best });
      }
    });
    const board = [...totals.values()].sort((a, b) => b.skins - a.skins || a.player.name.localeCompare(b.player.name));
    return { results, board, carry };
  }

  // Pairs: both players' Stableford points added together. A player in
  // two pairs (odd turnout) counts in full for each.
  // pairs: [{ number, players: [player, player] }]
  // Ties on finished cards go to the pair's combined last 9, 6, 3, 1.
  function pairsBoard(holes, pairs) {
    const rows = pairs.map(pair => {
      const sums = pair.players.map(p => summarise(holes, p.scores, p.ph));
      const points = sums.reduce((t, s) => t + s.points, 0);
      const thru = sums.length ? Math.min(...sums.map(s => s.thru)) : 0;
      const complete = sums.length > 0 && sums.every(s => s.complete);
      const cb = [0, 0, 0, 0];
      sums.forEach(s => countback(holes, s, "points").forEach((v, i) => { cb[i] += v; }));
      return { pair, sums, points, thru, complete, cb, started: sums.some(s => s.thru > 0) };
    });
    rows.sort((a, b) =>
      (b.points - a.points) ||
      (a.complete && b.complete ? compareArrays(a.cb, b.cb, true) : 0) ||
      (b.thru - a.thru) ||
      (a.pair.number - b.pair.number));
    return addPositions(rows, (x, y) => x.points === y.points &&
      !(x.complete && y.complete && compareArrays(x.cb, y.cb, true) !== 0));
  }

  // Singles match play, net, off the difference in playing handicaps.
  function matchPlay(holes, a, b) {
    const diff = (a.ph || 0) - (b.ph || 0);
    const aGets = Math.max(0, diff), bGets = Math.max(0, -diff);
    let up = 0, played = 0, status = "AS";
    const log = [];
    for (const h of holes) {
      const sa = a.scores && a.scores[h.hole];
      const sb = b.scores && b.scores[h.hole];
      const has = s => s && (s.strokes != null || s.picked_up);
      if (!has(sa) || !has(sb)) break;
      const na = sa.picked_up ? Infinity : sa.strokes - shotsOnHole(aGets, h.stroke_index, holes.length);
      const nb = sb.picked_up ? Infinity : sb.strokes - shotsOnHole(bGets, h.stroke_index, holes.length);
      played++;
      const res = na < nb ? 1 : nb < na ? -1 : 0;
      up += res;
      log.push({ hole: h.hole, res });
      const left = holes.length - played;
      if (Math.abs(up) > left) {
        status = `${Math.abs(up)}&${left}`;
        return { up, played, finished: true, leader: up > 0 ? a : b, status, log };
      }
    }
    const left = holes.length - played;
    if (up === 0) status = left === 0 ? "Halved" : "AS";
    else status = left === 0 ? `${Math.abs(up)} up` : `${Math.abs(up)} UP`;
    return { up, played, finished: left === 0, leader: up > 0 ? a : up < 0 ? b : null, status, log };
  }

  function validateCourseHoles(holes) {
    const errors = [];
    if (holes.length !== 18) errors.push("A course needs all 18 holes.");
    const sis = holes.map(h => Number(h.stroke_index));
    const seen = new Set();
    sis.forEach((si, i) => {
      if (!(si >= 1 && si <= 18)) errors.push(`Hole ${i + 1}: stroke index must be 1–18.`);
      else if (seen.has(si)) errors.push(`Stroke index ${si} is used twice.`);
      seen.add(si);
    });
    holes.forEach((h, i) => {
      const par = Number(h.par);
      if (!(par >= 3 && par <= 6)) errors.push(`Hole ${i + 1}: par must be 3–6.`);
    });
    return errors;
  }

  const api = {
    courseHandicap, playingHandicap, shotsOnHole, stablefordPoints, summarise,
    stablefordBoard, medalBoard, skins, pairsBoard, matchPlay, validateCourseHoles,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Scoring = api;
})(typeof window !== "undefined" ? window : globalThis);
