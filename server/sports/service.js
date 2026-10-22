import { fitAll, predictAll, backtest } from './model.js';
import { LEAGUES, fetchAll, monthRange } from './espn.js';
import { marketList, packMarkets, pointKey, DNB_GROUP } from './markets.js';

// Match data comes from ESPN's keyless public scoreboard feed (see espn.js).
// Optional environment:
//   SPORTS_COMPS        comma list of ESPN league codes (default: all in espn.js)
//   DAYS_AHEAD          how far ahead to list fixtures (default 14)
//   HISTORY_MONTHS      months of past results used to fit the model (default 14)
//   MIN_EDGE            minimum edge to flag a pick (default 0.04)
//   MARKET_WEIGHT       0..1 weight of the market's no-vig probability when blending (default 0.7)
//   ODDS_API_KEY        optional key from the-odds-api.com: adds Betway/UK prices and more markets
//   PREFERRED_BOOKMAKER bookmaker key preferred from the Odds API (default "betway")
//   ODDS_TTL_HOURS      reuse fetched Odds API prices this long to save credits (default 6)
//   ODDS_EXTRA_MARKETS  "1" to also fetch BTTS + double chance per match from the Odds API
//   EXTRA_EVENTS        max matches per refresh to fetch those extra prices for (default 10)
const ODDS_KEY = process.env.ODDS_API_KEY || '';
const COMPS = (process.env.SPORTS_COMPS || Object.keys(LEAGUES).join(',')).split(',').map(s => s.trim()).filter(c => LEAGUES[c]);
const DAYS_AHEAD = Number(process.env.DAYS_AHEAD || 14);
const HISTORY_MONTHS = Number(process.env.HISTORY_MONTHS || 14);
const MIN_EDGE = Number(process.env.MIN_EDGE || 0.04);
const MARKET_WEIGHT = Math.min(1, Math.max(0, Number(process.env.MARKET_WEIGHT ?? 0.7)));
const BOOK = (process.env.PREFERRED_BOOKMAKER || 'betway').toLowerCase();
const ODDS_BASE = process.env.ODDS_BASE || 'https://api.the-odds-api.com';
const ODDS_TTL = Number(process.env.ODDS_TTL_HOURS || 6) * 3600 * 1000;
const EXTRA = process.env.ODDS_EXTRA_MARKETS === '1';
const EXTRA_EVENTS = Number(process.env.EXTRA_EVENTS || 10);
const STALE_MS = 30 * 60 * 1000;

export const state = {
  configured: { espn: true, oddsApi: Boolean(ODDS_KEY) },
  comps: COMPS.map(code => ({ code, name: LEAGUES[code].name })),
  phase: 'idle', // idle | running | done | error
  progress: '',
  error: null,
  warnings: [],
  updatedAt: null,
  oddsAsOf: null,
  oddsCredits: null,
  counts: { finished: 0, upcoming: 0, live: 0 },
  fixtures: [],
  backtest: { all: { n: 0 }, byComp: {}, totals: {}, temps: {} },
  backtestAt: null,
  settings: { minEdge: MIN_EDGE, marketWeight: MARKET_WEIGHT, daysAhead: DAYS_AHEAD, historyMonths: HISTORY_MONTHS, extraMarkets: EXTRA }
};

const oddsCache = new Map(); // league -> { at, events, extras }
const SERVERLESS = Boolean(process.env.VERCEL || process.env.SERVERLESS);
// Calibration measured by the backtest (see the app's backtest section); used when the backtest is skipped.
const DEFAULT_TEMPS = { corners: 1.25, cards: 1.1 };
let lastFinished = null;

