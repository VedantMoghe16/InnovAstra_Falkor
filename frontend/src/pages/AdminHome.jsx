// Admin home (Platform Admin / model-risk owner). Platform health, the agent's
// brain and MCP tools, model performance, and the policy that gates the agent.
// Data: GET /api/agent/system (ADMIN), /api/ml/metrics, /api/ml/ensemble.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchAPI, getSystem } from '../api';
import { getSession } from '../auth';
import { Button, Card, Disclosure, EmptyState, Pill, SectionHeader } from '../components/ui';

const BRAIN = {
  llm: 'Claude',
  gemini: 'Gemini',
  playbook: 'Graph-driven autopilot',
};

const ACTION = {
  escalate: 'Escalate',
  draft_str: 'STR draft',
  monitor: 'Monitor',
  request_edd: 'Request EDD',
  close: 'Close',
  clear: 'Clear',
  review: 'Review',
};

function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  if (h >= 17 && h < 22) return 'Good evening';
  return 'Working late';
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Date.now() / 1000 - Number(ts));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const num = (n) => Number(n || 0).toLocaleString('en-IN');
const fx = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(3) : '-');
const short = (s, n = 90) => {
  const t = String(s || '').replace(/[^\x20-\x7E]/g, '');
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
};

function HealthPill({ label, ok, detail }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Pill tone={ok ? 'lime' : 'orange'}>{label}</Pill>
      {detail && <span className="text-xs text-gray-400">{detail}</span>}
    </span>
  );
}

function modelRows(ml, ens) {
  const pick = (m) => (m ? { auprc: m.average_precision ?? m.auprc, auc: m.auc, recall: m.recall, f1: m.f1 } : null);
  return [
    ['XGBoost', ml?.trained ? pick(ml) : null],
    ['GraphSAGE', pick(ml?.gnn)],
    ['Ensemble', ens?.trained ? pick(ens.ensemble) : null],
    ['TGN', pick(ml?.tgn)],
  ];
}

