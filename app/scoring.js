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
  // Unrounded, because WHS applies the allowance to the unrounded figure
  // and rounds once at the end. A tee missing its slope uses 113 (neutral);
  // one missing its course rating skips the rating-minus-par adjustment.
  function courseHandicapRaw(index, slope, rating, par) {
    if (index == null || index === "") return null;
    const i = Number(index);
    const s = slope ? Number(slope) : 113;
    const adj = rating != null && rating !== "" && par != null ? Number(rating) - Number(par) : 0;
    return i * (s / 113) + adj;
  }
  function courseHandicap(index, slope, rating, par) {
    const raw = courseHandicapRaw(index, slope, rating, par);
    return raw == null ? null : round(raw);
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
    const ch = courseHandicapRaw(index, tee && tee.slope, tee && tee.course_rating, par);
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

  // Ryder Cup matches. side1/side2 are arrays of { ph, scores } (scores by
  // hole: { strokes, picked_up }). Shots are taken off the lowest
  // handicap in the match. Foursomes: one ball per side, scored under the
  // side's first player, playing off half the pair's combined handicap.
  function sideHandicaps(format, side1, side2) {
    const phOf = p => (p && p.ph != null ? p.ph : 0);
    if (format === "foursome") {
      const team = side => round(side.reduce((t, p) => t + phOf(p), 0) / Math.max(1, side.length));
      // half the combined handicap = the average for a pair
      const a = round(side1.reduce((t, p) => t + phOf(p), 0) / 2), b = round(side2.reduce((t, p) => t + phOf(p), 0) / 2);
      const low = Math.min(a, b);
      return { s1: [a - low], s2: [b - low], team };
    }
    const all = side1.concat(side2).map(phOf);
    const low = Math.min.apply(null, all);
    return { s1: side1.map(p => phOf(p) - low), s2: side2.map(p => phOf(p) - low) };
  }

  function teamMatch(holes, format, side1, side2) {
    const shots = sideHandicaps(format, side1, side2);
    const has = s => s && (s.strokes != null || s.picked_up);
    const balls = (side, gets) => format === "foursome" ? [{ p: side[0], gets: gets[0] }] : side.map((p, i) => ({ p, gets: gets[i] }));
    const b1 = balls(side1, shots.s1), b2 = balls(side2, shots.s2);
    let up = 0, played = 0;
    const log = [];
    const n = holes.length;
    for (const h of holes) {
      const sc = b => b.p && b.p.scores ? b.p.scores[h.hole] : null;
      // A side's hole is in once every ball it plays has a score (or a pick-up).
      const ready = bs => bs.every(b => has(sc(b)));
      if (!ready(b1) || !ready(b2)) { log.push({ hole: h.hole, res: null }); continue; }
      const best = bs => Math.min.apply(null, bs.map(b => { const s = sc(b); return s.picked_up ? Infinity : s.strokes - shotsOnHole(b.gets, h.stroke_index, n); }));
      const x = best(b1), y = best(b2);
      const res = x < y ? 1 : y < x ? -1 : 0;
      played++; up += res;
      log.push({ hole: h.hole, res, net1: x, net2: y });
    }
    // Holes count in order: the match is decided once one side can't be caught.
    let run = 0, count = 0, decidedAt = null;
    for (const l of log) {
      if (l.res == null) break;
      run += l.res; count++;
      if (Math.abs(run) > n - count) { decidedAt = { up: run, played: count, left: n - count }; break; }
    }
    if (decidedAt) {
      return { up: decidedAt.up, played: decidedAt.played, finished: true, leader: decidedAt.up > 0 ? 1 : 2,
        status: decidedAt.left === 0 ? `${Math.abs(decidedAt.up)} up` : `${Math.abs(decidedAt.up)}&${decidedAt.left}`,
        points: decidedAt.up > 0 ? [1, 0] : [0, 1], log, shots };
    }
    const thru = (() => { let t = 0; for (const l of log) { if (l.res == null) break; t++; } return t; })();
    const upThru = log.slice(0, thru).reduce((t, l) => t + l.res, 0);
    const finished = thru === n;
    const left = n - thru;
    let status;
    if (finished) status = upThru === 0 ? "Halved" : `${Math.abs(upThru)} up`;
    else if (thru === 0) status = "Not started";
    else if (upThru === 0) status = "All square";
    else status = Math.abs(upThru) === left ? `Dormie ${Math.abs(upThru)}` : `${Math.abs(upThru)} UP`;
    return { up: upThru, played: thru, finished, leader: upThru > 0 ? 1 : upThru < 0 ? 2 : null, status,
      points: finished ? (upThru > 0 ? [1, 0] : upThru < 0 ? [0, 1] : [0.5, 0.5]) : null, log, shots };
  }

  // ---------- World Handicap System, for the society's own index ----------
  // Adjusted gross: each hole capped at net double bogey (par + 2 + shots
  // from the full course handicap); a pick-up or a missing hole counts as
  // net double bogey too.
  function adjustedGross(holes, scores, courseHcp) {
    const s = scores || {};
    let total = 0, counted = 0;
    holes.forEach(h => {
      const cap = h.par + 2 + shotsOnHole(courseHcp, h.stroke_index, holes.length);
      const sc = s[h.hole];
      if (!sc || sc.picked_up || sc.strokes == null) { total += cap; return; }
      counted++;
      total += Math.min(sc.strokes, cap);
    });
    return { ags: total, holesPlayed: counted };
  }

  // Score differential = (113 / slope) x (adjusted gross - course rating), to 1dp.
  function differential(ags, slope, rating) {
    return Math.round((113 / slope) * (ags - rating) * 10) / 10;
  }

  // Index from up to the last 20 differentials (oldest first), WHS table.
  function whsIndex(diffs) {
    const last = diffs.slice(-20);
    const n = last.length;
    if (n < 3) return null;
    const sorted = last.slice().sort((a, b) => a - b);
    const rule = n <= 3 ? [1, -2] : n === 4 ? [1, -1] : n === 5 ? [1, 0] : n === 6 ? [2, -1] : n <= 8 ? [2, 0]
      : n <= 11 ? [3, 0] : n <= 14 ? [4, 0] : n <= 16 ? [5, 0] : n <= 18 ? [6, 0] : n === 19 ? [7, 0] : [8, 0];
    const best = sorted.slice(0, rule[0]);
    const avg = best.reduce((a, b) => a + b, 0) / best.length + rule[1];
    return { index: Math.min(54, Math.round(avg * 10) / 10), used: rule[0], of: n, adjust: rule[1] };
  }

  // A round typed in as Stableford points (no card): each hole is worth
  // 2 + par + shots - strokes, and a blob is the same as net double bogey,
  // so the capped gross is par + playing handicap + 36 - points. The cap
  // is on the shots actually received, slightly stricter than WHS's.
  function pointsGross(points, ph, par) {
    if (points == null || ph == null || par == null) return null;
    return Number(par) + Number(ph) + 36 - Number(points);
  }

  // The society index after a round.
  //  old:   index going into the round (before any temporary cut)
  //  diffs: every differential so far, oldest first, this round's last
  //  diff:  this round's differential (null if the card didn't count)
  //  free:  true for a provisional handicap - no 2.0 cap
  // Exceptional scores (7+ better than the index) come off as WHS does.
  // Until a player has 20 cards no index moves more than 2.0 in a round.
  const HC_STEP = 2;
  function societyIndex(o) {
    const whs = whsIndex(o.diffs);
    const gap = o.diff != null && o.old != null ? o.old - o.diff : 0;
    const esr = gap >= 10 ? 2 : gap >= 7 ? 1 : 0;
    let next = whs ? whs.index - esr : o.old == null ? null : o.old - esr;
    let capped = null;
    if (next != null && o.old != null && !o.free && o.diffs.length < 20 && Math.abs(next - o.old) > HC_STEP) {
      capped = Math.round(next * 10) / 10;
      next = next < o.old ? o.old - HC_STEP : o.old + HC_STEP;
    }
    return { next: next == null ? null : Math.max(-10, Math.min(54, Math.round(next * 10) / 10)), whs, esr, capped };
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

  // ---------- team formats and match play ----------
  // England Golf's recommended allowances (WHS Appendix C). The
  // organiser can change any of them for their game.
  const ALLOWANCES = {
    betterball: 85,        // four-ball better ball, Stableford or stroke play
    singles_match: 100,    // singles match play, off the difference
    fourball_match: 90,    // four-ball match play, off the lowest
    foursomes: 50,         // of the pair's combined handicap
    greensomes: [60, 40],  // lower handicap, higher handicap
    scramble2: [35, 15],
    scramble3: [30, 20, 10],
    scramble4: [25, 20, 15, 10],
  };
  function allowanceFor(key, overrides) {
    const o = overrides && overrides[key];
    return o != null ? o : ALLOWANCES[key];
  }

  // One handicap for a team playing one ball, from each player's full
  // course handicap (unrounded). Rounded once, at the end.
  //   scramble:   lowest handicap x the first %, next x the second, ...
  //   foursomes:  % of the combined handicaps
  //   greensomes: lower x 60% + higher x 40%
  function teamHandicap(format, full, overrides) {
    const hs = full.filter(x => x != null).map(Number).sort((a, b) => a - b);
    if (!hs.length) return null;
    if (format === "foursomes") return round(hs.reduce((t, x) => t + x, 0) * allowanceFor("foursomes", overrides) / 100);
    const pcts = format === "greensomes" ? allowanceFor("greensomes", overrides)
      : allowanceFor("scramble" + Math.min(4, Math.max(2, hs.length)), overrides);
    return round(hs.reduce((t, x, i) => t + x * (Number(pcts[i] != null ? pcts[i] : 0)) / 100, 0));
  }

  // Better ball: each hole, the better of the pair's two scores counts.
  // Stableford: the most points. Medal: the lowest net; the hole is lost
  // (NR) only if both pick up. players carry the better-ball handicap.
  // A hole counts once both partners have scored it.
  function betterBallBoard(holes, pairs, mode) {
    const medal = mode === "medal";
    const rows = pairs.map(pair => {
      const sums = pair.players.map(p => summarise(holes, p.scores, p.ph));
      let points = 0, net = 0, parPlayed = 0, thru = 0, nr = false;
      const perHole = {};
      for (const h of holes) {
        const xs = sums.map(s => s.holes[h.hole]);
        if (!xs.length || xs.some(x => !x.played)) continue;
        thru++; parPlayed += h.par;
        const pts = Math.max(...xs.map(x => x.points));
        const nets = xs.filter(x => !x.picked_up).map(x => x.net);
        points += pts;
        if (nets.length) net += Math.min(...nets); else nr = true;
        perHole[h.hole] = { points: pts, net: nets.length ? Math.min(...nets) : null };
      }
      const complete = pair.players.length === 2 && thru === holes.length;
      // countback on the better-ball points over the last 9, 6, 3, 1
      const cb = [9, 6, 3, 1].map(n => holes.slice(-n).reduce((t, h) => t + (perHole[h.hole] ? (medal ? (perHole[h.hole].net ?? 99) : perHole[h.hole].points) : 0), 0));
      return { pair, sums, points, net: nr ? null : net, toPar: nr ? null : net - parPlayed, thru, complete, cb, perHole, nr, started: thru > 0 };
    });
    rows.sort((a, b) => {
      if (medal) {
        const av = a.started && !a.nr, bv = b.started && !b.nr;
        if (av !== bv) return av ? -1 : 1;
        if (av && a.toPar !== b.toPar) return a.toPar - b.toPar;
        if (a.complete && b.complete) { const c = compareArrays(a.cb, b.cb, false); if (c) return c; }
      } else {
        if (b.points !== a.points) return b.points - a.points;
        if (a.complete && b.complete) { const c = compareArrays(a.cb, b.cb, true); if (c) return c; }
      }
      return (b.thru - a.thru) || (a.pair.number - b.pair.number);
    });
    return addPositions(rows, (x, y) => medal
      ? x.started && !x.nr && y.started && !y.nr && x.toPar === y.toPar && !(x.complete && y.complete && compareArrays(x.cb, y.cb, false) !== 0)
      : x.points === y.points && !(x.complete && y.complete && compareArrays(x.cb, y.cb, true) !== 0));
  }

  // ---------- side games over the whole round ----------
  //   twos:    holes in 2 strokes (gross)
  //   birdies: gross birdie or better (an eagle counts once)
  //   putts:   fewest putts; only players with putts on every hole played
  //   front9 / back9: Stableford points on that nine
  // stats: Map of "playerId:hole" -> { putts }. Returns every player's
  // value, the leaders (ties share), and whether it's settled (every
  // card finished).
  function sideGame(kind, holes, players, stats) {
    const nine = kind === "front9" ? holes.slice(0, 9) : kind === "back9" ? holes.slice(9, 18) : holes;
    const rows = players.map(p => {
      const sum = summarise(holes, p.scores, p.ph);
      let value = 0, counted = 0, ok = true;
      for (const h of nine) {
        const x = sum.holes[h.hole];
        if (!x || !x.played) continue;
        counted++;
        if (kind === "twos") value += !x.picked_up && x.strokes === 2 ? 1 : 0;
        else if (kind === "birdies") value += !x.picked_up && x.strokes < h.par ? 1 : 0;
        else if (kind === "putts") { const st = stats && stats.get(p.id + ":" + h.hole); if (!st || st.putts == null) ok = false; else value += Number(st.putts); }
        else value += x.points;
      }
      const done = kind === "front9" || kind === "back9" ? nine.every(h => sum.holes[h.hole] && sum.holes[h.hole].played) : sum.complete;
      return { player: p, value, counted, eligible: kind === "putts" ? ok && counted > 0 : true, done };
    });
    const low = kind === "putts";
    const live = rows.filter(x => x.eligible && x.counted > 0);
    live.sort((a, b) => (low ? a.value - b.value : b.value - a.value) || a.player.name.localeCompare(b.player.name));
    const rest = rows.filter(x => !(x.eligible && x.counted > 0));
    // Counts of 2s and birdies need at least one to win anything.
    const best = live.length && (low || live[0].value > 0) ? live[0].value : null;
    const leaders = best == null ? [] : live.filter(x => x.value === best);
    const settled = rows.length > 0 && rows.every(x => x.done);
    // fewest putts: a card without every putt can't win once it's in
    const winners = settled ? leaders.filter(x => kind !== "putts" || x.done) : [];
    return { rows: live.concat(rest), leaders, winners, settled, best };
  }

  // ---------- settling up ----------
  // pots: [{ label, stake, entrants: [id], winners: [{ id, share }] }]
  //   each entrant puts in the stake; the pot is shared by the winners
  //   (share is a weight: 1 each for a tie, skins won for skins). A pot
  //   with no winners is left out: nobody pays.
  // matches: [{ label, stake, won: [id], lost: [id] }]: each losing
  //   player pays the stake, shared between the winners. A half is nothing.
  // Returns each person's net (+ up, - down) and the fewest payments
  // that settle it, biggest first. Amounts are in pence to avoid rounding.
  function settleUp(pots, matches) {
    const net = new Map();
    const add = (id, p) => net.set(id, (net.get(id) || 0) + p);
    const lines = [];
    (pots || []).forEach(pot => {
      const stake = Math.round(Number(pot.stake || 0) * 100);
      const ws = (pot.winners || []).filter(w => w.share > 0);
      if (!stake || !ws.length || !pot.entrants.length) return;
      const total = stake * pot.entrants.length;
      const weight = ws.reduce((t, w) => t + w.share, 0);
      pot.entrants.forEach(id => add(id, -stake));
      // share the pot in whole pence; any odd pence go to the first winners
      let given = 0;
      const shares = ws.map(w => { const v = Math.floor(total * w.share / weight); given += v; return { id: w.id, v }; });
      for (let i = 0; given < total; i = (i + 1) % shares.length) { shares[i].v++; given++; }
      shares.forEach(s => add(s.id, s.v));
      lines.push({ label: pot.label, total, winners: shares });
    });
    (matches || []).forEach(m => {
      const stake = Math.round(Number(m.stake || 0) * 100);
      if (!stake || !m.won || !m.won.length || !m.lost.length) return;
      const total = stake * m.lost.length;
      m.lost.forEach(id => add(id, -stake));
      let given = 0;
      const shares = m.won.map(id => { const v = Math.floor(total / m.won.length); given += v; return { id, v }; });
      for (let i = 0; given < total; i = (i + 1) % shares.length) { shares[i].v++; given++; }
      shares.forEach(s => add(s.id, s.v));
      lines.push({ label: m.label, total, winners: shares });
    });
    const owe = [...net.entries()].filter(([, v]) => v < 0).map(([id, v]) => ({ id, v: -v })).sort((a, b) => b.v - a.v);
    const get = [...net.entries()].filter(([, v]) => v > 0).map(([id, v]) => ({ id, v })).sort((a, b) => b.v - a.v);
    const pays = [];
    let i = 0, j = 0;
    while (i < owe.length && j < get.length) {
      const x = Math.min(owe[i].v, get[j].v);
      pays.push({ from: owe[i].id, to: get[j].id, pence: x });
      owe[i].v -= x; get[j].v -= x;
      if (!owe[i].v) i++;
      if (!get[j].v) j++;
    }
    return { net, pays, lines };
  }

  const api = {
    ALLOWANCES, allowanceFor, teamHandicap, betterBallBoard, sideGame, settleUp,
    courseHandicap, courseHandicapRaw, playingHandicap, shotsOnHole, stablefordPoints, summarise,
    stablefordBoard, medalBoard, skins, pairsBoard, matchPlay, teamMatch, sideHandicaps, adjustedGross, differential, whsIndex, pointsGross, societyIndex, HC_STEP, validateCourseHoles,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Scoring = api;
})(typeof window !== "undefined" ? window : globalThis);
