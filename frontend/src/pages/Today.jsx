// Today: the investigator's home. Answers "what needs me right now?" first,
// then offers one-click paths into work. Data: GET /api/agent/inbox.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getInbox, getRole, reviewDecision } from '../api';
import { Button, Card, EmptyState, Pill, SectionHeader, Stat } from '../components/ui';
import { formatUsd } from '../format';

const INTRO_KEY = 'rudra_today_intro_dismissed';

const VERDICT = {
  ESCALATE: ['orange', 'Escalate'],
  REVIEW: ['yellow', 'Review'],
  CLEAR_RECOMMENDED: ['lime', 'Clear recommended'],
  UNCERTAIN: ['gray', 'Uncertain'],
};

const ACTION = {
  escalate: 'Escalate to a case',
  draft_str: 'File an STR draft',
  monitor: 'Put on enhanced monitoring',
  request_edd: 'Request enhanced due diligence',
  close: 'Close',
  clear: 'Clear',
};

const SEVERITY_TONE = { CRITICAL: 'orange', HIGH: 'yellow', MEDIUM: 'gray', LOW: 'gray' };

function readDismissed() {
  try {
    return localStorage.getItem(INTRO_KEY) === '1';
  } catch {
    return false;
  }
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Date.now() / 1000 - Number(ts));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  if (h >= 17 && h < 22) return 'Good evening';
  return 'Working late';
}

const num = (n) => Number(n || 0).toLocaleString('en-IN');

function VerdictPill({ verdict, status }) {
  if (!verdict) return <Pill tone="gray">{status === 'running' ? 'Running' : 'No verdict'}</Pill>;
  const [tone, label] = VERDICT[verdict] || ['gray', verdict];
  return <Pill tone={tone}>{label}</Pill>;
}