export default function AdminHome() {
  const navigate = useNavigate();
  const first = (getSession()?.name || 'Admin').split(/\s+/)[0];
  const [sys, setSys] = useState(null);
  const [error, setError] = useState(null);
  const [models, setModels] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    getSystem()
      .then((d) => { if (live) { setSys(d); setError(null); } })
      .catch((e) => { if (live) setError(e); });
    return () => { live = false; };
  }, [tick]);

  useEffect(() => {
    let live = true;
    Promise.allSettled([fetchAPI('/api/ml/metrics'), fetchAPI('/api/ml/ensemble')]).then(([m, e]) => {
      if (!live) return;
      setModels({
        ml: m.status === 'fulfilled' ? m.value : null,
        ens: e.status === 'fulfilled' ? e.value : null,
      });
    });
    return () => { live = false; };
  }, []);

  const header = (
    <div className="px-2 pt-1">
      <h1 className="text-2xl font-semibold tracking-tight text-gray-900">System</h1>
      <p className="mt-0.5 text-sm text-gray-500">{greeting()}, {first}</p>
    </div>
  );

  const quickLinks = (
    <div className="flex flex-wrap gap-2 px-2">
      <Button variant="secondary" size="sm" onClick={() => navigate('/settings')}>Detector settings</Button>
      <Button variant="secondary" size="sm" onClick={() => navigate('/live')}>Live stream</Button>
      <Button variant="secondary" size="sm" onClick={() => navigate('/model')}>ML models</Button>
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
          {forbidden ? (
            <EmptyState title="Admin view" body="Sign in as the Platform Admin." />
          ) : (
            <EmptyState
              title={down ? 'FalkorDB is not running' : 'Backend not reachable'}
              body={down ? 'docker start rudra-falkordb' : short(msg, 160)}
              action={<Button onClick={() => setTick((t) => t + 1)}>Retry</Button>}
            />
          )}
        </Card>
      </div>
    );
  }

  const loading = !sys;
  const h = sys?.health || {};
  const g = sys?.graph || {};
  const brain = sys?.brain || {};
  const tools = sys?.tools || [];
  const actionTools = tools.filter((t) => t.action);
  const rules = sys?.policy?.rules || [];
  const log = sys?.policy?.log || [];
  const stream = h.stream;
  const streamOk = !!(stream && stream.running);
  const accounts = g.labels?.Account;
  const txns = g.relationships?.TXN;
  const reasons = Object.entries(brain.reasons || {}).filter(([, r]) => r);
  const rows = modelRows(models?.ml, models?.ens);

  return (
    <div className="space-y-3 pb-6">
      {header}

      <Card padded={false} className="px-6 py-4">
        {loading ? (
          <p className="text-xs text-gray-400">Loading...</p>
        ) : (
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <HealthPill label="FalkorDB" ok={!!h.falkordb} />
              <HealthPill label="Graph loaded" ok={!!h.graph_loaded} />
              <HealthPill label="Alerts" ok={Number(h.alerts_loaded) > 0} detail={num(h.alerts_loaded)} />
              <HealthPill label="ML models" ok={!!h.ml_bundle} />
              <HealthPill label="Stream" ok={streamOk} detail={stream?.mode || 'off'} />
            </div>
            {sys.graph ? (
              <p className="text-xs text-gray-500">
                <span className="num font-medium text-gray-800">{num(accounts)}</span> accounts |{' '}
                <span className="num font-medium text-gray-800">{num(txns)}</span> transactions |{' '}
                <span className="num font-medium text-gray-800">{g.query_ms ?? '-'}</span> ms
              </p>
            ) : (
              <p className="text-xs text-gray-400">Graph size unavailable</p>
            )}
          </div>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <SectionHeader title="Agent" />
          {loading ? (
            <p className="text-xs text-gray-400">Loading...</p>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="text-xs text-gray-500">Active brain</p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-lg font-semibold text-gray-900">
                  {BRAIN[brain.mode] || brain.mode || '-'}
                  {brain.model && <span className="num text-xs font-normal text-gray-400">{brain.model}</span>}
                </p>
                {reasons.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {reasons.map(([k, r]) => (
                      <li key={k} className="text-xs text-gray-500">
                        <span className="capitalize text-gray-700">{k}</span>: {short(r)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="text-sm text-gray-900">
                  Tools via MCP: <span className="num font-semibold">{tools.length}</span>
                  <span className="text-gray-500"> ({actionTools.length} action tools)</span>
                </p>
                {tools.length > 0 && (
                  <div className="mt-2">
                    <Disclosure label="Show tools">
                      <ul className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                        {tools.map((t) => (
                          <li key={t.name} className="flex items-center gap-2 text-xs text-gray-700">
                            <span className="num truncate">{t.name}</span>
                            {t.action && <Pill tone="yellow">action</Pill>}
                          </li>
                        ))}
                      </ul>
                    </Disclosure>
                  </div>
                )}
              </div>
            </div>
          )}
        </Card>

        <Card>
          <SectionHeader
            title="Models"
            action={<Button variant="ghost" size="sm" onClick={() => navigate('/model')}>Details</Button>}
          />
          {!models ? (
            <p className="text-xs text-gray-400">Loading...</p>
          ) : (
            <div className="-mx-1 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500">
                    <th className="px-1 py-2 font-medium">Model</th>
                    <th className="px-1 py-2 text-right font-medium">AUPRC</th>
                    <th className="px-1 py-2 text-right font-medium">ROC-AUC</th>
                    <th className="px-1 py-2 text-right font-medium">Recall</th>
                    <th className="px-1 py-2 text-right font-medium">F1</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map(([name, m]) => (
                    <tr key={name}>
                      <td className="px-1 py-2 text-gray-900">{name}</td>
                      <td className="num px-1 py-2 text-right font-medium text-gray-900">{fx(m?.auprc)}</td>
                      <td className="num px-1 py-2 text-right text-gray-700">{fx(m?.auc)}</td>
                      <td className="num px-1 py-2 text-right text-gray-700">{fx(m?.recall)}</td>
                      <td className="num px-1 py-2 text-right text-gray-700">{fx(m?.f1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card>
        <SectionHeader title="Agent policy" />
        {loading ? (
          <p className="text-xs text-gray-400">Loading...</p>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <ol className="space-y-3">
              {rules.map((r) => (
                <li key={r.id} className="flex gap-3">
                  <span className="num w-6 shrink-0 text-xs font-semibold text-gray-400">{r.id}</span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{r.name}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-gray-500">{r.text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div>
              <p className="mb-2 text-xs font-medium text-gray-500">Recent policy actions</p>
              {!h.falkordb ? (
                <p className="text-xs text-gray-400">FalkorDB offline - docker start rudra-falkordb</p>
              ) : log.length === 0 ? (
                <p className="text-xs text-gray-400">No denials or downgrades yet.</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {log.map((d) => {
                    const denied = d.status === 'denied';
                    return (
                      <li key={d.decision_id} className="py-2.5 first:pt-0">
                        <div className="flex items-center justify-between gap-3">
                          <p className="min-w-0 truncate text-sm text-gray-900">
                            {ACTION[d.requested] || d.requested || '-'}
                            <span className="text-gray-400"> -&gt; </span>
                            {ACTION[d.final] || d.final || '-'}
                          </p>
                          <Pill tone={denied ? 'orange' : 'yellow'}>{denied ? 'denied' : 'downgraded'}</Pill>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-gray-400">
                          <span className="num font-medium text-gray-600">{d.rule || '-'}</span>
                          {' | '}{d.run_by_name || 'unknown'}{' | '}{ago(d.ts)}
                          {d.investigation_id ? ` | ${d.investigation_id}` : ''}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </Card>

      {quickLinks}
    </div>
  );
}
