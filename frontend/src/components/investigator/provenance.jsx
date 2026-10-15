const PROV_STYLE = {
  GRAPH: 'bg-[#eef7e0] text-[#4d7a1a]',
  ML: 'bg-[#f1edfb] text-[#6a52b8]',
  RULE: 'bg-[#fdf0e2] text-[#b0631c]',
  PRECEDENT: 'bg-[#fbf6d6] text-[#86760f]',
  INFERRED: 'bg-gray-100 text-gray-600',
};

export function ProvChip({ p }) {
  if (!p) return null;
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${PROV_STYLE[p] || PROV_STYLE.INFERRED}`}>
      {p}
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