function HowItWorks({ onDismiss }) {
  const steps = [
    ['Ask', 'Type a question or pick an incident - "Investigate incident INC-2749".'],
    ['The agent follows the money', 'It walks the transaction graph hop by hop and records every finding with its evidence.'],
    ['You decide', 'It only proposes. A supervisor approves or rejects, and the case audit log records it.'],
  ];
  return (
    <Card padded={false} className="px-6 py-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wider text-gray-400">How RUDRA works</p>
        <Button variant="ghost" size="sm" onClick={onDismiss}>Got it</Button>
      </div>
      <ol className="mt-2 grid gap-4 sm:grid-cols-3">
        {steps.map(([title, body], i) => (
          <li key={title} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[11px] font-semibold text-gray-700">
              {i + 1}
            </span>
            <div>
              <p className="text-sm font-medium text-gray-900">{title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-gray-500">{body}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function DecisionRow({ d, canReview, busy, onReview, onOpen }) {
  const action = ACTION[d.action_final] || d.action_final || d.action_requested;
  const changed = d.action_requested && d.action_final && d.action_requested !== d.action_final;
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900">{action}</p>
        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-gray-600">{d.policy_rationale || 'No rationale recorded.'}</p>
        <p className="mt-1 truncate text-xs text-gray-400">
          {d.question || d.investigation_id} | {ago(d.ts)}
          {d.accounts?.length ? ` | ${d.accounts.join(', ')}${d.accounts_total > d.accounts.length ? ` +${d.accounts_total - d.accounts.length}` : ''}` : ''}
          {changed ? ` | asked for ${d.action_requested}` : ''}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canReview ? (
          <>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => onReview(d, true)}>Approve</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onReview(d, false)}>Reject</Button>
          </>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => onOpen(d.investigation_id)}>Open</Button>
      </div>
    </li>
  );
}

export default function Today() {
  const navigate = useNavigate();
  const role = getRole();
  const canReview = role === 'SUPERVISOR' || role === 'ADMIN';
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState('');
  const [introHidden, setIntroHidden] = useState(readDismissed);

  useEffect(() => {
    let live = true;
    getInbox()
      .then((d) => { if (live) { setData(d); setError(null); } })
      .catch((e) => { if (live) setError(e); });
    return () => { live = false; };
  }, [tick]);

  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  function dismissIntro() {
    setIntroHidden(true);
    try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* storage blocked */ }
  }

  const open = (id) => navigate(`/investigator?open=${encodeURIComponent(id)}`);
  const investigate = (id) => navigate(`/investigator?q=${encodeURIComponent(`Investigate incident ${id}`)}`);

  function review(d, approve) {
    setBusy(d.decision_id);
    reviewDecision(d.decision_id, approve)
      .then((r) => {
        const moved = r.cases_escalated?.length || 0;
        setNotice(approve
          ? `Approved: ${ACTION[r.action] || r.action}${moved ? ` - ${moved} case${moved === 1 ? '' : 's'} escalated` : ''}.`
          : 'Rejected. The agent will treat this as precedent next time.');
        setTick((t) => t + 1);
      })
      .catch((e) => setNotice(`Could not record the review: ${e.message}`))
      .finally(() => setBusy(null));
  }

  const roleName = role.charAt(0) + role.slice(1).toLowerCase();
  const header = (
    <div className="px-2 pt-1">
      <h1 className="text-2xl font-semibold tracking-tight text-gray-900">{greeting()}, {roleName}</h1>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">
        RUDRA watches fund flows across the bank, flags suspicious patterns, and lets an agent follow the money
        through the graph so you can decide quickly with the evidence in front of you.
      </p>
    </div>
  );

  if (error) {
    const down = String(error.message || '').includes('503');
    return (
      <div className="space-y-4 pb-6">
        {header}
        <Card>
          <EmptyState
            title={down ? 'The context graph is not running' : 'Could not reach the RUDRA backend'}
            body={down
              ? 'Today reads agent proposals and incidents from FalkorDB. Start it with "docker start rudra-falkordb" (first time: docker run -p 6379:6379 falkordb/falkordb, then python src/graphdb/falkor_loader.py --reset), then retry.'
              : `The API did not answer (${error.message}). Check that the backend is running, then retry.`}
            action={<Button onClick={() => setTick((t) => t + 1)}>Retry</Button>}
          />
        </Card>
      </div>
    );
  }

  const c = data?.counts || {};
  const pending = data?.pending_decisions || [];
  const recent = data?.recent_investigations || [];
  const incidents = data?.top_incidents || [];
  const loading = !data;

  return (
    <div className="space-y-3 pb-6">
      {header}

      {!introHidden && <HowItWorks onDismiss={dismissIntro} />}

      <Card padded={false} className="px-6 py-4">
        <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
          <Stat label="Open incidents" value={loading ? '-' : num(c.open_incidents)} />
          <Stat label="Waiting for a decision" value={loading ? '-' : num(c.pending_decisions)}
            hint={c.pending_decisions ? 'Agent proposals' : undefined} dot={c.pending_decisions ? '#f2c94c' : undefined} />
          <Stat label="Investigations this week" value={loading ? '-' : num(c.investigations_7d)} />
          <Stat label="Accounts in the graph" value={loading ? '-' : num(c.accounts)}
            hint={loading ? '' : `${num(c.transactions)} transactions`} />
        </div>
      </Card>

      {notice && (
        <div role="status" className="rounded-2xl bg-white px-5 py-3 text-sm text-gray-700">
          <span className="mr-2 inline-block h-2 w-2 rounded-full bg-lime" />{notice}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-5">
        <div className="space-y-3 lg:col-span-3">
          <Card>
            <SectionHeader
              title="Needs your decision"
              subtitle={canReview
                ? 'The agent proposed these actions. Nothing happens until you approve.'
                : 'Proposals waiting for a supervisor. Switch role to Supervisor to approve.'}
              action={pending.length ? <Pill tone="yellow">{pending.length} waiting</Pill> : null}
            />
            {loading ? (
              <p className="text-xs text-gray-400">Loading...</p>
            ) : pending.length === 0 ? (
              <EmptyState
                title="Nothing is waiting on you"
                body="When an investigation ends with a proposal - escalate, file an STR - it appears here for a supervisor to approve or reject."
              />
            ) : (
              <ul className="divide-y divide-gray-100">
                {pending.map((d) => (
                  <DecisionRow key={d.decision_id} d={d} canReview={canReview} busy={busy === d.decision_id}
                    onReview={review} onOpen={open} />
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <SectionHeader title="Recent investigations" subtitle="Open one to see its verdict, evidence and decision trail" />
            {loading ? (
              <p className="text-xs text-gray-400">Loading...</p>
            ) : recent.length === 0 ? (
              <EmptyState
                title="No investigations yet"
                body="Pick an incident on the right and press Investigate. Each run is saved to the graph with every step it took."
              />
            ) : (
              <ul className="-mx-3">
                {recent.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => open(r.id)}
                      className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-gray-50">
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-gray-900">{r.question}</span>
                        <span className="block text-xs text-gray-400">
                          {ago(r.started_at)} | {r.steps} steps{r.pending_decisions ? ` | ${r.pending_decisions} waiting` : ''}
                        </span>
                      </span>
                      <VerdictPill verdict={r.verdict} status={r.status} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card className="lg:col-span-2">
          <SectionHeader title="Start an investigation" subtitle="Largest open incidents by money moved (USD equivalent)" />
          {loading ? (
            <p className="text-xs text-gray-400">Loading...</p>
          ) : incidents.length === 0 ? (
            <EmptyState
              title="No incidents in the graph"
              body="Incidents come from the detection pipeline. Run python src/run_pipeline.py, then load the graph with scripts/load_falkor.sh."
            />
          ) : (
            <ul className="space-y-1">
              {incidents.map((inc, i) => (
                <li key={inc.incident_id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-gray-900">
                      <span className="num">{inc.incident_id}</span>
                      {inc.severity && <Pill tone={SEVERITY_TONE[inc.severity] || 'gray'}>{inc.severity.toLowerCase()}</Pill>}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-gray-500">
                      <span className="num font-medium text-gray-700">{formatUsd(inc.total_flow_usd)}</span> | {inc.pattern || 'Unclassified'} | {num(inc.accounts)} accounts
                    </p>
                  </div>
                  <Button variant={i === 0 ? 'primary' : 'secondary'} size="sm" onClick={() => investigate(inc.incident_id)}>
                    Investigate
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {!loading && incidents.length > 0 && (
            <p className="mt-4 text-xs text-gray-400">
              Or ask anything in the bar above. All {num(c.open_incidents)} incidents are on the Incidents page.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
