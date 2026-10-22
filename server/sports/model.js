// Count models for football: goals, corners and cards. Pure functions, no I/O.
// match shape: { date, comp, home, away, hg, ag, hc, ac, hk, ak }  (corners hc/ac and cards hk/ak may be null)
// One model per statistic is fitted across all competitions; European fixtures link the leagues so
// the ratings are roughly comparable between countries.

const DAY_MS = 86400000;
const DECAY_PER_DAY = 0.003; // ~230 day half-life
const PRIOR_MATCHES = 3; // pseudo-matches shrinking each team toward the average
const MIN_TEAM_WEIGHT = 4; // below this effective match weight we refuse to predict
const ITERATIONS = 15;

// Attack/defence style multiplicative model for any per-team count (rows: {home, away, hg, ag, date}).
// "att" = how many the team produces, "def" = how many it concedes/allows the opponent.
export function fitModel(matches, asOf = Date.now()) {
  const rows = [];
  for (const m of matches) {
    const t = new Date(m.date).getTime();
    const w = Math.exp(-DECAY_PER_DAY * Math.max(0, (asOf - t) / DAY_MS));
    if (w > 0.01 && t < asOf) rows.push({ home: m.home, away: m.away, hg: m.hg, ag: m.ag, w });
  }
  if (rows.length < 20) return null;

  const totalW = rows.reduce((s, m) => s + m.w, 0);
  const muH = rows.reduce((s, m) => s + m.w * m.hg, 0) / totalW;
  const muA = rows.reduce((s, m) => s + m.w * m.ag, 0) / totalW;
  if (muH <= 0 || muA <= 0) return null;
  const prior = PRIOR_MATCHES * (muH + muA) / 2;

  const teams = new Map();
  const teamW = {};
  for (const m of rows) {
    for (const t of [m.home, m.away]) {
      if (!teams.has(t)) teams.set(t, { att: 1, def: 1 });
      teamW[t] = (teamW[t] || 0) + m.w;
    }
  }

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const attNum = {}, attDen = {}, defNum = {}, defDen = {};
    for (const m of rows) {
      const h = teams.get(m.home), a = teams.get(m.away);
      attNum[m.home] = (attNum[m.home] || 0) + m.w * m.hg;
      attDen[m.home] = (attDen[m.home] || 0) + m.w * muH * a.def;
      attNum[m.away] = (attNum[m.away] || 0) + m.w * m.ag;
      attDen[m.away] = (attDen[m.away] || 0) + m.w * muA * h.def;
      defNum[m.home] = (defNum[m.home] || 0) + m.w * m.ag;
      defDen[m.home] = (defDen[m.home] || 0) + m.w * muA * a.att;
      defNum[m.away] = (defNum[m.away] || 0) + m.w * m.hg;
      defDen[m.away] = (defDen[m.away] || 0) + m.w * muH * h.att;
    }
    for (const [t, v] of teams) {
      v.att = (attNum[t] + prior) / (attDen[t] + prior);
      v.def = (defNum[t] + prior) / (defDen[t] + prior);
    }
    // keep the scale identifiable
    const meanAtt = [...teams.values()].reduce((s, v) => s + v.att, 0) / teams.size;
    const meanDef = [...teams.values()].reduce((s, v) => s + v.def, 0) / teams.size;
    for (const v of teams.values()) { v.att /= meanAtt; v.def /= meanDef; }
  }

  // Overdispersion (variance / mean), estimated from Pearson residuals. Corners and cards vary
  // more than a Poisson count would; goals are close to Poisson.
  let chiTeam = 0, chiTotal = 0;
  for (const m of rows) {
    const h = teams.get(m.home), a = teams.get(m.away);
    const lh = muH * h.att * a.def, la = muA * a.att * h.def;
    chiTeam += m.w * ((m.hg - lh) ** 2 / lh + (m.ag - la) ** 2 / la);
    chiTotal += m.w * (m.hg + m.ag - lh - la) ** 2 / (lh + la);
  }
  const dof = Math.max(1, totalW - teams.size);
  const phiTeam = Math.min(3, Math.max(1, chiTeam / (2 * dof)));
  const phiTotal = Math.min(4, Math.max(1, chiTotal / dof));
  return { muH, muA, teams, teamW, phiTeam, phiTotal };
}

function poissonPmf(lambda, max) {
  const out = [Math.exp(-lambda)];
  for (let k = 1; k <= max; k++) out.push(out[k - 1] * lambda / k);
  return out;
}

