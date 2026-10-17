import { Card } from '../ui';
import EvidenceGraph from './EvidenceGraph';
import { PHASES, currentPhase, stepSentence, withPhases } from './stepText';

const LIVE_LINES = 9;

function PhaseStrip({ active }) {
  const idx = PHASES.findIndex(([k]) => k === active);
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {PHASES.map(([key, label], i) => {
        const state = i < idx ? 'done' : i === idx ? 'now' : 'next';
        return (
          <li key={key} className="flex items-center gap-2">
            {i > 0 && <span className="text-gray-300">-&gt;</span>}
            <span className={`flex items-center gap-1.5 ${state === 'now' ? 'font-medium text-gray-900' : state === 'done' ? 'text-gray-600' : 'text-gray-400'}`}>
              <span className={`h-2 w-2 rounded-full ${state === 'now' ? 'animate-pulse bg-gray-900' : state === 'done' ? 'bg-lime' : 'bg-gray-200'}`} />
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// Shown only while an investigation streams; the verdict replaces it.
export default function ProgressCard({ items, mcp, seconds, subgraph }) {
  const phase = currentPhase(items);
  const phaseName = PHASES.find(([k]) => k === phase)?.[2] || 'Working';
  const lines = withPhases(items);
  const steps = lines.filter((l) => l.type === 'step').length;
  const shown = lines.slice(-LIVE_LINES);
  const hidden = lines.length - shown.length;
  const brain = mcp ? `${{ llm: 'Claude', gemini: 'Gemini', playbook: 'Playbook autopilot' }[mcp.mode] || mcp.mode}${mcp.model ? ` (${mcp.model})` : ''}` : '';

  return (
    <Card>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <p className="text-xs text-gray-500">Investigating{brain ? ` with ${brain}` : ''}</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight text-gray-900">{phaseName}...</p>
            </div>
            <p className="num shrink-0 text-xs text-gray-500">{steps} step{steps === 1 ? '' : 's'} | {seconds}s</p>
          </div>
          <div className="mt-4"><PhaseStrip active={phase} /></div>
          <ol className="mt-5 space-y-2.5" aria-live="polite">
            {hidden > 0 && <li className="text-xs text-gray-400">{hidden} earlier line{hidden === 1 ? '' : 's'}</li>}
            {shown.length === 0 && <li className="text-sm text-gray-500">Connecting to the graph tools...</li>}
            {shown.map((it, i) => (it.type === 'thinking' ? (
              <li key={`t${hidden + i}`} className="pl-5 text-xs italic leading-relaxed text-gray-500">{it.text}</li>
            ) : (
              <li key={`s${hidden + i}`} className="flex gap-2.5 text-sm leading-snug text-gray-800">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${i === shown.length - 1 ? 'animate-pulse bg-gray-900' : 'bg-gray-300'}`} />
                <span className={it.error ? 'text-red-600' : ''}>{stepSentence(it)}</span>
              </li>
            )))}
          </ol>
        </div>
        <div className="lg:col-span-2">
          <p className="mb-2 text-xs text-gray-500">Evidence so far</p>
          <EvidenceGraph data={subgraph} height={300} compact />
        </div>
      </div>
    </Card>
  );
}
