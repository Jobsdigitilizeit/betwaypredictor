import * as sports from '../../server/sports/service.js';

// Runs the analysis when the cached copy is stale. Vercel's CDN keeps the response for 15 minutes and
// serves it instantly (refreshing in the background for up to an hour), so visitors rarely wait.
export default async function handler(_req, res) {
  await sports.refreshIfStale();
  const body = sports.publicState();
  res.setHeader('Cache-Control', body.phase === 'error' ? 'no-store' : 'public, s-maxage=900, stale-while-revalidate=3600');
  res.status(200).json(body);
}