// Negative binomial with the given mean and variance = phi * mean (Poisson when phi ~ 1).
function countPmf(mean, phi, max) {
  if (phi <= 1.02) return poissonPmf(mean, max);
  const r = mean / (phi - 1);
  const q = mean / (r + mean);
  const out = [Math.pow(1 - q, r)];
  for (let k = 0; k < max; k++) out.push(out[k] * ((k + r) / (k + 1)) * q);
  return out;
}

const tailAbove = (pmf, line) => pmf.reduce((s, p, k) => s + (k > line ? p : 0), 0) / pmf.reduce((s, p) => s + p, 0);

function ready(model, home, away) {
  if (!model) return null;
  const h = model.teams.get(home), a = model.teams.get(away);
  if (!h || !a || model.teamW[home] < MIN_TEAM_WEIGHT || model.teamW[away] < MIN_TEAM_WEIGHT) return null;
  return { lamH: model.muH * h.att * a.def, lamA: model.muA * a.att * h.def };
}

const key = line => String(Math.round(line * 10));
const CORNER_LINES = [7.5, 8.5, 9.5, 10.5, 11.5, 12.5];
const CORNER_TEAM_LINES = [2.5, 3.5, 4.5, 5.5, 6.5];
const CARD_LINES = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5];
const CARD_TEAM_LINES = [0.5, 1.5, 2.5];

// Over/under probabilities for a count statistic: match total plus each team.
function countMarkets(info, model, prefix, totalLines, teamLines, out) {
  const total = info.lamH + info.lamA;
  const totalPmf = countPmf(total, model.phiTotal, 60);
  for (const line of totalLines) {
    const o = tailAbove(totalPmf, line);
    out[`${prefix}o${key(line)}`] = o; out[`${prefix}u${key(line)}`] = 1 - o;
  }
  const hp = countPmf(info.lamH, model.phiTeam, 40), ap = countPmf(info.lamA, model.phiTeam, 40);
  for (const line of teamLines) {
    const ho = tailAbove(hp, line), ao = tailAbove(ap, line);
    out[`h${prefix}o${key(line)}`] = ho; out[`h${prefix}u${key(line)}`] = 1 - ho;
    out[`a${prefix}o${key(line)}`] = ao; out[`a${prefix}u${key(line)}`] = 1 - ao;
  }
}

// Goals: independent Poisson per team gives every goals market from one score grid.
export function predict(model, home, away) {
  const info = ready(model, home, away);
  if (!info) return null;
  const { lamH, lamA } = info;
  const ph = poissonPmf(lamH, 10), pa = poissonPmf(lamA, 10);
  let home1 = 0, draw = 0, away1 = 0, btts = 0, total = 0;
  const goalsDist = new Array(ph.length + pa.length - 1).fill(0);
  const scores = [];
  for (let i = 0; i < ph.length; i++) {
    for (let j = 0; j < pa.length; j++) {
      const p = ph[i] * pa[j];
      total += p;
      goalsDist[i + j] += p;
      scores.push({ score: `${i}-${j}`, p });
      if (i > j) home1 += p; else if (i === j) draw += p; else away1 += p;
      if (i > 0 && j > 0) btts += p;
    }
  }
  const overLine = line => goalsDist.reduce((s, p, g) => s + (g > line ? p : 0), 0) / total;
  const range = (lo, hi) => goalsDist.reduce((s, p, g) => s + (g >= lo && g <= hi ? p : 0), 0) / total;
  const pHome0 = ph[0] / ph.reduce((s, p) => s + p, 0), pAway0 = pa[0] / pa.reduce((s, p) => s + p, 0);
  const homeLe1 = (ph[0] + ph[1]) / ph.reduce((s, p) => s + p, 0), awayLe1 = (pa[0] + pa[1]) / pa.reduce((s, p) => s + p, 0);
  const out = {
    lamH, lamA,
    home: home1 / total, draw: draw / total, away: away1 / total,
    dc1x: (home1 + draw) / total, dcx2: (draw + away1) / total, dc12: (home1 + away1) / total,
    bttsYes: btts / total, bttsNo: 1 - btts / total,
    gr13: range(1, 3), gr24: range(2, 4), gr23: range(2, 3),
    hgo05: 1 - pHome0, hgu05: pHome0, hgo15: 1 - homeLe1, hgu15: homeLe1,
    ago05: 1 - pAway0, agu05: pAway0, ago15: 1 - awayLe1, agu15: awayLe1,
    correctScores: scores.sort((a, b) => b.p - a.p).slice(0, 5).map(s => ({ score: s.score, p: s.p / total }))
  };
  for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
    out[`over${key(line)}`] = overLine(line);
    out[`under${key(line)}`] = 1 - out[`over${key(line)}`];
  }
  return out;
}

