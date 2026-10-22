import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sports from './sports/service.js';

const app = express();
const PORT = Number(process.env.PORT || 8787);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'pitchside-api', ...sports.state.configured });
});

// Every poll from the page also triggers a refresh when the data is more than an hour old.
app.get('/api/sports/state', (_req, res) => {
  sports.ensureFresh();
  res.json(sports.publicState());
});

app.get('/api/sports/backtest', async (_req, res) => {
  res.json(await sports.computeBacktest());
});

app.post('/api/sports/refresh', (_req, res) => {
  sports.refreshOnce({ force: true });
  res.json({ started: true });
});

// In production the built frontend (dist/) is served by this same process, so one service is enough.
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (fs.existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Pitchside API listening on http://localhost:${PORT}`);
  console.log(`Data: ESPN public feed (no key needed); extra Odds API prices: ${sports.state.configured.oddsApi ? 'key set' : 'off (set ODDS_API_KEY to enable)'}`);
  sports.ensureFresh();
});
