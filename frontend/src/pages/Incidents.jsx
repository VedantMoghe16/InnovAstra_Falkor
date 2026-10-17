// Incidents: triage every clustered incident. Scan, filter, sort by money at
// risk, open the root-cause dossier, or hand one to the agent in one click.
// List data: GET /api/agent/incidents (FalkorDB, USD-equivalent amounts).
// Dossier: GET /api/incidents/{id}/rca + GET /api/incidents/{id}.
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fetchAPI, getIncidentList, getIncidentRca } from '../api';
import RcaReport from '../components/RcaReport';
import { Button, Card, Disclosure, EmptyState, Pill, Tabs } from '../components/ui';
import { formatUsd } from '../format';

const PAGE = 50;
const SEVERITY_TONE = { CRITICAL: 'orange', HIGH: 'yellow', MEDIUM: 'gray', LOW: 'gray' };
const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const TIER = { 1: 'ML + rule agree', 2: 'ML only', 3: 'Rule only' };
const SORTS = [
  ['usd', 'Most money'],
  ['alerts', 'Most alerts'],
  ['ml', 'Highest ML score'],
];

// Share an identical in-flight request (StrictMode runs effects twice in dev,
// and two simultaneous identical cross-origin fetches can fail in Chromium).
const inflight = new Map();
function shared(key, fn) {
  if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
  return inflight.get(key);
}

// Alert text from the pipeline labels mixed-currency sums as "Rs"; say what it is.
const honest = (t) => (t ? String(t).replace(/\b(on|of) Rs\.? ?([\d,]+(?:\.\d+)?)/g, '$1 $2 (mixed currency, as recorded)') : t);

const num = (n) => Number(n || 0).toLocaleString('en-IN');
const title = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : '');

function SeverityPill({ severity }) {
  if (!severity) return null;
  return <Pill tone={SEVERITY_TONE[severity] || 'gray'}>{title(severity)}</Pill>;
}

function Select({ value, onChange, children, label }) {
  return (
    <label className="flex items-center gap-2 text-xs text-gray-500">
      <span className="sr-only sm:not-sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-xl bg-gray-100 px-3 py-2 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-gray-300"
      >
        {children}
      </select>
    </label>
  );
}

const GRID_FULL = 'grid grid-cols-[84px_minmax(0,1fr)_120px_64px_76px_136px_96px] items-center gap-4';
const GRID_COMPACT = 'grid grid-cols-[72px_minmax(0,1fr)_96px_92px] items-center gap-3';

function Row({ inc, compact, selected, sort, onOpen, onInvestigate }) {
  const tier = TIER[inc.top_tier] || 'No tier';
  const ml = inc.max_ml_score != null ? Number(inc.max_ml_score).toFixed(sort === 'ml' ? 3 : 2) : '-';
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={() => onOpen(inc.incident_id)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(inc.incident_id); } }}
        className={`${compact ? GRID_COMPACT : GRID_FULL} cursor-pointer rounded-xl px-3 py-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-gray-300 ${
          selected ? 'bg-gray-50 ring-1 ring-gray-200' : 'hover:bg-gray-50'}`}
      >
        <div><SeverityPill severity={inc.severity} /></div>
        <div className="min-w-0">
          <p className="truncate text-sm">
            <span className="num font-medium text-gray-900">{inc.incident_id}</span>
            {compact && <span className="ml-2 text-xs text-gray-500">{inc.primary_pattern || 'Unclassified'}</span>}
          </p>
          <p className="truncate text-xs text-gray-500">
            {compact
              ? `${num(inc.alert_count)} alerts | ${num(inc.n_entities)} accounts${sort === 'ml' ? ` | ML ${ml}` : ''}`
              : inc.primary_pattern || 'Unclassified'}
          </p>
        </div>
        <p className="num text-right text-sm font-medium text-gray-900">{formatUsd(inc.total_flow_usd)}</p>
        {!compact && (
          <>
            <p className="num text-right text-sm text-gray-700">{num(inc.alert_count)}</p>
            <p className="num text-right text-sm text-gray-700">{num(inc.n_entities)}</p>
            <div className="min-w-0">
              <p className={`truncate text-xs ${inc.top_tier === 1 ? 'font-medium text-gray-900' : 'text-gray-600'}`}>{tier}</p>
              <p className="num text-[11px] text-gray-400">ML score {ml}</p>
            </div>
          </>
        )}
        <div className="text-right">
          <Button variant="secondary" size="sm" onClick={(e) => { e.stopPropagation(); onInvestigate(inc.incident_id); }}>
            Investigate
          </Button>
        </div>
      </div>
    </li>
  );
}