export function predictCorners(model, home, away) {
  const info = ready(model, home, away);
  if (!info) return null;
  const out = { cornersH: info.lamH, cornersA: info.lamA };
  countMarkets(info, model, 'c', CORNER_LINES, CORNER_TEAM_LINES, out);
  return out;
}

export function predictCards(model, home, away) {
  const info = ready(model, home, away);
  if (!info) return null;
  const out = { cardsH: info.lamH, cardsA: info.lamA };
  countMarkets(info, model, 'k', CARD_LINES, CARD_TEAM_LINES, out);
  return out;
}

// Fit the three statistic models from finished matches.
export function fitAll(finished, asOf = Date.now()) {
  const rowsFor = (a, b) => finished.filter(m => m[a] != null && m[b] != null).map(m => ({ date: m.date, home: m.home, away: m.away, hg: m[a], ag: m[b] }));
  return {
    goals: fitModel(rowsFor('hg', 'ag'), asOf),
    corners: fitModel(rowsFor('hc', 'ac'), asOf),
    cards: fitModel(rowsFor('hk', 'ak'), asOf)
  };
}

// Temperature scaling in logit space: T > 1 pulls probabilities toward 50%. Learned from the
// backtest so that the count models are not overconfident at the extremes.
export function applyTemp(p, T) {
  if (!T || T === 1) return p;
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return 1 / (1 + Math.exp(-Math.log(q / (1 - q)) / T));
}
function fitTemp(pairs) {
  if (pairs.length < 500) return 1;
  let bestT = 1, best = Infinity;
  for (let T = 0.8; T <= 3.0001; T += 0.05) {
    let ll = 0;
    for (const [p, hit] of pairs) { const q = clamp(applyTemp(p, T)); ll -= Math.log(hit ? q : 1 - q); }
    if (ll < best) { best = ll; bestT = T; }
  }
  return Math.round(bestT * 100) / 100;
}
const CORNER_KEY = /^[ha]?c[ou]\d+$/, CARD_KEY = /^[ha]?k[ou]\d+$/;

export function predictAll(models, home, away, temps = {}) {
  const goals = predict(models.goals, home, away);
  if (!goals) return null;
  const out = { ...goals, ...(predictCorners(models.corners, home, away) || {}), ...(predictCards(models.cards, home, away) || {}) };
  for (const k of Object.keys(out)) {
    if (CORNER_KEY.test(k)) out[k] = applyTemp(out[k], temps.corners);
    else if (CARD_KEY.test(k)) out[k] = applyTemp(out[k], temps.cards);
  }
  return out;
}

function outcome(m) {
  return m.hg > m.ag ? 'home' : m.hg === m.ag ? 'draw' : 'away';
}

const clamp = x => Math.min(1 - 1e-9, Math.max(1e-9, x));

function summarise(results) {
  const n = results.length;
  if (!n) return { n: 0 };
  let ll = 0, llBase = 0, brier = 0, brierBase = 0, correct = 0;
  for (const r of results) {
    ll -= Math.log(clamp(r.p[r.actual]));
    llBase -= Math.log(clamp(r.base[r.actual]));
    for (const k of ['home', 'draw', 'away']) {
      brier += (r.p[k] - (r.actual === k ? 1 : 0)) ** 2;
      brierBase += (r.base[k] - (r.actual === k ? 1 : 0)) ** 2;
    }
    const top = ['home', 'draw', 'away'].reduce((b, k) => (r.p[k] > r.p[b] ? k : b), 'home');
    if (top === r.actual) correct++;
  }

  const edges = [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0001];
  const buckets = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], n: 0, predicted: 0, hits: 0 }));
  for (const r of results) {
    for (const k of ['home', 'draw', 'away']) {
      const b = buckets.find(x => r.p[k] >= x.lo && r.p[k] < x.hi);
      b.n++; b.predicted += r.p[k]; if (r.actual === k) b.hits++;
    }
  }
  const calibration = buckets.filter(b => b.n).map(b => ({
    range: `${Math.round(b.lo * 100)}-${Math.min(100, Math.round(b.hi * 100))}%`,
    n: b.n, predicted: b.predicted / b.n, actual: b.hits / b.n
  }));

  const thresholds = [0.5, 0.6, 0.7, 0.8].map(t => {
    let bets = 0, wins = 0;
    for (const r of results) for (const k of ['home', 'draw', 'away']) {
      if (r.p[k] >= t) { bets++; if (r.actual === k) wins++; }
    }
    return { threshold: t, bets, winRate: bets ? wins / bets : null };
  });

  return {
    n,
    accuracyTopPick: correct / n,
    logLoss: ll / n, logLossBaseline: llBase / n,
    brier: brier / n, brierBaseline: brierBase / n,
    calibration, thresholds
  };
}

