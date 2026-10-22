import * as sports from '../../server/sports/service.js';

// "Refresh now": re-download everything and return the new state (not cached).
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  await sports.refreshOnce({ force: true });
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(sports.publicState());
}