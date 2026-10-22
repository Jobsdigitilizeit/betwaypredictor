# Pitchside: football fixtures and markets

A React/Vite dashboard plus a small Node API. It lists upcoming football matches across the major European leagues and the Champions League, Europa League and Conference League, estimates probabilities for the main markets with a Poisson model, compares them with bookmaker prices, and helps you build a slip to place yourself.

It does not log in to, scrape or control any betting account. It does not predict outcomes with certainty: bookmaker prices already include a margin, so most matches have no real edge.

## Run it (no API key needed)

Requirements: Node.js 18.18+ and npm.

```powershell
npm install
npm run server      # terminal 1: downloads data and runs the analysis on start
npm run dev         # terminal 2: open http://localhost:5173
```

The analysis starts automatically when the server starts and takes about 20-30 seconds. It then refreshes every 30 minutes.

## Data sources

- **Fixtures, results, live status and prices:** ESPN's public scoreboard feed (`site.api.espn.com`). It needs no key, but it is an undocumented endpoint with no uptime guarantee, so failures are shown in the app rather than hidden. Prices there come from DraftKings (1X2 and the main goals line, for a subset of matches).
- **Optional: Odds API** (`ODDS_API_KEY`, free tier at the-odds-api.com, 500 credits/month): adds UK bookmaker prices (Betway is preferred when present) and more goal lines. Set `ODDS_EXTRA_MARKETS=1` to add both-teams-to-score and double-chance prices (costs extra credits).

## What you see

- Every upcoming match in the next 14 days (live games flagged with score and clock), grouped by day, filterable by competition and team.
- Model home/draw/away probabilities, expected goals and likeliest scores.
- Per match, about 85 markets: match result, double chance, both teams to score, total goals (0.5 to 4.5), goal ranges, team goals, total and per-team corners, total and per-team cards, and draw-no-bet fair prices. Bookmaker prices appear where available (1X2 and the main goals line); every other market shows the model's fair price.
- A slip generator that scans all of those markets, takes the most probable one per match, spreads the slip across market types, and lets you overwrite each leg's odds with the real price from your bookmaker.
- Flags where the blended probability times the offered odds beats 1 by at least `MIN_EDGE`. These mark where the model disagrees with the price, not proven value.
- A slip builder (one selection per match) with combined odds, estimated chance and expected value.
- A backtest of the model's accuracy and calibration.

## Configuration (environment variables, all optional)

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPORTS_COMPS` | all in `server/sports/espn.js` | comma list of ESPN league codes |
| `DAYS_AHEAD` | `14` | how far ahead to list fixtures |
| `HISTORY_MONTHS` | `14` | months of past results used to fit the model |
| `MIN_EDGE` | `0.04` | minimum edge to flag a market |
| `MARKET_WEIGHT` | `0.7` | weight given to the market's no-vig probability when blending |
| `ODDS_API_KEY` | off | enables Odds API prices |
| `PREFERRED_BOOKMAKER` | `betway` | Odds API bookmaker key to prefer |
| `ODDS_TTL_HOURS` | `6` | reuse Odds API prices this long to save credits |
| `ODDS_EXTRA_MARKETS` | off | `1` adds BTTS and double-chance prices |
| `EXTRA_EVENTS` | `10` | max matches per refresh for those extra prices |

## Model note

Corners and cards (yellow plus red cards shown) use the same team-strength model on those counts, with a negative-binomial spread because they vary more than goals do, and a calibration step learned from the backtest. One attack/defence model is fitted across all competitions on the last 14 months of finished 90-minute results, weighting recent matches more and shrinking each team toward the average. European fixtures link the leagues, which makes ratings roughly comparable between countries. Goals are modelled as independent Poisson, which gives every market from one score grid. Teams with too little recent history (for example clubs from leagues not loaded) are not modelled. The model is blended with the market's no-vig probability, because the market is usually better informed than a simple model.

The backtest predicts each past match using only earlier results and reports accuracy and calibration. It cannot report profit, because free historical odds do not exist.

## Deploy on Vercel

1. Put the project folder (the one containing `package.json`, `api/`, `server/`, `src/` and `vercel.json`) in a GitHub repo.
2. On vercel.com choose Add New -> Project, import the repo, and keep the detected Vite settings. No environment variables are required. `ODDS_API_KEY` is optional.
3. Deploy.

How it works on Vercel: the site is static, and `api/` holds serverless functions. `/api/sports/state` downloads the data and runs the analysis when its cached copy is stale (about 20 seconds), and Vercel's CDN then serves the result for 15 minutes and refreshes it in the background, so most visitors get an instant response. Only the visitor who triggers a cold refresh waits. The backtest runs on demand when that section is opened. Functions are allowed 60 seconds (`vercel.json`), which is the Hobby plan limit.

Limits to know: the data lives in each function instance's memory, so a cold start re-downloads everything, and the in-page "Refresh now" button re-runs the analysis for that request only.

## Build for deployment (any static host or Node host)

```powershell
npm run build
```

The static output is in `dist/`. The Node API in `server/` is a separate service.
