import { useState } from 'react';
import { Button } from './ui';

const ICON = {
  queue: 'M4 6h16M4 12h10M4 18h7',
  trace: 'M5 19a2 2 0 100-4 2 2 0 000 4zm14-10a2 2 0 100-4 2 2 0 000 4zM12 14a2 2 0 100-4 2 2 0 000 4zM6.5 15.5l4-2.5m3-2l4-3',
  decide: 'M5 13l4 4L19 7',
};

function steps(session) {
  const supervisor = session.role !== 'INVESTIGATOR';
  return [
    { icon: 'queue', title: 'Start from Today',
      body: 'Decisions waiting on you and the incidents moving the most money, ranked in USD.' },
    { icon: 'trace', title: 'Let the agent follow the money',
      body: 'Ask about an incident. The agent traces funds hop by hop through the FalkorDB graph and cites every transaction it relies on.' },
    supervisor
      ? { icon: 'decide', title: 'You approve',
          body: 'The agent can watch accounts on its own. Escalations and STRs wait for you, and every decision is logged and remembered.' }
      : { icon: 'decide', title: 'A supervisor approves',
          body: 'The agent proposes, a supervisor decides. Nothing is escalated or filed without a person.' },
  ];
}

export default function WelcomeTour({ session, onClose }) {
  const [i, setI] = useState(0);
  const all = steps(session);
  const s = all[i];
  const last = i === all.length - 1;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" role="dialog" aria-modal="true" aria-label="Welcome">
      <div className="w-full max-w-md rounded-3xl bg-white p-8">
        <p className="text-xs font-medium text-gray-500">Welcome, {session.name.split(' ')[0]}</p>
        <div className="mt-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-ink">
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="#a6d65c" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d={ICON[s.icon]} />
          </svg>
        </div>
        <h2 className="mt-5 text-xl font-semibold tracking-tight text-gray-900">{s.title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-gray-600">{s.body}</p>
        <div className="mt-8 flex items-center justify-between">
          <div className="flex gap-1.5" aria-hidden="true">
            {all.map((_, k) => (
              <span key={k} className={`h-1.5 rounded-full transition-all ${k === i ? 'w-6 bg-ink' : 'w-1.5 bg-gray-200'}`} />
            ))}
          </div>
          <div className="flex gap-2">
            {!last && <Button variant="ghost" size="sm" onClick={onClose}>Skip</Button>}
            {i > 0 && <Button variant="secondary" size="sm" onClick={() => setI(i - 1)}>Back</Button>}
            <Button size="sm" onClick={() => (last ? onClose() : setI(i + 1))}>{last ? 'Get started' : 'Next'}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
