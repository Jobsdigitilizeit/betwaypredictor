import React from 'react';
import { Goal } from 'lucide-react';
import Sports from './Sports.jsx';

export default function App() {
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Pitchside home">
          <span className="mark"><Goal size={22} strokeWidth={2.3} /></span>
          <span><span className="name">PITCH<b>SIDE</b></span><span className="sub">FOOTBALL FIXTURES &amp; MARKETS</span></span>
        </a>
      </header>
      <main className="main"><Sports /></main>
      <footer className="footer">
        <p>Independent football statistics tool. Not affiliated with any bookmaker or league. Gambling involves risk; estimates do not guarantee outcomes or profit. 18+.</p>
      </footer>
    </div>
  );
}
