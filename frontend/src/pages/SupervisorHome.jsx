// Supervisor home: what is waiting for my signature, which STRs need me,
// what the team is doing, and how often the guardrails held the agent back.
// Data: GET /api/agent/oversight.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getOversight, reviewDecision } from '../api';
import { getSession } from '../auth';
import { Button, Card, EmptyState, Pill, SectionHeader, Stat } from '../components/ui';

const ACTION = {
  escalate: 'Escalate',
  draft_str: 'File an STR',
  open_case: 'Open a case',
  monitor: 'Enhanced monitoring',
  request_edd: 'Request EDD',
  close: 'Close',
  clear: 'Clear',
};

const actionLabel = (a) => ACTION[a] || a || 'Action';
const num = (n) => Number(n || 0).toLocaleString('en-IN');

function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  if (h >= 17 && h < 22) return 'Good evening';
  return 'Working late';
}

function duration(minutes) {
  const m = Math.max(0, Number(minutes || 0));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${Math.floor(m)}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

function ago(ts) {
  if (!ts) return '-';
  const s = Math.max(0, Date.now() / 1000 - Number(ts));
  if (s < 60) return 'just now';
  return `${duration(s / 60)} ago`;
}

function accountsText(d) {
  if (!d.accounts?.length) return '';
  const extra = d.accounts_total > d.accounts.length ? ` +${d.accounts_total - d.accounts.length}` : '';
  return `${d.accounts.join(', ')}${extra}`;
}

function PendingRow({ d, primary, busy, onReview }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const late = Number(d.age_minutes || 0) > 60;
  const changed = d.action_requested && d.action_final && d.action_requested !== d.action_final;
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium text-gray-900">
            {actionLabel(d.action_final || d.action_requested)}
            {changed && <Pill tone="gray">asked for {actionLabel(d.action_requested).toLowerCase()}</Pill>}
          </p>
          {d.policy_rationale && (
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-gray-500">{d.policy_rationale}</p>
          )}
          <p className="mt-1 truncate text-xs text-gray-400">
            from {d.run_by_name || 'agent'} |{' '}
            <span className={late ? 'font-medium text-[#b0631c]' : ''}>{duration(d.age_minutes)} ago</span>
            {d.question ? ` | ${d.question}` : ''}
          </p>
          {accountsText(d) && <p className="num mt-0.5 truncate text-xs text-gray-500">{accountsText(d)}</p>}
        </div>
        {!rejecting && (
          <div className="flex shrink-0 items-center gap-2">
            <Button variant={primary ? 'primary' : 'secondary'} size="sm" disabled={busy}
              onClick={() => onReview(d, true, '')}>Approve</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRejecting(true)}>Reject</Button>
          </div>
        )}
      </div>
      {rejecting && (
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(e) => { e.preventDefault(); onReview(d, false, note.trim()); }}
        >
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Reason"
            aria-label="Reason for rejecting"
            className="min-w-0 flex-1 rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none ring-1 ring-gray-200 focus:ring-gray-400"
          />
          <div className="flex shrink-0 gap-2">
            <Button type="submit" variant="secondary" size="sm" disabled={busy}>Confirm reject</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setRejecting(false); setNote(''); }}>Cancel</Button>
          </div>
        </form>
      )}
    </li>
  );
}

function OversightRow({ label, value }) {
  return (
    <li className="flex items-baseline justify-between gap-3 py-2">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="num text-sm font-semibold text-gray-900">{value}</span>
    </li>
  );
}