async function getJson(url, onHeaders) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (onHeaders) onHeaders(res.headers);
  if (res.status === 401 || res.status === 403) throw new Error(`${new URL(url).hostname} rejected the API key (HTTP ${res.status}).`);
  if (res.status === 429) throw new Error('Rate limited by the odds provider.');
  if (!res.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${res.status}`);
  return res.json();
}

const ALIASES = {
  'wolves': 'wolverhampton wanderers', 'spurs': 'tottenham hotspur', 'tottenham': 'tottenham hotspur',
  'man city': 'manchester city', 'man utd': 'manchester united', 'man united': 'manchester united',
  'newcastle': 'newcastle united', 'west ham': 'west ham united', 'brighton': 'brighton hove albion',
  'brighton and hove albion': 'brighton hove albion', 'leicester': 'leicester city', 'leeds': 'leeds united',
  "nott'm forest": 'nottingham forest', 'inter': 'internazionale', 'inter milan': 'internazionale',
  'atletico madrid': 'atletico de madrid', 'atletico': 'atletico de madrid', 'athletic bilbao': 'athletic club',
  'bayern munich': 'bayern munchen', 'psg': 'paris saint germain', 'bayer leverkusen': 'bayer 04 leverkusen',
  'rb leipzig': 'rasenballsport leipzig'
};

export function normName(name) {
  const base = String(name).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return (ALIASES[base] || base)
    .split(/\s+/)
    .filter(t => t && !['fc', 'cf', 'afc', 'ac', 'as', 'sc', 'fk', 'sk', 'ssc', 'us', 'club', 'de', 'calcio', 'fsv', 'vfb', 'vfl', 'tsg', 'rb', 'sv', 'ud', 'cd', 'rc', 'og', 'losc'].includes(t) && !/^\d+$/.test(t))
    .join(' ');
}
export function sameTeam(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // One name's tokens must be a subset of the other's ("newcastle" in "newcastle united").
  // Partial overlap such as "manchester" alone must NOT match or rival clubs get conflated.
  const tx = x.split(' '), ty = y.split(' ');
  const [small, big] = tx.length <= ty.length ? [tx, ty] : [ty, tx];
  return small.every(t => big.includes(t)) && !(small.length === 1 && small[0].length < 4);
}

function noVig(prices, target = 1) {
  const inv = prices.map(p => 1 / p);
  const sum = inv.reduce((s, v) => s + v, 0);
  return inv.map(v => (v / sum) * target);
}

const average = (items, keys) => {
  const out = Object.fromEntries(keys.map(k => [k, 0]));
  for (const it of items) for (const k of keys) out[k] += it[k] / items.length;
  return out;
};

// Odds embedded in the ESPN event (usually one bookmaker, 1X2 and the main goals line).
function oddsFromEspn(o) {
  if (!o) return {};
  const out = {};
  if (o.h2h) {
    const [home, draw, away] = noVig([o.h2h.home, o.h2h.draw, o.h2h.away]);
    out.home = { odds: o.h2h.home, source: o.provider, fair: home, books: 1 };
    out.draw = { odds: o.h2h.draw, source: o.provider, fair: draw, books: 1 };
    out.away = { odds: o.h2h.away, source: o.provider, fair: away, books: 1 };
  }
  if (o.total) {
    const k = pointKey(o.total.line);
    const [ov, un] = noVig([o.total.over, o.total.under]);
    out[`over${k}`] = { odds: o.total.over, source: o.provider, fair: ov, books: 1 };
    out[`under${k}`] = { odds: o.total.under, source: o.provider, fair: un, books: 1 };
  }
  return out;
}

// Collapse one Odds API event into { selectionKey: { odds, source, fair } }.
function summariseOdds(event) {
  const books = event.bookmakers || [];
  const result = {};

  const perBook = (marketKey, extract) => books.flatMap(b => {
    const m = b.markets?.find(x => x.key === marketKey);
    const ext = m && extract(m.outcomes || []);
    return ext ? [{ book: b, ...ext }] : [];
  });

  const addGroup = (rows, keys, fairOf) => {
    if (!rows.length) return;
    const fair = average(rows.map(r => fairOf(r.prices)), keys);
    const own = rows.find(r => r.book.key === BOOK);
    for (const k of keys) {
      const best = Math.max(...rows.map(r => r.prices[k]));
      result[k] = { odds: own ? own.prices[k] : best, source: own ? own.book.title : 'best available', fair: fair[k], books: rows.length };
    }
  };

  addGroup(perBook('h2h', outs => {
    const h = outs.find(o => sameTeam(o.name, event.home_team));
    const a = outs.find(o => sameTeam(o.name, event.away_team));
    const d = outs.find(o => /draw/i.test(o.name));
    return h && a && d ? { prices: { home: h.price, draw: d.price, away: a.price } } : null;
  }), ['home', 'draw', 'away'], p => {
    const [home, draw, away] = noVig([p.home, p.draw, p.away]);
    return { home, draw, away };
  });

  const lines = new Set();
  for (const b of books) for (const o of b.markets?.find(x => x.key === 'totals')?.outcomes || []) if (o.point != null) lines.add(Number(o.point));
  for (const pt of lines) {
    const k = pointKey(pt);
    addGroup(perBook('totals', outs => {
      const o = outs.find(x => /over/i.test(x.name) && Number(x.point) === pt);
      const u = outs.find(x => /under/i.test(x.name) && Number(x.point) === pt);
      return o && u ? { prices: { [`over${k}`]: o.price, [`under${k}`]: u.price } } : null;
    }), [`over${k}`, `under${k}`], p => {
      const [o, u] = noVig([p[`over${k}`], p[`under${k}`]]);
      return { [`over${k}`]: o, [`under${k}`]: u };
    });
  }

  addGroup(perBook('btts', outs => {
    const y = outs.find(o => /yes/i.test(o.name)), n = outs.find(o => /no/i.test(o.name));
    return y && n ? { prices: { bttsYes: y.price, bttsNo: n.price } } : null;
  }), ['bttsYes', 'bttsNo'], p => {
    const [bttsYes, bttsNo] = noVig([p.bttsYes, p.bttsNo]);
    return { bttsYes, bttsNo };
  });

  // Double chance: three outcomes whose probabilities sum to 2
  addGroup(perBook('double_chance', outs => {
    const strip = n => n.replace(/draw|or|\/|&|and/gi, ' ').trim();
    const c1x = outs.find(o => /draw/i.test(o.name) && sameTeam(strip(o.name), event.home_team));
    const cx2 = outs.find(o => /draw/i.test(o.name) && sameTeam(strip(o.name), event.away_team));
    const c12 = outs.find(o => !/draw/i.test(o.name));
    return c1x && cx2 && c12 ? { prices: { dc1x: c1x.price, dcx2: cx2.price, dc12: c12.price } } : null;
  }), ['dc1x', 'dcx2', 'dc12'], p => {
    const [dc1x, dcx2, dc12] = noVig([p.dc1x, p.dcx2, p.dc12], 2);
    return { dc1x, dcx2, dc12 };
  });

  return result;
}

function buildMarkets(fx, pred, odds) {
  if (!pred) return [];
  const markets = marketList(fx).filter(([, key]) => Number.isFinite(pred[key])).map(([group, key, label]) => {
    const modelProb = pred[key];
    const o = odds?.[key];
    const prob = o ? (1 - MARKET_WEIGHT) * modelProb + MARKET_WEIGHT * o.fair : modelProb;
    const edge = o ? prob * o.odds - 1 : null;
    return {
      group, key, label, modelProb, fairOdds: 1 / modelProb,
      odds: o?.odds ?? null, oddsSource: o?.source ?? null, marketProb: o?.fair ?? null,
      prob, edge, recommended: edge != null && edge >= MIN_EDGE
    };
  });
  // Draw-no-bet is model-only (fair price; the push on a draw makes quoted prices non-comparable).
  markets.push(
    { group: DNB_GROUP, key: 'dnbHome', label: `${fx.home} (draw no bet)`, modelProb: pred.home / (pred.home + pred.away), prob: pred.home / (pred.home + pred.away), fairOdds: 1 + pred.draw / pred.home, odds: null, oddsSource: null, marketProb: null, edge: null, recommended: false },
    { group: DNB_GROUP, key: 'dnbAway', label: `${fx.away} (draw no bet)`, modelProb: pred.away / (pred.home + pred.away), prob: pred.away / (pred.home + pred.away), fairOdds: 1 + pred.draw / pred.away, odds: null, oddsSource: null, marketProb: null, edge: null, recommended: false }
  );
  return markets;
}

async function fetchOddsApi(league, needed) {
  const sport = LEAGUES[league]?.odds;
  if (!ODDS_KEY || !sport || !needed) return null;
  const cached = oddsCache.get(league);
  if (cached && Date.now() - cached.at < ODDS_TTL) return cached;
  state.progress = `Fetching bookmaker prices for ${LEAGUES[league].name}...`;
  const events = await getJson(
    `${ODDS_BASE}/v4/sports/${sport}/odds?regions=uk&markets=h2h,totals&oddsFormat=decimal&apiKey=${ODDS_KEY}`,
    h => { const r = h.get('x-requests-remaining'); if (r != null) state.oddsCredits = Number(r); }
  );
  const entry = { at: Date.now(), events, extras: new Map() };
  oddsCache.set(league, entry);
  return entry;
}

async function fetchExtraMarkets(league, entry, eventId) {
  if (entry.extras.has(eventId)) return entry.extras.get(eventId);
  try {
    const ev = await getJson(
      `${ODDS_BASE}/v4/sports/${LEAGUES[league].odds}/events/${eventId}/odds?regions=uk&markets=btts,double_chance&oddsFormat=decimal&apiKey=${ODDS_KEY}`,
      h => { const r = h.get('x-requests-remaining'); if (r != null) state.oddsCredits = Number(r); }
    );
    entry.extras.set(eventId, ev);
    return ev;
  } catch (e) {
    state.warnings.push(`Extra markets unavailable: ${e.message}`);
    entry.extras.set(eventId, null);
    return null;
  }
}

async function refresh({ force = false } = {}) {
  if (state.phase === 'running') return;
  state.phase = 'running'; state.error = null; state.warnings = []; state.progress = 'Downloading fixtures and results...';
  try {
    const months = monthRange(HISTORY_MONTHS, DAYS_AHEAD);
    const { events, errors, requests } = await fetchAll(COMPS, months, {
      force,
      onProgress: (done, total) => { state.progress = `Downloading fixtures and results (${done}/${total})...`; }
    });
    if (errors.length) state.warnings.push(`${errors.length} of ${requests} data requests failed (e.g. ${errors[0]}). Affected leagues may be incomplete.`);
    if (!events.length) throw new Error(`No data received from ESPN (${errors[0] || 'empty response'}). Check your internet connection and try again.`);

    // Deduplicate by id (a match can appear in two month windows near boundaries).
    const unique = [...new Map(events.map(e => [e.id, e])).values()];
    const finished = unique.filter(e => e.kind === 'finished')
      .map(e => ({ date: e.date, comp: e.league, home: e.home, away: e.away, hg: e.hg, ag: e.ag, hc: e.hc, ac: e.ac, hk: e.hk, ak: e.ak }));
    const now = Date.now();
    const horizon = now + DAYS_AHEAD * 86400000;
    const upcoming = unique.filter(e => (e.kind === 'live') || (e.kind === 'upcoming' && new Date(e.date).getTime() > now - 60000 && new Date(e.date).getTime() <= horizon))
      .sort((a, b) => a.date.localeCompare(b.date));

    state.progress = `Fitting model on ${finished.length} finished matches...`;
    const models = fitAll(finished);
    if (!models.goals) throw new Error('Not enough finished matches to fit the model.');

    lastFinished = finished;

    // The backtest is slow, so it is re-run at most every 12 hours; it also supplies the calibration
    // that keeps corner and card probabilities honest. On serverless hosts (Vercel) it is skipped here
    // to stay inside the function time limit: the last measured calibration is used instead, and the
    // full backtest is available on demand from computeBacktest().
    if (!SERVERLESS && (force || !state.backtestAt || Date.now() - state.backtestAt > 12 * 3600 * 1000)) {
      state.progress = 'Backtesting and calibrating the model...';
      state.backtest = backtest(finished);
      state.backtestAt = Date.now();
    }
    const temps = state.backtest.temps?.corners ? state.backtest.temps : DEFAULT_TEMPS;

    // Optional bookmaker prices from the Odds API.
    const oddsByLeague = new Map();
    for (const code of COMPS) {
      const soon = upcoming.some(m => m.league === code && m.kind === 'upcoming' && new Date(m.date).getTime() < now + 4 * 86400000);
      try { oddsByLeague.set(code, await fetchOddsApi(code, soon)); } catch (e) { state.warnings.push(`Odds API ${LEAGUES[code].name}: ${e.message}`); }
    }

    let extraBudget = EXTRA_EVENTS;
    const fixtures = [];
    for (const m of upcoming) {
      const live = m.kind === 'live';
      const fx = { id: m.id, comp: m.league, compName: LEAGUES[m.league].name, date: m.date, live, home: m.home, away: m.away, score: live ? m.score : null, clock: live ? m.clock : null };
      const pred = predictAll(models, fx.home, fx.away, temps);
      let odds = live ? {} : oddsFromEspn(m.odds);
      const entry = oddsByLeague.get(m.league);
      const ev = !live && entry?.events.find(e => sameTeam(e.home_team, fx.home) && sameTeam(e.away_team, fx.away)
        && Math.abs(new Date(e.commence_time) - new Date(fx.date)) < 36 * 3600 * 1000);
      if (ev) {
        odds = { ...odds, ...summariseOdds(ev) }; // Odds API (e.g. Betway) overrides the ESPN price where both exist
        if (EXTRA && extraBudget > 0 && new Date(fx.date) < now + 3 * 86400000) {
          extraBudget--;
          const extra = await fetchExtraMarkets(m.league, entry, ev.id);
          if (extra) odds = { ...odds, ...summariseOdds(extra) };
        }
      }
      fixtures.push({
        ...fx,
        prediction: pred ? { home: pred.home, draw: pred.draw, away: pred.away, expectedGoals: [pred.lamH, pred.lamA], expectedCorners: pred.cornersH != null ? [pred.cornersH, pred.cornersA] : null, expectedCards: pred.cardsH != null ? [pred.cardsH, pred.cardsA] : null, correctScores: pred.correctScores } : null,
        hasOdds: Object.keys(odds).length > 0,
        markets: live ? [] : buildMarkets(fx, pred, odds)
      });
    }

    state.fixtures = fixtures;
    state.counts = { finished: finished.length, upcoming: fixtures.filter(f => !f.live).length, live: fixtures.filter(f => f.live).length };
    const stamps = [...oddsCache.values()].map(e => e.at);
    state.oddsAsOf = stamps.length ? new Date(Math.min(...stamps)).toISOString() : null;
    state.updatedAt = new Date().toISOString();
    state.phase = 'done'; state.progress = '';
  } catch (e) {
    state.phase = 'error'; state.error = e.message || String(e);
  }
}

// One refresh at a time; concurrent callers share the same promise.
let inflight = null;
export function refreshOnce(opts) {
  if (!inflight) inflight = refresh(opts).finally(() => { inflight = null; });
  return inflight;
}

const isStale = () => !state.updatedAt || Date.now() - new Date(state.updatedAt) > STALE_MS;

// Long-running server: called on every state request so the page stays current without clicks.
let retryAt = 0;
export function ensureFresh() {
  if (state.phase === 'running') return;
  if (isStale() && Date.now() >= retryAt) { retryAt = Date.now() + 60000; refreshOnce(); }
}

// Serverless: a function invocation must finish the work before it returns.
export async function refreshIfStale() {
  if (isStale() || state.phase === 'error') await refreshOnce();
}

// Full backtest on demand (used by the serverless host, where refresh skips it).
export async function computeBacktest() {
  if (!lastFinished) await refreshOnce();
  if (lastFinished && !state.backtest.all?.n) {
    state.backtest = backtest(lastFinished);
    state.backtestAt = Date.now();
  }
  return state.backtest;
}

// What goes over the wire: fixtures carry compact market rows (labels are rebuilt in the browser),
// which keeps the response far below hosting payload limits.
export function publicState() {
  return {
    ...state,
    fixtures: state.fixtures.map(({ markets, ...fx }) => ({ ...fx, m: packMarkets(markets) }))
  };
}
