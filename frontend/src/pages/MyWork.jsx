// Investigator home ("My work"): what I ran, what happened to what I proposed,
// and what to pick up next. Data: GET /api/agent/my.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getMyWork } from '../api';
import { getSession } from '../auth';
import { Button, Card, EmptyState, Pill, SectionHeader, Stat } from '../components/ui';
import { formatUsd } from '../format';

const VERDICT = { ESCALATE: ['orange', 'Escalate'], REVIEW: ['yellow', 'Review'], CLEAR_RECOMMENDED: ['lime', 'Clear'], UNCERTAIN: ['gray', 'Uncertain'] };
const STATUS = { proposed: ['yellow', 'With supervisor'], approved: ['lime', 'Approved'], rejected: ['gray', 'Rejected'] };
const ACTION = { escalate: 'Escalate', draft_str: 'File an STR', open_case: 'Open a case', monitor: 'Monitor', request_edd: 'Request EDD' };
const SEVERITY_TONE = { CRITICAL: 'orange', HIGH: 'yellow', MEDIUM: 'gray', LOW: 'gray' };

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

export default function MyWork() {
  const navigate = useNavigate();
  const session = getSession() || {};
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getMyWork().then(setData).catch((e) => setError(String(e.message || e)));
  }, []);

  const open = (id) => navigate(`/investigator?open=${encodeURIComponent(id)}`);
  const investigate = (id) => navigate(`/investigator?q=${encodeURIComponent(`Investigate incident ${id}`)}`);
  const first = (session.name || '').split(' ')[0];

  if (error) {
    const down = /503/.test(error);
    return (
      <div className="space-y-3 p-2">
        <h1 className="px-2 pt-1 text-2xl font-semibold tracking-tight text-gray-900">My work</h1>
        <EmptyState title={down ? 'The graph is offline' : 'Could not load your work'}
          body={down ? 'Start FalkorDB: docker start rudra-falkordb' : error} />
      </div>
    );
  }

  const inv = data?.investigations || [];
  const props = data?.proposals || [];
  const pc = data?.proposal_counts || {};
  const incidents = data?.top_incidents || [];

  return (
    <div className="space-y-3 pb-6">
      <div className="px-2 pt-1">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">{greeting()}{first ? `, ${first}` : ''}</h1>
        <p className="mt-0.5 text-sm text-gray-500">My work</p>
      </div>

      <Card className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Stat label="My investigations" value={data ? inv.length : '-'} />
        <Stat label="With supervisor" value={data ? pc.proposed || 0 : '-'} dot={pc.proposed ? '#f2c94c' : undefined} hint={pc.proposed ? 'waiting' : undefined} />
        <Stat label="Approved" value={data ? pc.approved || 0 : '-'} />
        <Stat label="Rejected" value={data ? pc.rejected || 0 : '-'} dot={pc.rejected ? '#e8743b' : undefined} hint={pc.rejected ? 'see notes' : undefined} />
      </Card>

      <div className="grid gap-3 xl:grid-cols-5">
        <div className="space-y-3 xl:col-span-3">
          <Card>
            <SectionHeader title="My proposals" />
            {!data ? <p className="text-xs text-gray-400">Loading...</p> : props.length === 0 ? (
              <EmptyState title="No proposals yet" body="Actions the agent proposes in your investigations show up here." />
            ) : (
              <ul className="divide-y divide-gray-100">
                {props.map((p) => {
                  const [tone, label] = STATUS[p.status] || ['gray', p.status];
                  return (
                    <li key={p.decision_id}>
                      <button type="button" onClick={() => open(p.investigation_id)} className="flex w-full items-start gap-3 py-3 text-left hover:bg-gray-50">
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-gray-900">{ACTION[p.action_final] || p.action_final}</span>
                          <span className="block truncate text-xs text-gray-500">{p.question} | {ago(p.ts)}</span>
                          {p.status !== 'proposed' && (
                            <span className="mt-1 block text-xs text-gray-600">
                              {label} by {p.reviewed_by_name || p.reviewed_by_role || 'supervisor'} {ago(p.reviewed_at)}
                              {p.review_note ? <span className="text-gray-500"> - "{p.review_note}"</span> : null}
                            </span>
                          )}
                        </span>
                        <Pill tone={tone}>{label}</Pill>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <SectionHeader title="My investigations" />
            {!data ? <p className="text-xs text-gray-400">Loading...</p> : inv.length === 0 ? (
              <EmptyState title="Nothing yet" body="Start one from the list on the right." />
            ) : (
              <ul className="divide-y divide-gray-100">
                {inv.map((h) => {
                  const [tone, label] = VERDICT[h.verdict] || ['gray', h.status === 'aborted' ? 'Stopped' : 'Running'];
                  return (
                    <li key={h.id}>
                      <button type="button" onClick={() => open(h.id)} className="flex w-full items-center gap-3 py-3 text-left hover:bg-gray-50">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-gray-900">{h.question}</span>
                          <span className="block text-xs text-gray-500">{ago(h.started_at)} | {h.steps} steps</span>
                        </span>
                        <Pill tone={tone}>{label}</Pill>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        <Card className="xl:col-span-2">
          <SectionHeader title="Pick up next" subtitle="Largest by money moved (USD)" />
          {!data ? <p className="text-xs text-gray-400">Loading...</p> : (
            <ul className="divide-y divide-gray-100">
              {incidents.map((i, k) => (
                <li key={i.incident_id} className="flex items-center gap-3 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">{i.incident_id}</span>
                      <Pill tone={SEVERITY_TONE[i.severity] || 'gray'}>{String(i.severity || '').toLowerCase()}</Pill>
                    </span>
                    <span className="block truncate text-xs text-gray-500">{formatUsd(i.total_flow_usd)} | {i.pattern} | {i.accounts} accounts</span>
                  </span>
                  <Button size="sm" variant={k === 0 ? 'primary' : 'secondary'} onClick={() => investigate(i.incident_id)}>Investigate</Button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => navigate('/incidents')} className="mt-4 text-xs font-medium text-gray-500 hover:text-gray-900">
            See all incidents
          </button>
        </Card>
      </div>
    </div>
  );
}
