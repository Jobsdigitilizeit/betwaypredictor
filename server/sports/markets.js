// Market catalogue shared by the server (which builds markets) and the browser (which rebuilds the
// labels from a compact payload). Pure functions only: no Node or browser APIs.

export const pointKey = pt => String(Math.round(pt * 10));

export const DNB_GROUP = 'Draw no bet (fair price only)';

// Returns [group, key, label] for every market the model can price for this fixture.
export function marketList(fx) {
  const list = [
    ['Match result', 'home', `${fx.home} to win`], ['Match result', 'draw', 'Draw'], ['Match result', 'away', `${fx.away} to win`],
    ['Double chance', 'dc1x', `${fx.home} or draw`], ['Double chance', 'dcx2', `${fx.away} or draw`], ['Double chance', 'dc12', 'Either team wins'],
    ['Both teams to score', 'bttsYes', 'Yes'], ['Both teams to score', 'bttsNo', 'No']
  ];
  for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
    const k = pointKey(line);
    list.push(['Total goals', `over${k}`, `Over ${line} goals`], ['Total goals', `under${k}`, `Under ${line} goals`]);
  }
  list.push(['Goal range', 'gr13', '1 to 3 goals'], ['Goal range', 'gr24', '2 to 4 goals'], ['Goal range', 'gr23', '2 or 3 goals']);
  for (const [p, name] of [['hg', fx.home], ['ag', fx.away]]) {
    list.push(
      ['Team goals', `${p}o05`, `${name} over 0.5 goals`], ['Team goals', `${p}u05`, `${name} under 0.5 goals`],
      ['Team goals', `${p}o15`, `${name} over 1.5 goals`], ['Team goals', `${p}u15`, `${name} under 1.5 goals`]
    );
  }
  for (const line of [7.5, 8.5, 9.5, 10.5, 11.5, 12.5]) {
    const k = pointKey(line);
    list.push(['Corners', `co${k}`, `Over ${line} corners`], ['Corners', `cu${k}`, `Under ${line} corners`]);
  }
  for (const [side, name] of [['h', fx.home], ['a', fx.away]]) {
    for (const line of [2.5, 3.5, 4.5, 5.5, 6.5]) {
      const k = pointKey(line);
      list.push(['Team corners', `${side}co${k}`, `${name} over ${line} corners`], ['Team corners', `${side}cu${k}`, `${name} under ${line} corners`]);
    }
  }
  for (const line of [1.5, 2.5, 3.5, 4.5, 5.5, 6.5]) {
    const k = pointKey(line);
    list.push(['Cards', `ko${k}`, `Over ${line} cards`], ['Cards', `ku${k}`, `Under ${line} cards`]);
  }
  for (const [side, name] of [['h', fx.home], ['a', fx.away]]) {
    for (const line of [0.5, 1.5, 2.5]) {
      const k = pointKey(line);
      list.push(['Team cards', `${side}ko${k}`, `${name} over ${line} cards`], ['Team cards', `${side}ku${k}`, `${name} under ${line} cards`]);
    }
  }
  list.push(
    [DNB_GROUP, 'dnbHome', `${fx.home} (draw no bet)`],
    [DNB_GROUP, 'dnbAway', `${fx.away} (draw no bet)`]
  );
  return list;
}

const r4 = v => (v == null ? null : Math.round(v * 10000) / 10000);
const r2 = v => (v == null ? null : Math.round(v * 100) / 100);

// Full market objects -> compact rows [key, modelProb, prob, odds, source, marketProb, edge, fairOdds]
export function packMarkets(markets) {
  return markets.map(m => [m.key, r4(m.modelProb), r4(m.prob), m.odds, m.oddsSource, r4(m.marketProb), r4(m.edge), r2(m.fairOdds)]);
}

// Compact rows -> full market objects (labels and groups rebuilt from the catalogue).
export function unpackMarkets(fx, rows, minEdge) {
  const info = new Map(marketList(fx).map(([group, key, label]) => [key, { group, label }]));
  return (rows || []).flatMap(([key, modelProb, prob, odds, oddsSource, marketProb, edge, fairOdds]) => {
    const meta = info.get(key);
    if (!meta) return [];
    return [{
      key, group: meta.group, label: meta.label, modelProb, prob, odds, oddsSource, marketProb, edge, fairOdds,
      recommended: edge != null && edge >= minEdge
    }];
  });
}
