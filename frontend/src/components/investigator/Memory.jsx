import { Card, SectionHeader } from '../ui';
import { actionLabel } from './stepText';

const VERDICT = {
  ESCALATE: ['Escalate', '#e8743b'], REVIEW: ['Review', '#f2c94c'],
  CLEAR_RECOMMENDED: ['Clear', '#a6d65c'], UNCERTAIN: ['Uncertain', '#a3a39d'],
};

export function MemoryList({ history, onOpen, activeId, disabled }) {
  return (
    <Card>
      <SectionHeader
        title="Investigation memory"
        subtitle="Every investigation is stored in the FalkorDB graph. Click one to replay it."
        action={history.length > 0 ? <span className="text-xs text-gray-500">{history.length} total</span> : null}
      />
      {history.length === 0 ? (
        <p className="text-xs text-gray-500">Nothing yet. Finished investigations appear here and become precedents for later ones.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {history.slice(0, 8).map((h) => {
            const [vLabel, dot] = VERDICT[h.verdict] || [h.verdict || h.status, '#d2d2cd'];
            const active = h.id === activeId;
            return (
              <li key={h.id}>
                <button type="button" disabled={disabled} onClick={() => onOpen(h.id)}
                  className={`flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left disabled:opacity-50 ${active ? 'bg-gray-50' : 'hover:bg-gray-50'}`}>
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} />
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-800">{h.question}</span>
                  <span className="hidden shrink-0 text-xs text-gray-500 sm:inline">
                    {h.started_at ? new Date(h.started_at * 1000).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : ''} | {h.steps} steps
                  </span>
                  <span className="w-20 shrink-0 text-right text-xs font-medium text-gray-900">{vLabel}</span>
                  {h.pending_decisions > 0 && <span className="shrink-0 text-xs text-[#86760f]">{h.pending_decisions} pending</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function RemovalCompare({ runs }) {
  const on = runs.graph;
  const off = runs.flat;
  if (!on || !off) return null;
  const row = (r) => ({
    steps: r.steps,
    graph: (r.findings || []).filter((f) => f.provenance === 'GRAPH').length,
    verdict: VERDICT[r.verdict]?.[0] || r.verdict,
    conf: Math.round((r.confidence || 0) * 100),
    action: (r.decisions || []).map((d) => actionLabel(d.action || d.requested)).join(', ') || 'none',
  });
  const a = row(on);
  const b = row(off);
  const rows = [['Verdict', `${a.verdict} at ${a.conf}%`, `${b.verdict} at ${b.conf}%`],
    ['Graph findings', a.graph, b.graph], ['Tool calls', a.steps, b.steps], ['Actions', a.action, b.action]];
  return (
    <Card>
      <SectionHeader title="Removal test" subtitle="Same question, graph tools on vs off - what the graph adds" />
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-gray-500">
            <th className="pb-2 font-normal" />
            <th className="pb-2 font-medium text-gray-900">Graph on</th>
            <th className="pb-2 font-normal">Graph off</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map(([k, x, y]) => (
            <tr key={k}>
              <td className="py-2 text-gray-500">{k}</td>
              <td className="num py-2 font-medium text-gray-900">{x}</td>
              <td className="num py-2 text-gray-600">{y}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
