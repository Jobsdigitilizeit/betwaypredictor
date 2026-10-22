import * as sports from '../server/sports/service.js';

export default function handler(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ status: 'ok', service: 'pitchside-api', ...sports.state.configured });
}