export default function SupervisorHome() {
  const navigate = useNavigate();
  const first = (getSession()?.name || 'Supervisor').split(/\s+/)[0];
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let live = true;
    getOversight()
      .then((d) => { if (live) { setData(d); setError(null); } })
      .catch((e) => { if (live) setError(e); });
    return () => { live = false; };
  }, [tick]);

  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const open = (id) => navigate(`/investigator?open=${encodeURIComponent(id)}`);

  function review(d, approve, note) {
    setBusy(d.decision_id);
    reviewDecision(d.decision_id, approve, note)
      .then((r) => {
        const moved = r?.cases_escalated?.length || 0;
        const label = actionLabel(r?.action || d.action_final);
        setNotice(approve
          ? `Approved: ${label}${moved ? ` - ${moved} case${moved === 1 ? '' : 's'} escalated` : ''}.`
          : `Rejected: ${label}.`);
        setTick((t) => t + 1);
      })
      .catch((e) => setNotice(`Review not recorded: ${e.message}`))
      .finally(() => setBusy(null));
  }

  const header = (
    <div className="px-2 pt-1">
      <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Approvals</h1>
      <p className="mt-0.5 text-sm text-gray-500">{greeting()}, {first}</p>
    </div>
  );

  if (error) {
    const msg = String(error.message || '');
    const forbidden = msg.includes('403');
    const down = msg.includes('503');
    return (
      <div className="space-y-4 pb-6">
        {header}
        <Card>
          <EmptyState
            title={forbidden ? 'Supervisor view' : down ? 'Context graph is not running' : 'Backend not reachable'}
            body={forbidden
              ? 'Sign in as a supervisor or admin.'
              : down
                ? 'Start FalkorDB: docker start rudra-falkordb'
                : msg}
            action={forbidden ? null : <Button onClick={() => setTick((t) => t + 1)}>Retry</Button>}
          />
        </Card>
      </div>
    );
  }

  const loading = !data;
  const c = data?.counts || {};
  const pending = [...(data?.pending || [])].sort((a, b) => Number(b.age_minutes || 0) - Number(a.age_minutes || 0));
  const strs = [...(data?.str_pending || [])].sort((a, b) => Number(b.age_minutes || 0) - Number(a.age_minutes || 0));
  const team = data?.team || [];
  const ov = data?.agent_oversight || {};
  const reviews = data?.recent_reviews || [];
  const oldest = pending[0];

  return (
    <div className="space-y-3 pb-6">
      {header}

      <Card padded={false} className="px-6 py-4">
        <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
          <Stat label="Waiting for you" value={loading ? '-' : num(c.pending_decisions ?? pending.length)}
            hint={oldest ? `oldest ${duration(oldest.age_minutes)}` : undefined}
            dot={oldest ? (Number(oldest.age_minutes) > 60 ? '#e8743b' : '#f2c94c') : undefined} />
          <Stat label="STR drafts" value={loading ? '-' : num(strs.length)} />
          <Stat label="Investigations this week" value={loading ? '-' : num(c.investigations_7d)} />
          <Stat label="Held by policy" value={loading ? '-' : num(ov.held_by_policy)} />
        </div>
      </Card>

      {notice && (
        <div role="status" className="rounded-2xl bg-white px-5 py-3 text-sm text-gray-700">
          <span className="mr-2 inline-block h-2 w-2 rounded-full bg-lime" />{notice}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <SectionHeader
            title="Waiting for your sign-off"
            subtitle={pending.length ? 'Oldest first' : null}
            action={pending.length ? <Pill tone="yellow">{pending.length} waiting</Pill> : null}
          />
          {loading ? (
            <p className="text-xs text-gray-400">Loading...</p>
          ) : pending.length === 0 ? (
            <EmptyState title="Nothing waiting" body="Agent proposals that need a signature appear here." />
          ) : (
            <ul className="divide-y divide-gray-100">
              {pending.map((d, i) => (
                <PendingRow key={d.decision_id} d={d} primary={i === 0} busy={busy === d.decision_id}
                  onReview={review} />
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-3 lg:col-span-2">
          <Card>
            <SectionHeader title="STR drafts" />
            {loading ? (
              <p className="text-xs text-gray-400">Loading...</p>
            ) : strs.length === 0 ? (
              <EmptyState title="No STR drafts" body="STR drafts proposed by the agent appear here." />
            ) : (
              <ul className="space-y-1">
                {strs.map((d) => (
                  <li key={d.decision_id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-gray-900">{d.question || d.investigation_id}</p>
                      <p className="truncate text-xs text-gray-400">
                        {d.run_by_name || 'agent'} |{' '}
                        <span className={Number(d.age_minutes) > 60 ? 'font-medium text-[#b0631c]' : ''}>
                          {duration(d.age_minutes)} ago
                        </span>
                      </p>
                    </div>
                    <Button variant="secondary" size="sm" onClick={() => open(d.investigation_id)}>Open</Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <SectionHeader title="Team this week" />
            {loading ? (
              <p className="text-xs text-gray-400">Loading...</p>
            ) : team.length === 0 ? (
              <EmptyState title="No activity this week" body="Investigations run in the last 7 days appear here." />
            ) : (
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-gray-400">
                    <th className="pb-2 font-normal">Name</th>
                    <th className="pb-2 text-right font-normal">Runs</th>
                    <th className="pb-2 text-right font-normal">Escalate</th>
                    <th className="pb-2 text-right font-normal">Last active</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {team.map((t) => (
                    <tr key={`${t.name}-${t.role}`}>
                      <td className="py-2 pr-2">
                        <span className="block truncate text-sm text-gray-900">{t.name}</span>
                        {t.role && <span className="text-[11px] text-gray-400">{String(t.role).toLowerCase()}</span>}
                      </td>
                      <td className="num py-2 text-right text-gray-900">{num(t.investigations)}</td>
                      <td className="num py-2 text-right text-gray-900">{num(t.escalate_verdicts)}</td>
                      <td className="py-2 text-right text-gray-500">{ago(t.last_active)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card>
            <SectionHeader title="Agent oversight" />
            {loading ? (
              <p className="text-xs text-gray-400">Loading...</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                <OversightRow label="Held by policy" value={num(ov.held_by_policy)} />
                <OversightRow label="Verdicts adjusted by grounding" value={num(ov.verdicts_adjusted)} />
                <OversightRow label="Confidence capped"
                  value={`${num(ov.confidence_capped)} of ${num(ov.investigations_completed)}`} />
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Card>
        <SectionHeader title="Recent decisions" />
        {loading ? (
          <p className="text-xs text-gray-400">Loading...</p>
        ) : reviews.length === 0 ? (
          <EmptyState title="No reviews yet" body="Approvals and rejections you record appear here." />
        ) : (
          <ul className="divide-y divide-gray-100">
            {reviews.map((r, i) => {
              const approved = r.review === 'APPROVES';
              return (
                <li key={`${r.investigation_id}-${r.ts}-${i}`}
                  className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm text-gray-900">
                      <Pill tone={approved ? 'lime' : 'orange'}>{approved ? 'Approved' : 'Rejected'}</Pill>
                      <span className="font-medium">{actionLabel(r.action)}</span>
                      <span className="truncate text-xs text-gray-500">
                        by {r.reviewer || 'supervisor'} | for {r.run_by_name || 'agent'}
                      </span>
                    </p>
                    {r.note && <p className="mt-0.5 truncate text-xs text-gray-400">{r.note}</p>}
                  </div>
                  <span className="shrink-0 text-xs text-gray-400">{ago(r.ts)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
