// Keyless football data from ESPN's public scoreboard JSON (the feed behind espn.com).
// It is an undocumented, unofficial endpoint: it needs no key but carries no uptime guarantee,
// so every failure is surfaced to the UI instead of being papered over.
//   GET {BASE}/{league}/scoreboard?dates=YYYYMM&limit=1000   -> all events in that month

const BASE = process.env.ESPN_BASE || 'https://site.api.espn.com/apis/site/v2/sports/soccer';

export const LEAGUES = {
  'uefa.champions': { name: 'Champions League', odds: 'soccer_uefa_champs_league' },
  'uefa.europa': { name: 'Europa League', odds: 'soccer_uefa_europa_league' },
  'uefa.europa.conf': { name: 'Conference League', odds: 'soccer_uefa_europa_conference_league' },
  'eng.1': { name: 'Premier League', odds: 'soccer_epl' },
  'eng.2': { name: 'Championship', odds: 'soccer_efl_champ' },
  'esp.1': { name: 'La Liga', odds: 'soccer_spain_la_liga' },
  'ita.1': { name: 'Serie A', odds: 'soccer_italy_serie_a' },
  'ger.1': { name: 'Bundesliga', odds: 'soccer_germany_bundesliga' },
  'fra.1': { name: 'Ligue 1', odds: 'soccer_france_ligue_one' },
  'ned.1': { name: 'Eredivisie', odds: 'soccer_netherlands_eredivisie' },
  'por.1': { name: 'Primeira Liga', odds: 'soccer_portugal_primeira_liga' },
  'tur.1': { name: 'Super Lig', odds: 'soccer_turkey_super_league' },
  'sco.1': { name: 'Scottish Premiership', odds: 'soccer_spl' },
  'bel.1': { name: 'Belgian Pro League', odds: 'soccer_belgium_first_div' },
  'gre.1': { name: 'Greek Super League', odds: 'soccer_greece_super_league' },
  'aut.1': { name: 'Austrian Bundesliga', odds: 'soccer_austria_bundesliga' },
  // Included mainly so European-cup opponents from these leagues have a rating.
  'den.1': { name: 'Danish Superliga', odds: 'soccer_denmark_superliga' },
  'nor.1': { name: 'Eliteserien', odds: 'soccer_norway_eliteserien' },
  'swe.1': { name: 'Allsvenskan', odds: 'soccer_sweden_allsvenskan' }
};

const monthCache = new Map(); // `${league}:${yyyymm}` -> { at, events }
const CURRENT_TTL = 25 * 60 * 1000; // this month and next: refreshed often
const PAST_TTL = 24 * 3600 * 1000; // older months barely change

