import { useState } from 'react';
import { ProvChip } from './provenance';

const VERDICT_TONE = {
  ESCALATE: { label: 'Escalate', dot: 'bg-[#e8743b]', text: 'text-gray-900' },
  REVIEW: { label: 'Review', dot: 'bg-[#f2c94c]', text: 'text-gray-900' },
  CLEAR_RECOMMENDED: { label: 'Clear (recommended)', dot: 'bg-lime', text: 'text-gray-900' },
  UNCERTAIN: { label: 'Uncertain', dot: 'bg-gray-400', text: 'text-gray-500' },
};
const STATUS_STYLE = {
  proposed: 'bg-[#fbf6d6] text-[#86760f]',
  executed: 'bg-gray-900 text-white',
  approved: 'bg-[#eef7e0] text-[#4d7a1a]',
  rejected: 'bg-gray-100 text-gray-500',
  denied: 'bg-red-50 text-red-600',
};

function Decision({ d, canReview, onReview }) {
  const [busy, setBusy] = useState(false);
  const [showDraft, setShowDraft] = useState(false);
  const act = async (approve) => {
    setBusy(true);
    try { await onReview(d.id, approve); } finally { setBusy(false); }
  };
  const changed = d.action && d.action !== d.requested;
  return (
    <li className="rounded-2xl bg-gray-50 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-gray-900">
          {d.requested}{changed ? ` -> ${d.action}` : ''}
        </span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_STYLE[d.status] || ''}`}>{d.status}</span>
        <span className="ml-auto font-mono text-[11px] text-gray-400">{d.rule}</span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-gray-500">{d.policy_rationale}</p>
      {d.review && (
        <p className="mt-1.5 text-[11px] text-gray-500">{d.review === 'APPROVES' ? 'Approved' : 'Rejected'} by {d.reviewer_role}</p>
      )}
      {d.draft && (
        <button type="button" className="mt-2 text-xs font-medium text-gray-900 underline underline-offset-2" onClick={() => setShowDraft(!showDraft)}>
          {showDraft ? 'Hide STR draft' : 'View STR draft'}
        </button>
      )}
      {showDraft && <pre className="mt-2 max-h-72 overflow-auto rounded-xl bg-white p-3 text-[10px] text-gray-600">{d.draft}</pre>}
      {d.status === 'executed' && (
        <p className="mt-1.5 text-[11px] text-gray-500">Executed by the agent (reversible). The accounts are on a watchlist in the graph.</p>
      )}
      {d.status === 'proposed' && (canReview ? (
        <div className="mt-3 flex gap-2">
          <button type="button" disabled={busy} onClick={() => act(true)} className="rounded-xl bg-gray-900 px-4 py-2 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50">Approve</button>
          <button type="button" disabled={busy} onClick={() => act(false)} className="rounded-xl bg-white px-4 py-2 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50">Reject</button>
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-gray-400">Awaiting supervisor approval. Switch role at the top right to review.</p>
      ))}
    </li>
  );
}

const LABEL = { ESCALATE: 'Escalate', REVIEW: 'Review', CLEAR_RECOMMENDED: 'Clear', UNCERTAIN: 'Uncertain' };

function Grounding({ g, final }) {
  const changed = g.adjusted || g.confidence_capped;
  return (
    <div className={`rounded-2xl p-4 text-xs ${changed ? 'bg-[#fdf0e2]' : 'bg-gray-50'}`}>
      <p className="font-medium text-gray-900">Grounded in the graph trace</p>
      <p className="mt-1 text-gray-600">
        {g.graph_findings} graph finding(s), {g.verified_tids} verified transaction(s)
        {g.unverified_tids ? `, ${g.unverified_tids} cited id(s) not found in the graph` : ''}
        {' | '}policy {g.policy_endorsed_escalation ? 'endorsed an escalation' : 'did not endorse an escalation'}
      </p>
      {changed && (
        <p className="mt-1 text-gray-700">
          The agent claimed {LABEL[g.claimed_verdict] || g.claimed_verdict} at {Math.round(g.claimed_confidence * 100)}%;
          the evidence supports {LABEL[final.verdict] || final.verdict} at {Math.round(final.confidence * 100)}% - {g.reason}.
        </p>
      )}
    </div>
  );
}

export default function VerdictCard({ verdict, summary, canReview, onReview, reviewMsg, running }) {
  if (!verdict) {
    return (
      <div className="flex h-full min-h-[220px] flex-col justify-between rounded-3xl bg-white p-6">
        <div>
          <p className="text-sm font-medium text-gray-900">Verdict</p>
          <p className="text-xs text-gray-400">Policy-gated outcome</p>
        </div>
        <p className="text-sm text-gray-400">{running ? 'Investigating...' : 'Run an investigation to see the verdict, findings and proposed actions.'}</p>
      </div>
    );
  }
  const tone = VERDICT_TONE[verdict.verdict] || VERDICT_TONE.UNCERTAIN;
  const conf = Math.round((verdict.confidence || 0) * 100);
  return (
    <div className="space-y-5 rounded-3xl bg-white p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-gray-900">Verdict</p>
          <p className="text-xs text-gray-400">{verdict.typology || 'Policy-gated outcome'}</p>
        </div>
        <span className="font-mono text-[11px] text-gray-400">{verdict.investigation_id}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className={`h-3 w-3 rounded-full ${tone.dot}`} />
        <span className={`text-4xl font-semibold tracking-tight ${tone.text}`}>{tone.label}</span>
      </div>
      <div>
        <div className="mb-1.5 flex justify-between text-xs text-gray-500">
          <span>Confidence</span><span className="num font-medium text-gray-900">{conf}%</span>
        </div>
        <div className="h-3 w-full rounded-full bg-gray-100">
          <div className="h-3 rounded-full bg-lime" style={{ width: `${conf}%` }} />
        </div>
      </div>
      {verdict.grounding && <Grounding g={verdict.grounding} final={verdict} />}
      {summary && <p className="text-sm leading-relaxed text-gray-600">{summary}</p>}
      {verdict.contradicting_evidence?.length > 0 && (
        <p className="text-xs text-gray-500"><span className="font-medium text-gray-700">Against: </span>{verdict.contradicting_evidence.join('; ')}</p>
      )}

      <div>
        <p className="mb-2 text-sm font-medium text-gray-900">Findings <span className="text-gray-400">{verdict.findings?.length || 0}</span></p>
        <ul className="space-y-2.5">
          {(verdict.findings || []).map((f) => (
            <li key={f.id} className="flex items-start gap-2.5 text-[13px] leading-snug text-gray-700">
              <ProvChip p={f.provenance} />
              <span>
                {f.claim}
                {(f.tids?.length > 0 || f.accounts?.length > 0) && (
                  <span className="ml-1 text-xs text-gray-400">
                    ({[f.tids?.length ? `${f.tids.length} txns` : null, f.accounts?.length ? `${f.accounts.length} accounts` : null].filter(Boolean).join(', ')})
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-gray-900">Proposed actions</p>
        {(verdict.decisions || []).length === 0 ? (
          <p className="text-xs text-gray-400">No action proposed.</p>
        ) : (
          <ul className="space-y-2">
            {verdict.decisions.map((d) => <Decision key={d.id} d={d} canReview={canReview} onReview={onReview} />)}
          </ul>
        )}
        {reviewMsg && <p className="mt-2 text-xs text-[#4d7a1a]">{reviewMsg}</p>}
      </div>

      {verdict.precedents?.length > 0 && (
        <p className="text-xs text-gray-500">
          <span className="font-medium text-gray-700">Precedents consulted: </span>
          {verdict.precedents.map((p) => `${p.investigation} (${p.verdict}, ${p.action} ${p.status})`).join('; ')}
        </p>
      )}
    </div>
  );
}
