import { Pill } from '../ui';

// Where a claim comes from: GRAPH (traversal / algorithm), RULE (detector),
// ML (model score), PRECEDENT (an earlier human decision), INFERRED (agent).
const TONE = { GRAPH: 'lime', RULE: 'orange', PRECEDENT: 'yellow', INFERRED: 'gray' };
const PROV_HINT = {
  GRAPH: 'From a graph traversal or algorithm',
  RULE: 'From a detection rule',
  ML: 'From an ML model score',
  PRECEDENT: 'From an earlier human decision',
  INFERRED: 'Inferred by the agent',
};

export function ProvChip({ p }) {
  if (!p) return null;
  if (p === 'ML') {
    return (
      <span title={PROV_HINT.ML} className="inline-flex shrink-0 items-center rounded-full bg-[#f1edfb] px-2.5 py-0.5 text-[11px] font-medium text-[#6a52b8]">
        ML
      </span>
    );
  }
  return (
    <span title={PROV_HINT[p] || ''} className="inline-flex shrink-0">
      <Pill tone={TONE[p] || 'gray'}>{p}</Pill>
    </span>
  );
}

export function Chevron({ open }) {
  return (
    <svg className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 5l5 5-5 5" />
    </svg>
  );
}