function Dossier({ id, item, onClose, onInvestigate, navigate }) {
  const [rca, setRca] = useState(null);
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    let live = true;
    shared(`rca:${id}`, () => getIncidentRca(id))
      .then((d) => { if (live) setRca({ id, d }); })
      .catch((e) => { if (live) setRca({ id, d: { error: e.message } }); });
    shared(`inc:${id}`, () => fetchAPI(`/api/incidents/${encodeURIComponent(id)}`))
      .then((d) => { if (live) setDetail({ id, d }); })
      .catch(() => { if (live) setDetail({ id, d: null }); });
    return () => { live = false; };
  }, [id]);

  const dossier = rca?.id === id ? rca.d : null;
  const info = detail?.id === id ? detail.d : null;
  const severity = item?.severity || info?.severity;
  const pattern = item?.primary_pattern || info?.primary_pattern;
  const alerts = info?.alerts || [];
  const basis = alerts.map((a) => a.legal_basis).filter(Boolean);
  const legal = basis.find((b) => b.includes('STR')) || basis[0];

  return (
    <Card className="lg:sticky lg:top-0 lg:max-h-[calc(100vh-92px)] lg:overflow-y-auto">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2">
            <span className="num text-sm font-medium text-gray-900">{id}</span>
            <SeverityPill severity={severity} />
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-gray-900">{pattern || 'Incident'}</h2>
          {item && (
            <p className="mt-1 text-xs text-gray-500">
              <span className="num font-medium text-gray-800">{formatUsd(item.total_flow_usd)}</span> moved among{' '}
              {num(item.n_entities)} accounts | {num(item.alert_count)} alerts | {TIER[item.top_tier] || 'No tier'}
            </p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button onClick={() => onInvestigate(id)}>Investigate with the agent</Button>
        {info?.primary_alert_id && (
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate(`/journey?alert=${encodeURIComponent(info.primary_alert_id)}`)}>
              Trace the money
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate(`/cases?focus=${encodeURIComponent(info.primary_alert_id)}`)}>
              Open in Cases
            </Button>
          </>
        )}
      </div>
      <p className="mt-2 text-xs text-gray-400">
        The agent follows the money through the graph and proposes an action. Nothing is filed until a supervisor approves.
      </p>

      {legal && <p className="mt-4 rounded-2xl bg-gray-50 px-4 py-3 text-xs text-gray-600"><span className="font-medium text-gray-800">Regulatory basis:</span> {legal}</p>}

      <div className="mt-5">
        {dossier ? <RcaReport dossier={dossier} /> : <p className="text-xs text-gray-400">Reconstructing what happened...</p>}
      </div>

      {alerts.length > 0 && (
        <div className="mt-5 border-t border-gray-100 pt-4">
          <Disclosure label={`Show the ${num(alerts.length)} alerts in this incident`} closeLabel="Hide alerts">
            <ul className="max-h-80 divide-y divide-gray-100 overflow-y-auto">
              {alerts.slice(0, 50).map((a) => (
                <li key={a.alert_id}>
                  <button type="button" onClick={() => navigate(`/cases?focus=${encodeURIComponent(a.alert_id)}`)}
                    className="w-full rounded-lg px-2 py-2 text-left hover:bg-gray-50">
                    <span className="flex items-center gap-2">
                      <span className="num text-xs text-gray-800">{a.alert_id}</span>
                      <span className="text-[11px] text-gray-400">{TIER[a.tier] || a.pattern_type}</span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-xs text-gray-500">{honest(a.description)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {alerts.length > 50 && <p className="mt-2 text-xs text-gray-400">First 50 of {num(alerts.length)} shown. Open the case to see all.</p>}
          </Disclosure>
        </div>
      )}
    </Card>
  );
}

export default function Incidents() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const severity = params.get('severity') || '';
  const pattern = params.get('pattern') || '';
  const q = params.get('q') || '';
  const sort = params.get('sort') || 'usd';
  const page = Math.max(0, Number(params.get('page') || 0) || 0);
  const selected = params.get('id') || '';

  const [qInput, setQInput] = useState(q);
  const [result, setResult] = useState(null);
  const [tick, setTick] = useState(0);
  const timer = useRef(null);

  const key = JSON.stringify([severity, pattern, q, sort, page, tick]);

  useEffect(() => {
    let live = true;
    shared(`list:${key}`, () => getIncidentList({ severity, pattern, q, sort, limit: PAGE, offset: page * PAGE }))
      .then((d) => { if (live) setResult({ key, data: d, error: null }); })
      .catch((e) => { if (live) setResult({ key, data: null, error: e }); });
    return () => { live = false; };
  }, [key, severity, pattern, q, sort, page]);

  useEffect(() => () => clearTimeout(timer.current), []);

  function update(patch) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    setParams(next, { replace: true });
  }

  function onSearch(value) {
    setQInput(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => update({ q: value.trim(), page: null }), 350);
  }

  const investigate = (id) => navigate(`/investigator?q=${encodeURIComponent(`Investigate incident ${id}`)}`);
  const openIncident = (id) => update({ id: id === selected ? null : id });
  const clearFilters = () => { setQInput(''); clearTimeout(timer.current); update({ q: null, severity: null, pattern: null, page: null }); };

  const stale = !result || result.key !== key;
  const data = result?.data;
  const error = result?.error;
  const items = data?.items || [];
  const total = data?.total || 0;
  const filtered = Boolean(severity || pattern || q);
  const sevCounts = Object.fromEntries((data?.severities || []).map((s) => [s.severity, s.count]));
  const sevAll = Object.values(sevCounts).reduce((a, b) => a + b, 0);
  const sevTabs = [['', <span key="all">All <span className="num text-gray-400">{num(sevAll)}</span></span>]].concat(
    SEVERITY_ORDER.filter((s) => sevCounts[s] || s === severity).map((s) => [
      s, <span key={s}>{title(s)} <span className="num text-gray-400">{num(sevCounts[s] || 0)}</span></span>,
    ]),
  );
  const patterns = data?.patterns || [];
  const selectedItem = items.find((i) => i.incident_id === selected);
  const from = total ? page * PAGE + 1 : 0;
  const to = Math.min(total, (page + 1) * PAGE);

  const header = (
    <div className="px-2 pt-1">
      <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Incidents</h1>
    </div>
  );

  if (error && !stale) {
    const down = String(error.message || '').includes('503');
    return (
      <div className="space-y-4 pb-6">
        {header}
        <Card>
          <EmptyState
            title={down ? 'The context graph is not running' : 'Could not load incidents'}
            body={down
              ? 'Incidents are read from FalkorDB. Start it with "docker start rudra-falkordb" (first time: docker run -p 6379:6379 falkordb/falkordb, then python src/graphdb/falkor_loader.py --reset), then retry.'
              : `The API did not answer (${error.message}). Check that the backend is running on its usual port, then retry.`}
            action={<Button onClick={() => setTick((t) => t + 1)}>Retry</Button>}
          />
        </Card>
      </div>
    );
  }

  const compact = Boolean(selected);

  return (
    <div className="space-y-3 pb-6">
      {header}

      <div className={`grid items-start gap-3 ${compact ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]' : ''}`}>
        <Card padded={false} className="min-w-0 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-center gap-2 px-1 pb-3">
            <input
              type="search"
              value={qInput}
              onChange={(e) => onSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { clearTimeout(timer.current); update({ q: qInput.trim(), page: null }); } }}
              placeholder="Search incident or account id"
              aria-label="Search incident or account id"
              className={`min-w-0 flex-1 ${compact ? 'basis-full' : 'basis-56'} rounded-xl bg-gray-100 px-3 py-2 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:ring-2 focus:ring-gray-300`}
            />
            <Select label="Pattern" value={pattern} onChange={(v) => update({ pattern: v, page: null })}>
              <option value="">All patterns</option>
              {patterns.map((p) => (
                <option key={p.pattern} value={p.pattern}>{p.pattern} ({num(p.count)})</option>
              ))}
              {pattern && !patterns.some((p) => p.pattern === pattern) && <option value={pattern}>{pattern} (0)</option>}
            </Select>
            <Select label="Sort" value={sort} onChange={(v) => update({ sort: v === 'usd' ? null : v, page: null })}>
              {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-3">
            <Tabs tabs={sevTabs} value={severity} onChange={(v) => update({ severity: v, page: null })} />
            <p className="text-xs text-gray-400">
              {stale ? 'Loading...' : total ? `Showing ${num(from)}-${num(to)} of ${num(total)}` : ''}
              {!stale && filtered && (
                <button type="button" onClick={clearFilters} className="ml-3 font-medium text-gray-500 hover:text-gray-900 hover:underline">
                  Clear filters
                </button>
              )}
            </p>
          </div>

          {!compact && items.length > 0 && (
            <div className={`${GRID_FULL} border-b border-gray-100 px-3 pb-2 text-[11px] font-medium uppercase tracking-wider text-gray-400`}>
              <span>Severity</span>
              <span>Incident</span>
              <span className="text-right" title="Money moved among the incident's accounts, converted to USD at fixed reference rates">Moved (USD eq.)</span>
              <span className="text-right">Alerts</span>
              <span className="text-right">Accounts</span>
              <span>Evidence</span>
              <span />
            </div>
          )}

          {!data && stale ? (
            <p className="px-3 py-10 text-center text-xs text-gray-400">Loading incidents...</p>
          ) : items.length === 0 ? (
            <div className="pt-3">
              {filtered ? (
                <EmptyState
                  title="No incidents match these filters"
                  body={q
                    ? `Nothing matches "${q}"${severity || pattern ? ` within the ${[severity && title(severity), pattern].filter(Boolean).join(' / ')} filter - clear filters to search everything` : ''}. Search takes part of an incident id (INC-27) or a full account id (21-803E21640).`
                    : 'Try another severity or pattern, or clear the filters to see every incident.'}
                  action={<Button variant="secondary" onClick={clearFilters}>Clear filters</Button>}
                />
              ) : (
                <EmptyState
                  title="No incidents in the graph yet"
                  body="Incidents come from the detection pipeline. Run python src/run_pipeline.py, then load the graph with scripts/load_falkor.sh, and they will appear here."
                />
              )}
            </div>
          ) : (
            <ul className={`mt-1 space-y-0.5 transition-opacity ${stale ? 'opacity-50' : ''}`}>
              {items.map((inc) => (
                <Row key={inc.incident_id} inc={inc} compact={compact} sort={sort} selected={inc.incident_id === selected}
                  onOpen={openIncident} onInvestigate={investigate} />
              ))}
            </ul>
          )}

          {total > PAGE && (
            <div className="mt-3 flex items-center justify-between border-t border-gray-100 px-1 pt-3">
              <p className="text-xs text-gray-400">Page {num(page + 1)} of {num(Math.ceil(total / PAGE))}</p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={page === 0 || stale} onClick={() => update({ page: page - 1 || null })}>
                  Previous
                </Button>
                <Button variant="secondary" size="sm" disabled={to >= total || stale} onClick={() => update({ page: page + 1 })}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </Card>

        {selected && (
          <Dossier key={selected} id={selected} item={selectedItem} navigate={navigate}
            onClose={() => update({ id: null })} onInvestigate={investigate} />
        )}
      </div>
    </div>
  );
}