// Calibration for over/under style markets: bucket every predicted probability and compare with how
// often it happened.
function calibrationOf(pairs) {
  const bins = Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, n: 0, predicted: 0, hits: 0 }));
  for (const [p, hit] of pairs) {
    const b = bins[Math.min(9, Math.floor(p * 10))];
    b.n++; b.predicted += p; if (hit) b.hits++;
  }
  return {
    n: pairs.length,
    calibration: bins.filter(b => b.n >= 20).map(b => ({
      range: `${Math.round(b.lo * 100)}-${Math.round(b.lo * 100) + 10}%`, n: b.n, predicted: b.predicted / b.n, actual: b.hits / b.n
    }))
  };
}

// Walk-forward backtest: every match is predicted by models that only saw earlier matches
// (refitted weekly), evaluated on the last `evalDays` days. Reports probability quality and
// calibration only. It does NOT report profit: free historical bookmaker odds are unavailable,
// and a profit figure without real odds would be invented.
export function backtest(matches, { evalDays = 365, refitDays = 7 } = {}) {
  const sorted = [...matches].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 100) return { all: { n: 0 }, byComp: {}, totals: {} };
  const cutoff = new Date(sorted[sorted.length - 1].date).getTime() - evalDays * DAY_MS;
  const results = [];
  const pairs = { goals: [], corners: [], cards: [] };
  let models = null, modelAt = -Infinity;
  let base = null, baseAt = -1;
  for (let i = 80; i < sorted.length; i++) {
    const m = sorted[i];
    const t = new Date(m.date).getTime();
    if (t < cutoff) continue;
    if (t - modelAt >= refitDays * DAY_MS) {
      const prior = sorted.slice(0, i);
      models = fitAll(prior, t); modelAt = t;
      base = {
        home: prior.filter(x => x.hg > x.ag).length / prior.length,
        draw: prior.filter(x => x.hg === x.ag).length / prior.length,
        away: prior.filter(x => x.hg < x.ag).length / prior.length
      };
    }
    const g = predict(models.goals, m.home, m.away);
    if (!g) continue;
    results.push({ comp: m.comp, p: g, base, actual: outcome(m) });
    const goalTotal = m.hg + m.ag;
    for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) pairs.goals.push([g[`over${key(line)}`], goalTotal > line]);
    if (m.hc != null) {
      const c = predictCorners(models.corners, m.home, m.away);
      if (c) for (const line of CORNER_LINES) pairs.corners.push([c[`co${key(line)}`], m.hc + m.ac > line]);
    }
    if (m.hk != null) {
      const k = predictCards(models.cards, m.home, m.away);
      if (k) for (const line of CARD_LINES) pairs.cards.push([k[`ko${key(line)}`], m.hk + m.ak > line]);
    }
  }
  const byComp = {};
  for (const comp of new Set(results.map(r => r.comp))) byComp[comp] = summarise(results.filter(r => r.comp === comp));
  const temps = { corners: fitTemp(pairs.corners), cards: fitTemp(pairs.cards) };
  const scaled = (list, T) => list.map(([p, hit]) => [applyTemp(p, T), hit]);
  return {
    all: summarise(results), byComp, temps,
    totals: {
      goals: calibrationOf(pairs.goals),
      corners: { ...calibrationOf(scaled(pairs.corners, temps.corners)), raw: calibrationOf(pairs.corners).calibration, temperature: temps.corners },
      cards: { ...calibrationOf(scaled(pairs.cards, temps.cards)), raw: calibrationOf(pairs.cards).calibration, temperature: temps.cards }
    }
  };
}
