import { useState } from 'react';
import { ProvChip, Chevron } from './provenance';

const ACTION_TOOLS = new Set(['record_finding', 'propose_action', 'draft_str']);

function fmt(n) {
  return Math.round(Number(n || 0)).toLocaleString('en-IN');
}

function summarise(step) {
  if (step.error) return step.error;
  const m = step.metrics || {};
  switch (step.tool) {
    case 'find_cycles':
      return m.cycle_found ? `${m.cycles} cycle(s), largest moves USD ${fmt(m.max_cycle_flow)} (USD-equivalent)` : 'No cycle found';
    case 'trace_funds':
      return step.rows ? `${m.chains} chain(s), longest ${m.trace_hops} hops ${m.direction}` : 'No onward chain';
    case 'k_hop_neighbourhood':
      return `${m.neighbours} neighbours, ${m.flagged_neighbours} flagged`;
    case 'shared_identifier_ring':
      return m.ring_size ? `Ring of ${m.ring_size} accounts` : 'No shared identifiers';
    case 'community_of':
      return `Community of ${fmt(m.community_size)}, ${((m.flagged_ratio || 0) * 100).toFixed(1)}% flagged`;
    case 'find_precedents':
      return step.rows ? `${step.rows} precedent(s)` : 'No precedent';
    case 'shortest_path':
      return m.connected ? `Path of ${m.length} hops` : 'Not connected';
    case 'record_finding': {
      const d = step.preview || {};
      const cites = d.tids_cited ? `, ${d.tids_verified}/${d.tids_cited} cited txns verified` : '';
      return `Finding recorded (${d.provenance || 'n/a'})${cites}`;
    }
    case 'propose_action':
    case 'draft_str': {
      const d = step.preview || {};
      const req = d.action_requested || step.args?.action || step.tool;
      if (d.status === 'executed' && d.executed) {
        return `${req} executed - ${d.executed.accounts_placed} account(s) on ${d.executed.watchlist}`;
      }
      return `${req} -> ${d.action_final || d.status}${d.status === 'proposed' ? ' (awaits supervisor)' : ''}`;
    }
    default:
      return `${step.rows} row${step.rows === 1 ? '' : 's'}`;
  }
}

function Step({ step }) {
  const [open, setOpen] = useState(false);
  const isAction = ACTION_TOOLS.has(step.tool);
  return (
    <li className="group">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-gray-50">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${step.error ? 'bg-red-50 text-red-600' : isAction ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'}`}>
          {step.n}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="font-mono text-[13px] font-medium text-gray-900">{step.tool}</span>
            {!isAction && <ProvChip p={step.provenance} />}
          </span>
          <span className={`block truncate text-xs ${step.error ? 'text-red-600' : 'text-gray-500'}`}>{summarise(step)}</span>
        </span>
        {step.ms > 0 && <span className="num shrink-0 font-mono text-[11px] text-gray-400">{step.ms.toFixed(1)} ms</span>}
        <Chevron open={open} />
      </button>
      {open && (
        <div className="mb-2 ml-12 mr-2 space-y-2">
          {step.args && Object.keys(step.args).length > 0 && (
            <div className="font-mono text-[11px] text-gray-500">{JSON.stringify(step.args)}</div>
          )}
          {step.cypher && (
            <pre className="max-h-64 overflow-auto rounded-xl bg-gray-900 p-3 text-[11px] leading-relaxed text-[#cfe9a8]">{step.cypher}</pre>
          )}
          {step.note && <div className="text-[11px] text-[#b0631c]">{step.note}</div>}
          {step.preview && (
            <pre className="max-h-48 overflow-auto rounded-xl bg-gray-50 p-3 text-[11px] text-gray-600">
              {JSON.stringify(step.preview, null, 1).slice(0, 2500)}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

export default function StepList({ items, running }) {
  return (
    <ol className="space-y-0.5">
      {items.map((it, i) =>
        it.type === 'thinking' ? (
          <li key={i} className="py-1.5 pl-12 pr-2 text-xs text-gray-400">{it.text}</li>
        ) : (
          <Step key={i} step={it} />
        ),
      )}
      {running && (
        <li className="flex items-center gap-3 px-2 py-2.5 text-xs text-gray-500">
          <span className="flex h-7 w-7 items-center justify-center"><span className="h-2 w-2 animate-pulse rounded-full bg-lime" /></span>
          Agent is working
        </li>
      )}
    </ol>
  );
}
