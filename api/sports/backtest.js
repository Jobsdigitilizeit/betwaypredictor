import * as sports from '../../server/sports/service.js';

// The backtest is slow, so it runs only when someone opens that section; the CDN keeps it for a day.
export default async function handler(_req, res) {
  const result = await sports.computeBacktest();
  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=86400');
  res.status(200).json(result);
}