export function monthKey(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthRange(monthsBack, daysAhead, now = new Date()) {
  const out = [];
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
  const end = new Date(now.getTime() + daysAhead * 86400000);
  for (let d = start; d <= end; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) out.push(monthKey(d));
  return out;
}

async function fetchMonth(league, ym, force) {
  const key = `${league}:${ym}`;
  const nowKey = monthKey(new Date());
  const isRecent = ym >= nowKey || monthKey(new Date(Date.now() - 20 * 86400000)) <= ym;
  const cached = monthCache.get(key);
  if (!force && cached && Date.now() - cached.at < (isRecent ? CURRENT_TTL : PAST_TTL)) return cached.events;
  // A month with no games comes back as HTTP 200 with zero events, so any other status is a real
  // failure (including occasional 400s under load). Retry with a short backoff; if it still fails the
  // error is reported and nothing is cached, so the next refresh tries that month again.
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${BASE}/${league}/scoreboard?dates=${ym}&limit=1000`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`ESPN returned HTTP ${res.status} for ${league} ${ym}`);
      const json = await res.json();
      const events = json.events || [];
      monthCache.set(key, { at: Date.now(), events });
      return events;
    } catch (e) {
      lastError = e;
      if (attempt < 4) await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
  throw lastError;
}

// Runs fn over items with limited concurrency.
export async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

export function americanToDecimal(value) {
  const n = Number(String(value).replace('+', ''));
  if (!Number.isFinite(n) || n === 0) return null;
  const dec = n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
  return Number.isFinite(dec) && dec > 1 ? Math.round(dec * 100) / 100 : null;
}

function parseOdds(odds) {
  if (!odds) return null;
  const ml = odds.moneyline;
  const home = americanToDecimal(ml?.home?.close?.odds);
  const away = americanToDecimal(ml?.away?.close?.odds);
  const draw = americanToDecimal(ml?.draw?.close?.odds ?? odds.drawOdds?.moneyLine);
  const out = { provider: odds.provider?.displayName || 'ESPN odds' };
  if (home && away && draw) out.h2h = { home, draw, away };
  const line = Number(String(odds.total?.over?.close?.line || '').replace(/[^0-9.]/g, '')) || Number(odds.overUnder);
  const over = americanToDecimal(odds.total?.over?.close?.odds);
  const under = americanToDecimal(odds.total?.under?.close?.odds);
  if (line && over && under) out.total = { line, over, under };
  return out.h2h || out.total ? out : null;
}

const DEAD = new Set(['STATUS_POSTPONED', 'STATUS_CANCELED', 'STATUS_CANCELLED', 'STATUS_ABANDONED', 'STATUS_SUSPENDED', 'STATUS_FORFEIT']);

export function parseEvent(ev, league) {
  const c = ev.competitions?.[0];
  if (!c || !ev.date) return null;
  const home = c.competitors?.find(x => x.homeAway === 'home');
  const away = c.competitors?.find(x => x.homeAway === 'away');
  if (!home?.team?.displayName || !away?.team?.displayName) return null;
  const type = ev.status?.type || {};
  if (DEAD.has(type.name)) return null;
  const base = { id: `${league}:${ev.id}`, league, date: new Date(ev.date).toISOString(), home: home.team.displayName, away: away.team.displayName };
  if (type.state === 'post') {
    // Only count normal full-time results; extra-time / penalty scores would distort 90-minute models.
    if (type.name !== 'STATUS_FULL_TIME') return { ...base, kind: 'skip' };
    const hg = Number(home.score), ag = Number(away.score);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) return null;
    // Corners and cards ride along in the same response. A match without a corner statistic is
    // treated as having no stats at all (null), never as zero.
    const stat = (team, name) => {
      const s = team.statistics?.find(x => x.name === name);
      const v = s ? Number(s.value ?? s.displayValue) : NaN;
      return Number.isFinite(v) ? v : null;
    };
    const hc = stat(home, 'wonCorners'), ac = stat(away, 'wonCorners');
    let hk = null, ak = null;
    if (hc != null && ac != null) {
      hk = 0; ak = 0;
      for (const d of c.details || []) {
        if (!d.yellowCard && !d.redCard) continue;
        if (String(d.team?.id) === String(home.team.id)) hk++;
        else if (String(d.team?.id) === String(away.team.id)) ak++;
      }
    }
    return { ...base, kind: 'finished', hg, ag, hc, ac, hk, ak };
  }
  if (type.state === 'in') return { ...base, kind: 'live', score: [home.score, away.score], clock: ev.status?.displayClock };
  if (type.state === 'pre') return { ...base, kind: 'upcoming', odds: parseOdds(c.odds?.[0] || c.odds) };
  return null;
}

// Fetch every parsed event for the given leagues and months.
export async function fetchAll(leagues, months, { force = false, onProgress } = {}) {
  const jobs = leagues.flatMap(l => months.map(ym => ({ l, ym })));
  let done = 0;
  const errors = [];
  const results = await pool(jobs, 5, async ({ l, ym }) => {
    try {
      const events = await fetchMonth(l, ym, force);
      return events.map(e => parseEvent(e, l)).filter(Boolean);
    } catch (e) {
      errors.push(e.message);
      return [];
    } finally {
      done++;
      if (onProgress && done % 5 === 0) onProgress(done, jobs.length);
    }
  });
  return { events: results.flat(), errors, requests: jobs.length };
}
