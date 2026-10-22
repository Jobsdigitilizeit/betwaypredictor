import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronUp, Copy, RefreshCw, Search, Trash2 } from 'lucide-react';

import { unpackMarkets } from '../server/sports/markets.js';

// The API sends markets as compact rows; rebuild labels and groups here.
const hydrate = json => ({
  ...json,
  fixtures: (json.fixtures || []).map(f => ({ ...f, markets: unpackMarkets(f, f.m, json.settings.minEdge) }))
});

const pct = v => `${(v * 100).toFixed(1)}%`;
const timeOf = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dateTimeOf = iso => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function dayLabel(iso) {
  const d = new Date(iso);
  const start = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(d) - start(new Date())) / 86400000);
  const base = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  return diff === 0 ? `Today · ${base}` : diff === 1 ? `Tomorrow · ${base}` : base;
}

export default function Sports() {
  const [data, setData] = useState(null);
  const [offline, setOffline] = useState(false);
  const [slip, setSlip] = useState([]);
  const [stake, setStake] = useState('100');
  const [comp, setComp] = useState('ALL');
  const [query, setQuery] = useState('');
  const [valueOnly, setValueOnly] = useState(false);
  const [open, setOpen] = useState({});
  const [copied, setCopied] = useState(false);
  const [gen, setGen] = useState({ preset: 'balanced', legs: 5, minProb: 65, minOdds: 1.2, window: '48', includeFair: true });
  const [genMsg, setGenMsg] = useState('');

  useEffect(() => {
    let alive = true;
    let timer;
    const load = async () => {
      try {
        const r = await fetch('/api/sports/state');
        if (!r.ok) throw new Error();
        const json = await r.json();
        if (!alive) return;
        setData(hydrate(json)); setOffline(false);
        timer = setTimeout(load, json.phase === 'running' ? 3000 : 60000);
      } catch {
        if (alive) { setOffline(true); timer = setTimeout(load, 8000); }
      }
    };
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  const startRefresh = async () => {
    setData(d => d && { ...d, phase: 'running', progress: 'Refreshing everything, this can take up to a minute…' });
    try {
      const r = await fetch('/api/sports/refresh', { method: 'POST' });
      // Serverless hosts finish the work inside the request and return the new state; the long-running
      // server just starts it and the regular polling picks up the result.
      if (r.ok) {
        const json = await r.json();
        if (json.fixtures) setData(hydrate(json));
      }
    } catch { /* the poll loop will show the real state */ }
  };

  // On serverless hosts the state omits the slow backtest; fetch it the first time that section opens.
  const [extraBt, setExtraBt] = useState(null);
  const [btLoading, setBtLoading] = useState(false);
  const loadBacktest = async () => {
    if (btLoading || extraBt) return;
    setBtLoading(true);
    try {
      const r = await fetch('/api/sports/backtest');
      if (r.ok) setExtraBt(await r.json());
    } catch { /* leave the section empty */ }
    setBtLoading(false);
  };

  const toggle = (fx, m) => {
    const key = `${fx.id}:${m.key}`;
    setSlip(prev => {
      if (prev.some(s => s.key === key)) return prev.filter(s => s.key !== key);
      const rest = prev.filter(s => s.fixtureId !== fx.id); // one leg per match keeps legs independent
      const odds = m.odds ?? m.fairOdds;
      return [...rest, { key, fixtureId: fx.id, label: `${m.group}: ${m.label}`, match: `${fx.home} v ${fx.away}`, odds, oddsText: odds.toFixed(2), prob: m.prob, fair: m.odds == null }];
    });
  };

  // Odds on a leg can be overwritten with the real price you see at your bookmaker.
  const legOdds = s => { const n = Number(s.oddsText); return Number.isFinite(n) && n >= 1.01 ? n : s.odds; };
  const setLegOdds = (key, text) => setSlip(prev => prev.map(s => (s.key === key ? { ...s, oddsText: text } : s)));

  const slipStats = useMemo(() => {
    if (!slip.length) return null;
    const odds = slip.reduce((p, s) => p * legOdds(s), 1);
    const prob = slip.reduce((p, s) => p * s.prob, 1);
    const s = Number(stake) || 0;
    return { odds, prob, ret: s * odds, expected: s * (prob * odds - 1) };
  }, [slip, stake]);

  const copySlip = async () => {
    const text = slip.map(s => `${s.match} — ${s.label} @ ${legOdds(s).toFixed(2)}`).join('\n') + (slipStats ? `\nCombined odds: ${slipStats.odds.toFixed(2)}` : '');
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  };

  const PRESETS = {
    safe: { legs: 3, minProb: 78 },
    balanced: { legs: 5, minProb: 65 },
    bigger: { legs: 7, minProb: 55 }
  };
  const pickPreset = name => setGen(g => ({ ...g, preset: name, ...PRESETS[name] }));

  // Market families: the generator mixes them so a slip is not made of one kind of bet.
  const familyOf = group => /corner/i.test(group) ? 'Corners' : /card/i.test(group) ? 'Cards'
    : /result|double/i.test(group) ? 'Result / double chance' : 'Goals';

  // Looks at every market (results, double chance, goals, team goals, corners, cards) of every upcoming
  // match in the current league filter and time window. Each match contributes its single strongest
  // market, and the slip is assembled greedily from the best matches while spreading across market
  // families so one type of bet does not dominate.
  const generateSlip = () => {
    const nowMs = Date.now();
    const until = nowMs + Number(gen.window) * 3600 * 1000;
    const minProb = gen.minProb / 100;
    const minOdds = Number(gen.minOdds) || 1.01;
    const perMatch = [];
    let matchesChecked = 0;
    for (const f of data.fixtures) {
      const t = new Date(f.date).getTime();
      if (f.live || t <= nowMs || t > until || !f.prediction) continue;
      if (comp !== 'ALL' && f.comp !== comp) continue;
      matchesChecked++;
      const options = [];
      for (const m of f.markets) {
        const priced = m.odds != null;
        if (!priced && !gen.includeFair) continue;
        if (m.key.startsWith('dnb')) continue; // draw-no-bet refunds on a draw, so its odds are not comparable
        const odds = priced ? m.odds : m.fairOdds;
        if (odds < minOdds || m.prob < minProb) continue;
        // Probability first; real bookmaker prices that beat the model get a boost, model-only prices a small haircut.
        const score = m.prob + (priced && m.edge > 0 ? m.edge : 0) - (priced ? 0 : 0.03);
        options.push({ f, m, odds, priced, score, family: familyOf(m.group) });
      }
      if (options.length) perMatch.push(options);
    }
    const used = {};
    const chosen = [];
    while (chosen.length < gen.legs && perMatch.length) {
      let bestIdx = -1, best = null, bestAdj = -Infinity;
      perMatch.forEach((options, i) => {
        for (const o of options) {
          const adj = o.score - 0.04 * (used[o.family] || 0); // diversity penalty
          if (adj > bestAdj) { bestAdj = adj; best = o; bestIdx = i; }
        }
      });
      chosen.push(best);
      used[best.family] = (used[best.family] || 0) + 1;
      perMatch.splice(bestIdx, 1);
    }
    chosen.sort((a, b) => a.f.date.localeCompare(b.f.date));
    setSlip(chosen.map(({ f, m, odds, priced }) => ({
      key: `${f.id}:${m.key}`, fixtureId: f.id, label: `${m.group}: ${m.label}`, match: `${f.home} v ${f.away}`,
      odds, oddsText: odds.toFixed(2), prob: m.prob, fair: !priced,
      why: `${pct(m.prob)} chance (model ${pct(m.modelProb)}${m.marketProb != null ? `, market ${pct(m.marketProb)}` : ''}) · ${f.compName} ${dateTimeOf(f.date)}`
    })));
    const mix = Object.entries(used).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(', ');
    setGenMsg(!matchesChecked ? 'No modelled upcoming matches in this window and league filter.'
      : !chosen.length ? `Checked ${matchesChecked} matches: no market reaches ${gen.minProb}% with odds of at least ${gen.minOdds}. Lower the minimum chance or minimum odds, or widen the window.`
      : chosen.length < gen.legs ? `Only ${chosen.length} of ${gen.legs} legs qualified (checked ${matchesChecked} matches): ${mix}. Lower the minimum chance or odds, or widen the window, for more.`
      : `Checked ${matchesChecked} matches across all markets: ${mix}.`);
  };

  if (offline && !data) return <div className="card"><AlertTriangle size={18} /> The local API is not running. Start it with <b>npm run server</b>.</div>;
  if (!data) return <div className="card">Loading fixtures and running the analysis… the first load can take up to a minute.</div>;
  const bt = data.backtest?.all?.n ? data.backtest : (extraBt || data.backtest);

  const now = Date.now();
  const q = query.trim().toLowerCase();
  const visible = data.fixtures.filter(f => {
    if (!f.live && new Date(f.date).getTime() < now - 3 * 3600 * 1000) return false; // already finished
    if (comp !== 'ALL' && f.comp !== comp) return false;
    if (q && !`${f.home} ${f.away}`.toLowerCase().includes(q)) return false;
    if (valueOnly && !f.markets.some(m => m.recommended)) return false;
    return true;
  });
  const days = [];
  for (const f of visible) {
    const label = dayLabel(f.date);
    const last = days[days.length - 1];
    if (last && last.label === label) last.items.push(f); else days.push({ label, items: [f] });
  }
  const valueCount = data.fixtures.reduce((n, f) => n + f.markets.filter(m => m.recommended).length, 0);
  const nameOf = code => data.comps.find(c => c.code === code)?.name || code;
  const btEntries = [
    ...(bt?.all?.n ? [['All competitions', bt.all]] : []),
    ...Object.entries(bt?.byComp || {}).filter(([, b]) => b.n >= 60).map(([code, b]) => [nameOf(code), b])
  ];
  const running = data.phase === 'running';

  return (
    <div className="page">
      <div className="card status">
        <div>
          <div className="kicker">DATA STATUS</div>
          <h3>{running ? (data.progress || 'Working…') : data.updatedAt ? `Matches updated ${dateTimeOf(data.updatedAt)}` : 'No data loaded yet'}</h3>
          <p className="muted">
            {data.counts.upcoming + data.counts.live > 0 ? `${data.counts.upcoming} upcoming${data.counts.live ? ` + ${data.counts.live} live` : ''} fixtures in the next ${data.settings.daysAhead} days across ${data.comps.length} competitions, modelled from ${data.counts.finished.toLocaleString()} finished matches. ` : ''}
            Bookmaker prices come from ESPN's public feed (DraftKings, 1X2 and the main goals line, where listed)
            {data.configured.oddsApi && data.oddsAsOf ? `, plus Odds API prices as of ${dateTimeOf(data.oddsAsOf)}${data.oddsCredits != null ? ` (${data.oddsCredits} credits left)` : ''}` : ''}.
            {' '}Data refreshes automatically every 30 minutes while the server is running.
          </p>
        </div>
        <button className="btn primary" onClick={startRefresh} disabled={running}>
          <RefreshCw size={15} className={running ? 'spin' : ''} /> {running ? 'Working' : 'Refresh now'}
        </button>
      </div>
      {data.phase === 'error' && <div className="card error">{data.error}</div>}
      {data.warnings?.length > 0 && <div className="card warn">{[...new Set(data.warnings)].slice(0, 4).map(w => <div key={w}>{w}</div>)}</div>}

      <div className="card generator">
        <div className="kicker">SLIP GENERATOR</div>
        <h3>Build a slip automatically</h3>
        <p className="muted">Analyses every market on every upcoming match: results, double chance, goals, team goals, corners and cards. It takes the most probable market for each match, mixes market types, and assembles {gen.legs} legs from different matches (respecting the league chips below).</p>
        <div className="gen-row">
          <div className="seg">
            {[['safe', 'Safer'], ['balanced', 'Balanced'], ['bigger', 'Bigger odds']].map(([k, label]) =>
              <button key={k} className={gen.preset === k ? 'on' : ''} onClick={() => pickPreset(k)}>{label}</button>)}
          </div>
          <label>Legs <input type="number" min="1" max="12" value={gen.legs} onChange={e => setGen(g => ({ ...g, preset: 'custom', legs: Math.min(12, Math.max(1, Number(e.target.value) || 1)) }))} /></label>
          <label>Min chance per leg <input type="number" min="30" max="95" value={gen.minProb} onChange={e => setGen(g => ({ ...g, preset: 'custom', minProb: Math.min(95, Math.max(30, Number(e.target.value) || 30)) }))} />%</label>
          <label>Min odds per leg <input type="number" min="1.01" max="3" step="0.05" value={gen.minOdds} onChange={e => setGen(g => ({ ...g, preset: 'custom', minOdds: Math.min(3, Math.max(1.01, Number(e.target.value) || 1.2)) }))} /></label>
          <label>Matches within
            <select value={gen.window} onChange={e => setGen(g => ({ ...g, window: e.target.value }))}>
              <option value="24">24 hours</option><option value="48">48 hours</option><option value="168">7 days</option><option value="336">14 days</option>
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={gen.includeFair} onChange={e => setGen(g => ({ ...g, includeFair: e.target.checked }))} /> Include markets with no bookmaker price (corners, cards, etc. use the model's fair price)</label>
        </div>
        <button className="btn primary" onClick={generateSlip} disabled={running || !data.fixtures.length}>Generate slip</button>
        {genMsg && <p className="muted small gen-msg">{genMsg}</p>}
      </div>

      <div className="layout">
        <div className="col">
          <div className="filters">
            <div className="chips">
              <button className={`chip ${comp === 'ALL' ? 'on' : ''}`} onClick={() => setComp('ALL')}>All leagues</button>
              {data.comps.map(c => <button key={c.code} className={`chip ${comp === c.code ? 'on' : ''}`} onClick={() => setComp(c.code)}>{c.name}</button>)}
            </div>
            <div className="filter-row">
              <label className="search"><Search size={15} /><input placeholder="Search a team" value={query} onChange={e => setQuery(e.target.value)} /></label>
              <label className="check"><input type="checkbox" checked={valueOnly} onChange={e => setValueOnly(e.target.checked)} /> Only where the model disagrees with the price ({valueCount} markets, edge ≥ {(data.settings.minEdge * 100).toFixed(0)}%)</label>
            </div>
          </div>

          {!days.length && data.phase !== 'running' && <div className="card muted">{data.fixtures.length ? 'No fixtures match these filters.' : 'No upcoming fixtures loaded yet.'}</div>}

          {days.map(day => (
            <section key={day.label}>
              <h2 className="day">{day.label}</h2>
              {day.items.map(fx => {
                const isOpen = open[fx.id];
                const groups = [...new Set(fx.markets.map(m => m.group))];
                const best = fx.markets.filter(m => m.recommended).sort((a, b) => b.edge - a.edge)[0];
                return (
                  <article className="fx" key={fx.id}>
                    <header>
                      <span className="league">{fx.compName}</span>
                      {fx.live ? <span className="live">LIVE {fx.clock || ''}</span> : <span className="ko">{timeOf(fx.date)}</span>}
                    </header>
                    <h3>{fx.home} <span className="vs">{fx.live && fx.score ? `${fx.score[0]} - ${fx.score[1]}` : 'v'}</span> {fx.away}</h3>
                    {fx.live && <p className="muted">In play. Pre-match markets are hidden once a game has kicked off.</p>}
                    {!fx.live && !fx.prediction && <p className="muted">Not enough recent results to model this match.</p>}
                    {fx.prediction && !fx.live && <>
                      <div className="bar" aria-label="Model win probabilities">
                        <i className="h" style={{ width: `${fx.prediction.home * 100}%` }} />
                        <i className="d" style={{ width: `${fx.prediction.draw * 100}%` }} />
                        <i className="a" style={{ width: `${fx.prediction.away * 100}%` }} />
                      </div>
                      <div className="bar-legend"><span>{pct(fx.prediction.home)} home</span><span>{pct(fx.prediction.draw)} draw</span><span>{pct(fx.prediction.away)} away</span></div>
                      <p className="muted small">Expected goals {fx.prediction.expectedGoals[0].toFixed(2)} – {fx.prediction.expectedGoals[1].toFixed(2)} · likeliest scores {fx.prediction.correctScores.slice(0, 3).map(s => `${s.score} (${pct(s.p)})`).join(', ')}
                        {fx.prediction.expectedCorners ? ` · expected corners ${fx.prediction.expectedCorners[0].toFixed(1)} – ${fx.prediction.expectedCorners[1].toFixed(1)}` : ''}
                        {fx.prediction.expectedCards ? ` · expected cards ${fx.prediction.expectedCards[0].toFixed(1)} – ${fx.prediction.expectedCards[1].toFixed(1)}` : ''}</p>
                      {best && <p className="best">Biggest model-vs-price gap: <b>{best.label}</b> @ {best.odds.toFixed(2)} ({best.oddsSource}, edge +{(best.edge * 100).toFixed(1)}%)</p>}
                      {!fx.hasOdds && <p className="muted small">No bookmaker odds listed for this game yet (they usually appear a few days before kick-off). Model probabilities and fair prices are still shown.</p>}
                      <button className="link" onClick={() => setOpen(o => ({ ...o, [fx.id]: !isOpen }))}>
                        {isOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />} {isOpen ? 'Hide markets' : `All markets (${fx.markets.length})`}
                      </button>
                      {isOpen && groups.map(g => (
                        <div className="market" key={g}>
                          <h4>{g}</h4>
                          {fx.markets.filter(m => m.group === g).map(m => {
                            const on = slip.some(s => s.key === `${fx.id}:${m.key}`);
                            return (
                              <button key={m.key} className={`row ${on ? 'on' : ''} ${m.recommended ? 'rec' : ''}`} onClick={() => toggle(fx, m)}>
                                <span className="r-label">{on && <Check size={13} />} {m.label}</span>
                                <span className="r-odds">{m.odds != null ? m.odds.toFixed(2) : <em title="No bookmaker price; this is the model's fair price">fair {m.fairOdds.toFixed(2)}</em>}</span>
                                <span className="r-meta">model {pct(m.modelProb)}{m.marketProb != null ? ` · market ${pct(m.marketProb)}` : ''}</span>
                                <span className={`r-edge ${m.edge == null ? '' : m.edge >= 0 ? 'pos' : 'neg'}`}>{m.edge == null ? '' : `${m.edge >= 0 ? '+' : ''}${(m.edge * 100).toFixed(1)}%`}</span>
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </>}
                  </article>
                );
              })}
            </section>
          ))}
        </div>

        <aside className="card slip">
          <div className="slip-head"><div><div className="kicker">YOUR SLIP</div><h3>{slip.length} selection{slip.length === 1 ? '' : 's'}</h3></div>
            <button className="icon" onClick={() => setSlip([])} disabled={!slip.length} aria-label="Clear slip"><Trash2 size={16} /></button></div>
          {!slip.length && <p className="muted">Use the generator, or open a match and tap any market. One selection per match.</p>}
          {slip.map(s => <div className="slip-row" key={s.key}>
            <div>
              <b>{s.label}</b><small>{s.match}</small>{s.why && <small>{s.why}</small>}
              <small className={s.fair ? 'fairtag' : ''}>{s.fair ? 'Estimated price: replace it with the real odds you see at your bookmaker. ' : ''}Worth taking only if the real price is at least {(1 / s.prob).toFixed(2)}.</small>
            </div>
            <input className="leg-odds" inputMode="decimal" aria-label="Odds" value={s.oddsText} onChange={e => setLegOdds(s.key, e.target.value)} />
          </div>)}
          {slipStats && <>
            <div className="sum"><span>Combined odds</span><b>{slipStats.odds.toFixed(2)}</b></div>
            <div className="sum"><span>Estimated chance all win</span><b>{pct(slipStats.prob)}</b></div>
            <div className="sum"><label htmlFor="stake">Stake</label><input id="stake" inputMode="decimal" value={stake} onChange={e => setStake(e.target.value)} /></div>
            <div className="sum"><span>Return if it wins</span><b>{slipStats.ret.toFixed(2)}</b></div>
            <div className="sum"><span>Expected value (model)</span><b className={slipStats.expected >= 0 ? 'pos' : 'neg'}>{slipStats.expected >= 0 ? '+' : ''}{slipStats.expected.toFixed(2)}</b></div>
            {slip.length > 3 && <p className="muted small">Each extra leg multiplies the risk; estimate errors compound across legs.</p>}
            <button className="btn" onClick={copySlip}><Copy size={15} /> {copied ? 'Copied' : 'Copy slip'}</button>
          </>}
        </aside>
      </div>

      <details className="card backtest" onToggle={e => { if (e.currentTarget.open) loadBacktest(); }}>
        <summary>How accurate has the model been? (backtest)</summary>
        <p className="muted">Walk-forward on finished matches: each match is predicted using only earlier results. Profit is not reported because free historical bookmaker odds are not available, and a profit figure without real odds would be made up.</p>
        {!btEntries.length && <p className="muted">{btLoading ? 'Running the backtest, this takes a few seconds…' : 'Data loads after the first refresh.'}</p>}
        {btEntries.map(([name, b]) => (
          <div className="bt" key={name}>
            <h4>{name} · {b.n.toLocaleString()} matches</h4>
            <div className="bt-grid">
              <div><span>Top pick correct</span><b>{pct(b.accuracyTopPick)}</b></div>
              <div><span>Log loss (lower is better)</span><b>{b.logLoss.toFixed(3)} <small>vs {b.logLossBaseline.toFixed(3)} baseline</small></b></div>
              <div><span>Brier score (lower is better)</span><b>{b.brier.toFixed(3)} <small>vs {b.brierBaseline.toFixed(3)} baseline</small></b></div>
            </div>
            <table><thead><tr><th>Model said</th><th>Times</th><th>Avg predicted</th><th>Actually happened</th></tr></thead>
              <tbody>{b.calibration.map(c => <tr key={c.range}><td>{c.range}</td><td>{c.n}</td><td>{pct(c.predicted)}</td><td>{pct(c.actual)}</td></tr>)}</tbody></table>
            <p className="muted small">Win rate if you backed every outcome rated at least: {b.thresholds.map(t => `${Math.round(t.threshold * 100)}% → ${t.winRate == null ? 'n/a' : pct(t.winRate)} (${t.bets} bets)`).join(' · ')}. These are win rates before odds and say nothing about profit.</p>
          </div>
        ))}
        <h4 className="bt-sub">Goals, corners and cards over/under lines</h4>
        <p className="muted small">Every over/under probability the model gave in the backtest, grouped by how likely it said the event was, against how often it really happened. Corner and card probabilities are corrected for the over-confidence this test found (corners {bt?.temps?.corners ?? '–'}, cards {bt?.temps?.cards ?? '–'}; 1.00 = no correction). Card counts here are yellow plus red cards shown; bookmakers may count bookings differently, so check their rules.</p>
        <div className="tot-grid">
          {[['goals', 'Goals'], ['corners', 'Corners'], ['cards', 'Cards']].filter(([k]) => bt?.totals?.[k]?.calibration?.length).map(([k, label]) => (
            <div key={k}>
              <h4>{label} · {bt.totals[k].n.toLocaleString()} predictions</h4>
              <table><thead><tr><th>Model said</th><th>Times</th><th>Happened</th></tr></thead>
                <tbody>{bt.totals[k].calibration.map(c => <tr key={c.range}><td>{c.range}</td><td>{c.n.toLocaleString()}</td><td className={Math.abs(c.actual - c.predicted) > 0.05 ? 'neg' : ''}>{pct(c.actual)}</td></tr>)}</tbody></table>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
