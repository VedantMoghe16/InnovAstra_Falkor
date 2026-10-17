import { useState } from 'react';
import { Button, Card, Disclosure, Pill } from '../ui';
import { ProvChip } from './provenance';
import { actionLabel } from './stepText';

const VERDICT = {
  ESCALATE: { label: 'Escalate', dot: '#e8743b', bar: '#e8743b', means: 'Strong, policy-endorsed evidence of laundering. Send it up.' },
  REVIEW: { label: 'Review', dot: '#f2c94c', bar: '#f2c94c', means: 'Suspicious, but not enough for an escalation yet. A person should look.' },
  CLEAR_RECOMMENDED: { label: 'Clear', dot: '#a6d65c', bar: '#a6d65c', means: 'The graph shows no laundering pattern. A person must confirm before closing.' },
  UNCERTAIN: { label: 'Uncertain', dot: '#a3a39d', bar: '#a3a39d', means: 'Not enough evidence either way.' },
};
const label = (v) => VERDICT[v]?.label || v;
const pct = (x) => `${Math.round(Number(x || 0) * 100)}%`;

function groundingSentence(g, v) {
  if (!g) return null;
  if (g.adjusted || g.confidence_capped) {
    return `The agent said ${label(g.claimed_verdict)} at ${pct(g.claimed_confidence)}; the evidence supports ${label(v.verdict)} at ${pct(v.confidence)} because ${g.reason || 'the trace does not back the claim'}.`;
  }
  if (!g.graph_findings) return 'No graph finding backs this yet - treat it as a lead, not a conclusion.';
  const f = `${g.graph_findings} graph finding${g.graph_findings === 1 ? '' : 's'}`;
  const t = `${g.verified_tids} verified transaction${g.verified_tids === 1 ? '' : 's'}`;
  return `Backed by ${f} and ${t}${g.policy_endorsed_escalation ? ', and the policy endorsed the escalation' : ''}.`;
}

const STATUS_TONE = { proposed: 'yellow', executed: 'dark', approved: 'lime', rejected: 'gray', denied: 'red' };

function Decision({ d, canReview, onReview }) {
  const [busy, setBusy] = useState(false);
  const act = async (approve) => {
    setBusy(true);
    try { await onReview(d.id, approve); } finally { setBusy(false); }
  };
  const changed = d.action && d.requested && d.action !== d.requested;

  if (d.status === 'executed') {
    return (
      <li className="py-2.5 text-xs leading-relaxed text-gray-500">
        <span className="font-medium text-gray-700">Done: {actionLabel(d.action || d.requested)}</span>
        {' '}- the agent did this itself (reversible); the accounts are on a watchlist in the graph.
      </li>
    );
  }
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-gray-900">{actionLabel(d.action || d.requested)}</span>
        <Pill tone={STATUS_TONE[d.status] || 'gray'}>{d.status === 'proposed' ? 'needs approval' : d.status}</Pill>
        {changed && <span className="text-xs text-gray-500">agent asked for {actionLabel(d.requested)}</span>}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-gray-500">{d.policy_rationale}</p>
      {d.review && (
        <p className="mt-1 text-xs text-gray-500">{d.review === 'APPROVES' ? 'Approved' : 'Rejected'} by {d.reviewer_role}</p>
      )}
      {d.draft && (
        <div className="mt-2">
          <Disclosure label="View STR draft">
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-gray-50 p-3 text-[11px] text-gray-600">{d.draft}</pre>
          </Disclosure>
        </div>
      )}
      {d.status === 'proposed' && (canReview ? (
        <div className="mt-3 flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => act(true)}>Approve</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(false)}>Reject</Button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-gray-500">Waiting for a supervisor. Switch role at the top right to review.</p>
      ))}
    </li>
  );
}

const cleanClaim = (c) => String(c || '').replace('[auto-recorded from tool output] ', '');
const FINDINGS_SHOWN = 5;

function Finding({ f }) {
  const claim = cleanClaim(f.claim);
  const meta = [f.tids?.length ? `${f.tids.length} transaction${f.tids.length === 1 ? '' : 's'}` : null,
    f.accounts?.length ? `${f.accounts.length} account${f.accounts.length === 1 ? '' : 's'}` : null,
    f.unverified_tids?.length ? `${f.unverified_tids.length} cited id(s) not in the graph` : null,
    claim !== f.claim ? 'auto-recorded from tool output' : null].filter(Boolean).join(' | ');
  return (
    <li className="flex gap-3 py-2.5">
      <div className="w-[76px] shrink-0 pt-0.5"><ProvChip p={f.provenance} /></div>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug text-gray-800">{claim}</p>
        {meta && <p className="mt-0.5 text-xs text-gray-500">{meta}</p>}
      </div>
    </li>
  );
}

function EvidenceIds({ findings }) {
  const cited = findings.filter((f) => f.tids?.length || f.accounts?.length || f.alert_ids?.length);
  if (!cited.length) return null;
  return (
    <Disclosure label="Show evidence">
      <ul className="space-y-2 rounded-2xl bg-gray-50 p-3 font-mono text-[11px] leading-relaxed text-gray-600">
        {cited.map((f) => (
          <li key={f.id}>
            <span className="text-gray-400">{f.id}</span>
            {f.tids?.length > 0 && <span> | tids {f.tids.join(', ')}</span>}
            {f.accounts?.length > 0 && <span> | accounts {f.accounts.join(', ')}</span>}
            {f.alert_ids?.length > 0 && <span> | alerts {f.alert_ids.join(', ')}</span>}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

function Findings({ findings }) {
  if (findings.length === 0) return <p className="mt-2 text-xs text-gray-500">The agent recorded no findings.</p>;
  const order = { GRAPH: 0, RULE: 1, ML: 2, PRECEDENT: 3, INFERRED: 4 };
  const sorted = [...findings].sort((a, b) => (order[a.provenance] ?? 5) - (order[b.provenance] ?? 5));
  const head = sorted.slice(0, FINDINGS_SHOWN);
  const rest = sorted.slice(FINDINGS_SHOWN);
  return (
    <>
      <ul className="divide-y divide-gray-100">{head.map((f) => <Finding key={f.id} f={f} />)}</ul>
      <div className="mt-2 flex flex-col gap-2">
        {rest.length > 0 && (
          <Disclosure label={`Show ${rest.length} more finding${rest.length === 1 ? '' : 's'}`}>
            <ul className="divide-y divide-gray-100">{rest.map((f) => <Finding key={f.id} f={f} />)}</ul>
          </Disclosure>
        )}
        <EvidenceIds findings={sorted} />
      </div>
    </>
  );
}

export default function VerdictCard({ verdict, summary, canReview, onReview, reviewMsg, graphOff = false }) {
  if (!verdict) return null;
  const tone = VERDICT[verdict.verdict] || VERDICT.UNCERTAIN;
  const conf = Math.round((verdict.confidence || 0) * 100);
  const g = verdict.grounding;
  const adjusted = g && (g.adjusted || g.confidence_capped);
  const rank = { proposed: 0, approved: 1, rejected: 1, denied: 2, executed: 3 };
  const decisions = [...(verdict.decisions || [])].sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2));
  const pending = decisions.filter((d) => d.status === 'proposed').length;
  const findings = verdict.findings || [];

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="text-xs text-gray-500">Verdict{verdict.typology ? ` | ${verdict.typology}` : ''}{graphOff ? ' | graph tools were off for this run' : ''}</p>
          <div className="mt-1 flex items-center gap-3">
            <span className="h-3.5 w-3.5 rounded-full" style={{ background: tone.dot }} />
            <span className="text-4xl font-semibold tracking-tight text-gray-900" data-testid="verdict-label">{tone.label}</span>
          </div>
          <p className="mt-1 text-xs text-gray-500">{tone.means}</p>
        </div>
        <div className="w-full max-w-xs">
          <div className="mb-1.5 flex items-baseline justify-between text-xs text-gray-500">
            <span>Confidence</span><span className="num text-lg font-semibold text-gray-900">{conf}%</span>
          </div>
          <div className="h-2.5 w-full rounded-full bg-gray-100">
            <div className="h-2.5 rounded-full" style={{ width: `${conf}%`, background: tone.bar }} />
          </div>
          <p className="mt-1.5 text-right font-mono text-[11px] text-gray-400">{verdict.investigation_id}</p>
        </div>
      </div>

      {g && (
        <div className={`mt-5 rounded-2xl px-4 py-3 text-sm leading-relaxed ${adjusted ? 'bg-[#fdf0e2] text-gray-800' : 'bg-gray-50 text-gray-700'}`}>
          {groundingSentence(g, verdict)}
          {g.notes?.length > 0 && <p className="mt-1 text-xs text-gray-500">Note: {g.notes.join('; ')}.</p>}
        </div>
      )}

      {summary && <p className="mt-4 max-w-4xl text-sm leading-relaxed text-gray-600">{summary}</p>}
      {verdict.contradicting_evidence?.length > 0 && (
        <p className="mt-2 text-xs text-gray-500"><span className="font-medium text-gray-700">Against: </span>{verdict.contradicting_evidence.join('; ')}</p>
      )}

      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <p className="text-sm font-semibold text-gray-900">Findings <span className="font-normal text-gray-400">{findings.length}</span></p>
          <Findings findings={findings} />
        </div>
        <div className="lg:col-span-2">
          <p className="text-sm font-semibold text-gray-900">
            Proposed actions {pending > 0 && <span className="font-normal text-[#86760f]">{pending} need{pending === 1 ? 's' : ''} approval</span>}
          </p>
          {decisions.length === 0 ? (
            <p className="mt-2 text-xs leading-relaxed text-gray-500">No action proposed. The verdict stands as advice; nothing changes until a person acts.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {decisions.map((d) => <Decision key={d.id} d={d} canReview={canReview} onReview={onReview} />)}
            </ul>
          )}
          {reviewMsg && <p className="mt-2 text-xs text-[#4d7a1a]">{reviewMsg}</p>}
          {verdict.precedents?.length > 0 && (
            <p className="mt-4 text-xs text-gray-500">
              <span className="font-medium text-gray-700">Precedents consulted: </span>
              {verdict.precedents.map((p) => `${p.investigation} (${p.verdict}, ${p.action} ${p.status})`).join('; ')}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
