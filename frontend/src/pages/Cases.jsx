import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fetchAPI, postAPI, downloadFromAPI, getRole } from '../api';
import { Button, EmptyState, Pill } from '../components/ui';

const STATUS_TABS = [
  { key: 'OPEN', label: 'Open' },
  { key: 'INVESTIGATING', label: 'Investigating' },
  { key: 'SAR_FILED', label: 'SAR filed' },
  { key: 'ESCALATED', label: 'Escalated' },
  { key: 'DISMISSED', label: 'Dismissed' },
  { key: 'ALL', label: 'All' },
];

const STATUS_TONE = { OPEN: 'gray', INVESTIGATING: 'dark', SAR_FILED: 'lime', ESCALATED: 'orange', DISMISSED: 'gray' };
const STATUS_LABEL = { OPEN: 'Open', INVESTIGATING: 'Investigating', SAR_FILED: 'SAR filed', ESCALATED: 'Escalated', DISMISSED: 'Dismissed' };
const SEVERITY_TONE = { CRITICAL: 'orange', HIGH: 'yellow', MEDIUM: 'gray', LOW: 'gray' };

const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
// Max rows/groups painted at once. The list is priority-sorted and filters
// operate on the full set, so capping the DOM keeps the page snappy on 8k+ alerts.
const ROW_CAP = 200;

const ML_BANDS = [
  { key: 'ALL', label: 'All' },
  { key: 'HIGH', label: '70+' },
  { key: 'MED', label: '40-70' },
  { key: 'LOW', label: 'under 40' },
  { key: 'NONE', label: 'none' },
];

const TIER_OPTIONS = [
  { key: 'ALL', label: 'All' },
  { key: '1', label: 'ML + rule' },
  { key: '2', label: 'ML only' },
  { key: '3', label: 'Rule only' },
];

function mlBandOf(s) {
  if (s == null) return 'NONE';
  if (s >= 0.7) return 'HIGH';
  if (s >= 0.4) return 'MED';
  return 'LOW';
}

// Flows are summed by the pipeline across mixed source currencies, so no
// currency symbol is claimed here - the number is shown as recorded.
const AMOUNT_TITLE = 'Amount as recorded by the pipeline (mixed currencies, not converted)';
function formatAmount(n) {
  if (n == null) return '-';
  const v = Number(n);
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function SeverityPill({ severity }) {
  if (!severity) return null;
  return <Pill tone={SEVERITY_TONE[severity] || 'gray'}>{severity.toLowerCase()}</Pill>;
}

function StatusPill({ status }) {
  const s = status || 'OPEN';
  return <Pill tone={STATUS_TONE[s] || 'gray'}>{STATUS_LABEL[s] || s.replace('_', ' ').toLowerCase()}</Pill>;
}

function MLScoreBar({ score, wide = false }) {
  if (score == null) return <span className="text-xs text-gray-400">no score</span>;
  const pct = Math.round(score * 100);
  const color = pct >= 70 ? 'bg-[#e8743b]' : pct >= 40 ? 'bg-gray-900' : 'bg-lime';
  return (
    <div className="flex items-center gap-2">
      <div className={`${wide ? 'w-24' : 'w-14'} h-1.5 overflow-hidden rounded-full bg-gray-100`}>
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="num w-6 text-right text-xs tabular-nums text-gray-700">{pct}</span>
    </div>
  );
}

const TIER_META = {
  1: { label: 'Tier 1 - ML + rule', title: 'Tier 1 - ML detection corroborated by a typology rule (highest confidence, ~74% precision)' },
  2: { label: 'Tier 2 - ML only', title: 'Tier 2 - ML detection, model-only (recall workhorse)' },
  3: { label: 'Tier 3 - rule only', title: 'Tier 3 - typology rule (no ML corroboration)' },
};

// Temporal recurrence escalation (orthogonal to tier/severity). L1 is the common
// case (~88%) so we only badge the re-offenders (L2/L3) to keep the list legible.
// Neutral pill with a small accent dot, so severity stays the one loud colour per row.
const ESC_DOT = { 2: '#f2c94c', 3: '#e8743b' };

function EscalationBadge({ escalation }) {
  const dot = escalation && ESC_DOT[escalation.level];
  if (!dot) return null;
  const n = escalation.hit_count;
  return (
    <span title={`${escalation.label} (L${escalation.level}) - re-flagged across ${n} time windows${escalation.entity ? ` (driver: ${escalation.entity})` : ''}`}>
      <Pill tone="gray" className="gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} />
        Recurring x{n}
      </Pill>
    </span>
  );
}

const FLAG_TONE = {
  shell_company: 'orange',
  part_of_cycle: 'orange',
  transit_node: 'orange',
  outflow_zscore_anomaly: 'orange',
  high_risk: 'yellow',
  velocity_burst: 'yellow',
  dormant_then_active: 'yellow',
};

function FlagPill({ flag }) {
  return <Pill tone={FLAG_TONE[flag] || 'gray'} className="!px-2 !text-[10px]">{flag.replace(/_/g, ' ')}</Pill>;
}

function Segmented({ label, options, value, onChange, counts }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500">{label}</span>
      <div className="inline-flex rounded-lg bg-gray-100 p-0.5 text-xs" role="radiogroup" aria-label={label}>
        {options.map((o) => {
          const active = value === o.key;
          const count = counts?.[o.key];
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(o.key)}
              className={`rounded-md px-2.5 py-1 transition-colors ${active ? 'bg-white font-medium text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
            >
              {o.label}
              {count != null && <span className="num ml-1 text-gray-400">{count.toLocaleString('en-IN')}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SkeletonRows({ n = 6 }) {
  return (
    <ul className="divide-y divide-gray-100" aria-label="Loading cases">
      {Array.from({ length: n }, (_, i) => (
        <li key={i} className="flex items-start gap-4 px-6 py-5">
          <div className="min-w-0 flex-1 animate-pulse space-y-2.5">
            <div className="flex items-center gap-2">
              <div className="h-3.5 w-40 rounded-full bg-gray-200" />
              <div className="h-3.5 w-14 rounded-full bg-gray-100" />
            </div>
            <div className="h-3 rounded-full bg-gray-100" style={{ width: `${88 - (i % 3) * 14}%` }} />
            <div className="h-3 w-1/3 rounded-full bg-gray-100" />
          </div>
          <div className="h-1.5 w-20 animate-pulse rounded-full bg-gray-100" />
        </li>
      ))}
    </ul>
  );
}

function DetailSkeleton() {
  return (
    <div className="animate-pulse space-y-4 p-6" aria-label="Loading case">
      <div className="h-3 w-28 rounded-full bg-gray-100" />
      <div className="h-5 w-56 rounded-full bg-gray-200" />
      <div className="h-3 w-full rounded-full bg-gray-100" />
      <div className="h-3 w-4/5 rounded-full bg-gray-100" />
      <div className="grid grid-cols-2 gap-3 pt-2">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-16 rounded-2xl bg-gray-50" />)}
      </div>
    </div>
  );
}

function SectionLabel({ children, action }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-xs font-medium text-gray-500">{children}</h3>
      {action}
    </div>
  );
}

function Fact({ label, children, title }) {
  return (
    <div className="rounded-2xl bg-gray-50 px-4 py-3" title={title}>
      <p className="text-xs text-gray-500">{label}</p>
      <div className="mt-1 text-sm font-semibold text-gray-900">{children}</div>
    </div>
  );
}

export default function Cases() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const focusedId = params.get('focus');
  const role = getRole();

  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeStatus, setActiveStatus] = useState('OPEN');
  const [selectedId, setSelectedId] = useState(focusedId || null);
  const [caseDetail, setCaseDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [explanation, setExplanation] = useState(null);
  const [chainStatus, setChainStatus] = useState(null);     // verify response | {error: true}
  const [entityFlags, setEntityFlags] = useState({});      // {entity_id: [flags]}
  const [tracePreview, setTracePreview] = useState(null);  // {dominant_paths: [...]}
  const [mlBand, setMlBand] = useState('ALL');             // 'ALL' | 'HIGH' | 'MED' | 'LOW' | 'NONE'
  const [tierFilter, setTierFilter] = useState('ALL');     // 'ALL' | '1' | '2' | '3'
  const [groupByIncident, setGroupByIncident] = useState(false);
  const [unmaskedCard, setUnmaskedCard] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchAPI('/api/alerts');
        if (!cancelled) setAlerts(data.alerts || []);
      } catch {
        if (!cancelled) setAlerts([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const refreshAlerts = useCallback(async () => {
    const data = await fetchAPI('/api/alerts');
    setAlerts(data.alerts || []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!selectedId) {
        setCaseDetail(null); setNote(''); setExplanation(null); setChainStatus(null);
        setEntityFlags({}); setTracePreview(null); setUnmaskedCard(null);
        return;
      }
      setDetailLoading(true);
      setEntityFlags({}); setTracePreview(null);
      try {
        const [c, e] = await Promise.all([
          fetchAPI(`/api/cases/${selectedId}`),
          fetchAPI(`/api/alerts/${selectedId}/explain`).catch(() => null),
        ]);
        if (cancelled) return;
        setCaseDetail(c);
        setExplanation(e && !e.error ? e : null);

        // Fetch entity flags + a small alert-scoped trace preview in parallel.
        // The alert object lives in the `alerts` list, so look it up there.
        const alert = alerts.find(a => a.alert_id === selectedId);
        const entityIds = (alert?.entities || []).slice(0, 8);

        Promise.all(
          entityIds.map(eid =>
            fetchAPI(`/api/entities/${eid}`)
              .then(d => [eid, d.flags || []])
              .catch(() => [eid, []])
          )
        ).then(pairs => { if (!cancelled) setEntityFlags(Object.fromEntries(pairs)); });

        // Pull the journey for the alert's first entity to get dominant_paths.
        // trace_for_alert doesn't compute them - use the entity-mode endpoint.
        if (entityIds[0]) {
          fetchAPI(`/api/journey/${entityIds[0]}?hops=3&direction=forward`)
            .then(d => { if (!cancelled) setTracePreview({
              dominant_paths: d.dominant_paths || [],
              terminal_classification: d.terminal_classification || {},
            }); })
            .catch(() => { if (!cancelled) setTracePreview(null); });
        }
      } catch {
        if (!cancelled) { setCaseDetail(null); setExplanation(null); }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId, alerts]);

  // Alerts narrowed by status + search only: the base the filter counts are taken over,
  // so each segment's number says how many you would see if you picked it.
  const base = useMemo(() => {
    let xs = alerts;
    if (activeStatus !== 'ALL') {
      xs = xs.filter(a => (a.case_status || 'OPEN') === activeStatus);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      xs = xs.filter(a =>
        (a.pattern_type || '').toLowerCase().includes(q) ||
        (a.alert_id || '').toLowerCase().includes(q) ||
        (a.entity_names || []).some(n => (n || '').toLowerCase().includes(q))
      );
    }
    return xs;
  }, [alerts, activeStatus, search]);

  const filtered = useMemo(() => {
    let xs = base;
    if (mlBand !== 'ALL') xs = xs.filter(a => mlBandOf(a.ml_score) === mlBand);
    if (tierFilter !== 'ALL') xs = xs.filter(a => String(a.tier) === tierFilter);
    return [...xs].sort((a, b) => {
      // Tier first (1 = ML+rule agreement, highest precision), then temporal
      // recurrence (a serial re-offender outranks a one-shot), then severity, then flow.
      const tierDiff = (a.tier ?? 99) - (b.tier ?? 99);
      if (tierDiff !== 0) return tierDiff;
      const escDiff = (b.escalation?.level ?? 1) - (a.escalation?.level ?? 1);
      if (escDiff !== 0) return escDiff;
      const hitDiff = (b.escalation?.hit_count ?? 1) - (a.escalation?.hit_count ?? 1);
      if (hitDiff !== 0) return hitDiff;  // within a level, the worst recurrer first
      const sevDiff = (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99);
      if (sevDiff !== 0) return sevDiff;
      return (b.total_flow ?? 0) - (a.total_flow ?? 0);
    });
  }, [base, mlBand, tierFilter]);

  // Group filtered alerts by incident_id for the grouped view.
  const groupedFiltered = useMemo(() => {
    if (!groupByIncident) return null;
    const groups = new Map();
    for (const a of filtered) {
      const key = a.incident_id || '__no_incident__';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    // Sort groups by worst severity within them
    return Array.from(groups.entries()).sort(([, a], [, b]) => {
      const aSev = Math.min(...a.map(x => SEVERITY_ORDER[x.severity] ?? 99));
      const bSev = Math.min(...b.map(x => SEVERITY_ORDER[x.severity] ?? 99));
      return aSev - bSev;
    });
  }, [filtered, groupByIncident]);

  const counts = useMemo(() => {
    const c = { OPEN: 0, INVESTIGATING: 0, SAR_FILED: 0, ESCALATED: 0, DISMISSED: 0, ALL: alerts.length };
    for (const a of alerts) {
      const s = a.case_status || 'OPEN';
      if (c[s] != null) c[s] += 1;
    }
    return c;
  }, [alerts]);

  // Segment counts: ML band counts respect the tier filter and vice versa.
  const filterCounts = useMemo(() => {
    const ml = { ALL: 0, HIGH: 0, MED: 0, LOW: 0, NONE: 0 };
    const tier = { ALL: 0, 1: 0, 2: 0, 3: 0 };
    for (const a of base) {
      const band = mlBandOf(a.ml_score);
      const t = String(a.tier);
      if (tierFilter === 'ALL' || t === tierFilter) { ml.ALL += 1; ml[band] += 1; }
      if (mlBand === 'ALL' || band === mlBand) { tier.ALL += 1; if (tier[t] != null) tier[t] += 1; }
    }
    return { ml, tier };
  }, [base, mlBand, tierFilter]);

  const selectedAlert = useMemo(
    () => alerts.find(a => a.alert_id === selectedId),
    [alerts, selectedId]
  );

  async function disposeCase(status) {
    if (!selectedId) return;
    setActionLoading(true);
    try {
      await postAPI(`/api/cases/${selectedId}/dispose`, { status, note });
      setNote('');
      await refreshAlerts();
      const c = await fetchAPI(`/api/cases/${selectedId}`);
      setCaseDetail(c);
    } catch (e) {
      alert(e.message);
    } finally {
      setActionLoading(false);
    }
  }

  async function addNote() {
    if (!selectedId || !note.trim()) return;
    setActionLoading(true);
    try {
      const c = await postAPI(`/api/cases/${selectedId}/note`, { note });
      setNote('');
      setCaseDetail(c);
    } finally {
      setActionLoading(false);
    }
  }

  async function downloadFiuPackage() {
    if (!selectedId) return;
    setActionLoading(true);
    try {
      await downloadFromAPI(`/api/fiu/package/${selectedId}`, `FIU_${selectedId}.zip`);
    } finally {
      setActionLoading(false);
    }
  }

  async function verifyChain() {
    if (!selectedId) return;
    setActionLoading(true);
    try {
      const res = await fetchAPI(`/api/cases/${selectedId}/verify`);
      setChainStatus(res || { error: true });
    } catch {
      setChainStatus({ error: true });
    } finally {
      setActionLoading(false);
    }
  }

  const handleRevealCard = async () => {
    try {
      const res = await postAPI(`/api/cases/${selectedId}/reveal-card`);
      setUnmaskedCard(res.card_number);
      // Auto-refresh the case to fetch the new audit trail event
      const c = await fetchAPI(`/api/cases/${selectedId}`);
      setCaseDetail(c);
    } catch (e) {
      alert(e.message || "Failed to reveal card");
    }
  };

  // Compute which actions are allowed given current role
  const canSAR = role === 'SUPERVISOR' || role === 'ADMIN';
  const canDismiss = role === 'SUPERVISOR' || role === 'ADMIN';
  const canVerify = role === 'SUPERVISOR' || role === 'ADMIN';
  const LOCKED = 'Requires the Supervisor role';

  const filtersActive = mlBand !== 'ALL' || tierFilter !== 'ALL' || search.trim() !== '';
  function clearFilters() { setMlBand('ALL'); setTierFilter('ALL'); setSearch(''); }

  function openCase(id) {
    setSelectedId(id);
    setParams({ focus: id });
  }

  // Single-row renderer reused by both the flat list and the grouped list.
  function renderCaseRow(a) {
    const isSelected = a.alert_id === selectedId;
    const tier = TIER_META[a.tier];
    return (
      <li
        key={a.alert_id}
        onClick={() => openCase(a.alert_id)}
        className={`relative cursor-pointer px-6 py-4 transition-colors ${isSelected ? 'bg-gray-50' : 'hover:bg-gray-50/70'}`}
      >
        {isSelected && <span className="absolute bottom-3 left-0 top-3 w-1 rounded-r bg-gray-900" />}
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-gray-900">{a.pattern_type}</span>
              <SeverityPill severity={a.severity} />
              {activeStatus === 'ALL' && <StatusPill status={a.case_status} />}
              <EscalationBadge escalation={a.escalation} />
            </div>
            <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-gray-600">{a.description}</p>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-gray-500">
              <span className="num text-gray-400">{a.alert_id}</span>
              {a.incident_id && !groupByIncident && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); navigate(`/incidents`); }}
                  className="num hover:text-gray-900 hover:underline"
                >
                  {a.incident_id}
                </button>
              )}
              <span>{a.entities?.length || 0} accounts</span>
              <span title={AMOUNT_TITLE}>flow <span className="num font-medium text-gray-700">{formatAmount(a.total_flow)}</span></span>
              <span>conf {a.confidence}%</span>
              {tier && <span title={tier.title}>{tier.label}</span>}
            </p>
          </div>
          <div className="shrink-0 pt-1" title="ML score (0-100)">
            <MLScoreBar score={a.ml_score} />
          </div>
        </div>
      </li>
    );
  }

  const tabCount = (key) => (loading ? '-' : counts[key].toLocaleString('en-IN'));
  const shown = Math.min(groupedFiltered ? groupedFiltered.length : filtered.length, ROW_CAP);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="px-2 pt-1">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Case Workbench</h1>
      </div>

      {/* Status tabs, search and filters */}
      <section className="rounded-3xl bg-white px-6 pt-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-gray-100">
          <nav className="-mb-px flex gap-1 overflow-x-auto" role="tablist">
            {STATUS_TABS.map(t => {
              const active = activeStatus === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveStatus(t.key)}
                  className={`whitespace-nowrap border-b-2 px-3 py-3 text-sm transition-colors ${
                    active ? 'border-gray-900 font-medium text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800'
                  }`}
                >
                  {t.label}
                  <span className="num ml-1.5 text-xs font-normal text-gray-400">{tabCount(t.key)}</span>
                </button>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3 py-2">
            <div className="flex items-center gap-2 rounded-xl bg-gray-100 px-3 py-1.5">
              <svg className="h-3.5 w-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" />
              </svg>
              <input
                type="text"
                placeholder="Search pattern, alert or account"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-56 bg-transparent text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none"
              />
            </div>
            <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-gray-600">
              <input
                type="checkbox"
                checked={groupByIncident}
                onChange={(e) => setGroupByIncident(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-gray-300 accent-gray-900"
              />
              Group by incident
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
          <Segmented
            label="ML score"
            options={ML_BANDS}
            value={mlBand}
            onChange={setMlBand}
            counts={loading ? null : filterCounts.ml}
          />
          <Segmented
            label="Tier"
            options={TIER_OPTIONS}
            value={tierFilter}
            onChange={setTierFilter}
            counts={loading ? null : filterCounts.tier}
          />
          <div className="ml-auto flex items-center gap-3 text-xs text-gray-500">
            {!loading && (
              <span>
                <span className="num font-medium text-gray-700">{filtered.length.toLocaleString('en-IN')}</span> cases
                {groupedFiltered ? ` in ${groupedFiltered.length.toLocaleString('en-IN')} incidents` : ''}
              </span>
            )}
            {filtersActive && (
              <button type="button" onClick={clearFilters} className="font-medium text-gray-500 hover:text-gray-900 hover:underline">
                Clear filters
              </button>
            )}
          </div>
        </div>
      </section>

      <div className="flex min-h-0 flex-1 gap-3">
        {/* Cases list */}
        <div className={`${selectedId ? 'w-3/5' : 'w-full'} overflow-y-auto rounded-3xl bg-white`}>
          {loading ? (
            <SkeletonRows />
          ) : filtered.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title={alerts.length === 0 ? 'No alerts loaded' : 'No cases match'}
                body={alerts.length === 0
                  ? 'Alerts come from the detection pipeline. Run python src/run_pipeline.py and check that the backend is reachable.'
                  : filtersActive
                    ? 'Nothing in this tab matches the current search and filters. Clear them to see the whole queue.'
                    : 'No cases have this status yet. Cases move here when someone records a decision.'}
                action={filtersActive ? <Button variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button> : null}
              />
            </div>
          ) : groupedFiltered ? (
            <div>
              {groupedFiltered.slice(0, ROW_CAP).map(([incidentId, items]) => (
                <div key={incidentId} className="border-b border-gray-100 last:border-b-0">
                  <div className="sticky top-0 z-10 flex items-center justify-between bg-gray-50/95 px-6 py-2 backdrop-blur">
                    <p className="text-xs font-medium text-gray-700">
                      {incidentId === '__no_incident__' ? 'No incident' : <>Incident <span className="num">{incidentId}</span></>}
                      <span className="ml-2 font-normal text-gray-400">
                        {items.length} alert{items.length === 1 ? '' : 's'}
                      </span>
                    </p>
                    {incidentId !== '__no_incident__' && (
                      <button
                        type="button"
                        onClick={() => navigate(`/incidents`)}
                        className="text-xs text-gray-500 hover:text-gray-900 hover:underline"
                      >View incident {'->'}</button>
                    )}
                  </div>
                  <ul className="divide-y divide-gray-100">
                    {items.map(a => renderCaseRow(a))}
                  </ul>
                </div>
              ))}
              {groupedFiltered.length > ROW_CAP && (
                <div className="px-6 py-4 text-center text-xs text-gray-400">
                  Showing the top {shown} of {groupedFiltered.length.toLocaleString('en-IN')} incident groups - search or filter to narrow.
                </div>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {/* Render only the top slice - painting 8k+ rows is what made this
                  page janky (the backend is fast). List is priority-sorted, and
                  search/filters narrow the full set, so the cap only bites when
                  unfiltered. */}
              {filtered.slice(0, ROW_CAP).map(a => renderCaseRow(a))}
              {filtered.length > ROW_CAP && (
                <li className="px-6 py-4 text-center text-xs text-gray-400">
                  Showing the top {shown} of {filtered.length.toLocaleString('en-IN')} - search or filter to narrow.
                </li>
              )}
            </ul>
          )}
        </div>

        {/* Detail panel */}
        {selectedId && (
          <div className="w-2/5 overflow-y-auto rounded-3xl bg-white">
            {detailLoading || !selectedAlert ? (
              loading || detailLoading ? <DetailSkeleton /> : (
                <div className="p-6">
                  <EmptyState
                    title="This case is not in the current alert set"
                    body={`${selectedId} was not found. It may come from an older pipeline run.`}
                    action={<Button variant="secondary" size="sm" onClick={() => { setSelectedId(null); setParams({}); }}>Close</Button>}
                  />
                </div>
              )
            ) : (
              <div className="space-y-6 p-6">
                {/* Summary + the one primary action */}
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="num text-xs text-gray-400">
                        {selectedAlert.alert_id}
                        {caseDetail?.incident_id && (
                          <>
                            {' | '}
                            <button type="button" onClick={() => navigate('/incidents')} className="hover:text-gray-900 hover:underline">
                              {caseDetail.incident_id}
                            </button>
                          </>
                        )}
                      </p>
                      <h2 className="mt-1 text-lg font-semibold tracking-tight text-gray-900">{selectedAlert.pattern_type}</h2>
                    </div>
                    <button
                      type="button"
                      aria-label="Close case"
                      onClick={() => { setSelectedId(null); setParams({}); }}
                      className="-mr-2 -mt-1 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <SeverityPill severity={selectedAlert.severity} />
                    <StatusPill status={caseDetail?.status} />
                    <EscalationBadge escalation={selectedAlert.escalation} />
                  </div>
                  {selectedAlert.tier && (
                    <p className="mt-2 text-xs text-gray-500">
                      {TIER_META[selectedAlert.tier]?.title}
                      {selectedAlert.corroborated_by?.length
                        ? ` - corroborated by: ${selectedAlert.corroborated_by.join(', ')}`
                        : ''}
                    </p>
                  )}
                  {selectedAlert.escalation?.level > 1 && (
                    <p className="mt-1 text-xs text-gray-500">
                      {selectedAlert.escalation.label} - {selectedAlert.escalation.entity || 'this entity'} re-flagged
                      across {selectedAlert.escalation.hit_count} time windows
                      {selectedAlert.escalation.windows?.length
                        ? ` (#${selectedAlert.escalation.windows.join(', #')})` : ''}
                    </p>
                  )}
                  <p className="mt-3 text-sm leading-relaxed text-gray-700">{selectedAlert.description}</p>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button onClick={() => navigate(`/journey?alert=${selectedId}`)}>Trace the money</Button>
                    <Button variant="secondary" onClick={downloadFiuPackage} disabled={actionLoading}>FIU package</Button>
                  </div>
                </div>

                {selectedAlert.recommendation && (
                  <div className="rounded-2xl bg-gray-50 px-4 py-3">
                    <p className="flex items-center gap-2 text-xs font-medium text-gray-700">
                      <span className="h-2 w-2 rounded-full bg-[#f2c94c]" />Recommended next step
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-gray-600">{selectedAlert.recommendation}</p>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <Fact label="Total flow (as recorded)" title={AMOUNT_TITLE}>
                    <span className="num">{formatAmount(selectedAlert.total_flow)}</span>
                  </Fact>
                  <Fact label="Detector confidence"><span className="num">{selectedAlert.confidence}%</span></Fact>
                  <Fact label="ML score"><div className="pt-1"><MLScoreBar score={selectedAlert.ml_score} wide /></div></Fact>
                  <Fact label="Accounts"><span className="num">{selectedAlert.entities?.length || 0}</span></Fact>
                </div>

                {selectedAlert.card_number && (
                  <div className="flex items-center justify-between gap-3 rounded-2xl bg-gray-50 px-4 py-3">
                    <div>
                      <p className="text-xs text-gray-500">Card on file (PCI DSS protected)</p>
                      <p className="num mt-1 text-sm text-gray-900">
                        {unmaskedCard || selectedAlert.card_number}
                      </p>
                    </div>
                    {!unmaskedCard && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleRevealCard}
                        className="whitespace-nowrap"
                        disabled={role === 'INVESTIGATOR'}
                        title={role === 'INVESTIGATOR' ? "PCI DSS Req 7: Supervisor role required to unmask card numbers." : "Unmask card - recorded in the audit log"}
                      >
                        Reveal card{role === 'INVESTIGATOR' && <span className="font-normal">(supervisor)</span>}
                      </Button>
                    )}
                  </div>
                )}

                {/* SHAP - visual top-features bar chart */}
                {explanation && (
                  <div>
                    <SectionLabel
                      action={
                        <span className="text-xs text-gray-500">
                          Predicted <span className="num font-medium text-gray-900">{(explanation.predicted_proba * 100).toFixed(1)}%</span>
                        </span>
                      }
                    >
                      Why the model scored it this way (SHAP)
                    </SectionLabel>
                    <div className="space-y-1.5">
                      {(() => {
                        const features = (explanation.top_features || []).slice(0, 6);
                        if (features.length === 0) return (
                          <p className="text-xs text-gray-500">No feature attributions available.</p>
                        );
                        const maxAbs = Math.max(...features.map(x => Math.abs(x.shap))) || 1;
                        return features.map((f) => {
                          const pct = (Math.abs(f.shap) / maxAbs) * 100;
                          const positive = f.shap > 0;
                          return (
                            <div key={f.feature} className="flex items-center gap-2 text-[11px]">
                              <span className="w-32 truncate text-gray-700" title={f.feature}>{f.feature}</span>
                              <span className="num w-14 shrink-0 text-right text-gray-400">{Number(f.value).toFixed(2)}</span>
                              <div className="relative h-2 flex-1 rounded-full bg-gray-100">
                                <div
                                  className={`absolute top-0 h-2 rounded-full ${positive ? 'left-1/2 bg-[#e8743b]' : 'right-1/2 bg-lime'}`}
                                  style={{ width: `${pct / 2}%` }}
                                />
                                <div className="absolute left-1/2 top-0 h-2 w-px bg-gray-300" />
                              </div>
                              <span className="num w-14 shrink-0 text-right text-gray-600">
                                {f.shap > 0 ? '+' : ''}{f.shap.toFixed(3)}
                              </span>
                            </div>
                          );
                        });
                      })()}
                    </div>
                    <p className="mt-2 text-[11px] text-gray-400">
                      Orange pushed the score up, green pulled it down. Longer bar = bigger effect.
                      {explanation.edge && <span className="num ml-1">Edge {explanation.edge}.</span>}
                    </p>
                  </div>
                )}

                {!explanation && selectedAlert.ml_score != null && (
                  <p className="text-xs text-gray-400">
                    Feature attribution (SHAP) is not available for this case right now - the ML score above still applies.
                  </p>
                )}

                {/* Dominant-path preview - top fund corridor downstream of the alert */}
                {tracePreview && tracePreview.dominant_paths?.length > 0 && (
                  <div>
                    <SectionLabel
                      action={
                        <button
                          type="button"
                          onClick={() => navigate(`/journey?alert=${selectedId}`)}
                          className="text-xs text-gray-500 hover:text-gray-900 hover:underline"
                        >
                          Full trace {'->'}
                        </button>
                      }
                    >
                      Where did the funds go?
                    </SectionLabel>
                    <div className="space-y-2">
                      {tracePreview.dominant_paths.slice(0, 2).map((dp, i) => (
                        <div key={i} className="rounded-2xl bg-gray-50 px-4 py-3 text-xs">
                          <p className="text-gray-500">
                            risk <span className="num font-medium text-gray-900">{(dp.path_risk_score ?? 0).toFixed(2)}</span>
                            {' | '}
                            <span title={AMOUNT_TITLE}>bottleneck <span className="num font-medium text-gray-900">{formatAmount(dp.bottleneck_amount)}</span></span>
                            {' | '}{dp.hops} hops
                          </p>
                          <p className="num mt-1 leading-snug text-gray-800">
                            {(dp.path || []).join(' -> ')}
                          </p>
                          {dp.path_flags?.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {dp.path_flags.slice(0, 5).map((f) => <FlagPill key={f} flag={f} />)}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    {Object.keys(tracePreview.terminal_classification || {}).length > 0 && (
                      <p className="mt-2 text-xs text-gray-500">
                        Lands in:{' '}
                        {Object.entries(tracePreview.terminal_classification).map(([cat, ids], i) => (
                          <span key={cat}>
                            {i > 0 && ' | '}
                            <span className="capitalize text-gray-700">{cat.replace('_', ' ')}</span>
                            <span className="num ml-1 text-gray-400">x{ids.length}</span>
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                )}

                {selectedAlert.entities && selectedAlert.entities.length > 0 && (
                  <div>
                    <SectionLabel>Accounts involved</SectionLabel>
                    <ol className="space-y-1">
                      {selectedAlert.entities.map((eid, i) => {
                        const name = selectedAlert.entity_names?.[i] || eid;
                        const flags = entityFlags[eid] || [];
                        return (
                          <li key={eid} className="flex items-start gap-3 rounded-xl px-2 py-1.5 hover:bg-gray-50">
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[10px] font-semibold text-gray-600">
                              {i + 1}
                            </span>
                            <span className="num shrink-0 pt-0.5 text-xs text-gray-900">{name}</span>
                            {flags.length > 0 && (
                              <div className="flex min-w-0 flex-wrap gap-1">
                                {flags.map((f) => <FlagPill key={f} flag={f} />)}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                )}

                {/* Decision */}
                <div className="border-t border-gray-100 pt-5">
                  <SectionLabel>Record a decision</SectionLabel>
                  <textarea
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    placeholder="Add an investigator note (optional)..."
                    rows={2}
                    className="w-full rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-gray-300"
                  />
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <Button variant="secondary" onClick={() => disposeCase('INVESTIGATING')} disabled={actionLoading}>
                      Mark investigating
                    </Button>
                    <Button variant="secondary" onClick={() => disposeCase('ESCALATED')} disabled={actionLoading}>
                      Escalate
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => disposeCase('SAR_FILED')}
                      disabled={actionLoading || !canSAR}
                      title={!canSAR ? LOCKED : undefined}
                    >
                      File SAR{!canSAR && <span className="text-xs font-normal text-gray-500">(supervisor)</span>}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => disposeCase('DISMISSED')}
                      disabled={actionLoading || !canDismiss}
                      title={!canDismiss ? LOCKED : undefined}
                    >
                      Dismiss{!canDismiss && <span className="text-xs font-normal text-gray-500">(supervisor)</span>}
                    </Button>
                  </div>
                  {note && (
                    <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={addNote} disabled={actionLoading}>
                      Add note only (no status change)
                    </Button>
                  )}
                  {(!canSAR || !canDismiss) && (
                    <p className="mt-2 text-xs text-gray-400">Filing a SAR and dismissing need a supervisor. Your note and status changes go to the audit log.</p>
                  )}
                </div>

                {/* Hash chain verify */}
                <div className="border-t border-gray-100 pt-5">
                  <SectionLabel
                    action={
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={verifyChain}
                        disabled={!canVerify || actionLoading}
                        title={!canVerify ? LOCKED : 'Recompute every hash in this case audit chain'}
                      >
                        Verify chain{!canVerify && ' (supervisor)'}
                      </Button>
                    }
                  >
                    Audit log - tamper-evident
                  </SectionLabel>
                  {chainStatus && (
                    <div role="status" className="mb-3 flex items-start gap-2 rounded-xl bg-gray-50 px-3 py-2 text-xs text-gray-700">
                      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${chainStatus.verified ? 'bg-lime' : 'bg-[#e8743b]'}`} />
                      <span>
                        {chainStatus.error
                          ? 'Could not verify the chain - the backend did not answer.'
                          : chainStatus.verified
                            ? `Chain intact - ${chainStatus.entries} entries${chainStatus.head_hash ? `. Head: ${chainStatus.head_hash.slice(0, 12)}...` : '.'}`
                            : `Tampering detected at entry ${chainStatus.tampered_at}: ${chainStatus.message}`}
                      </span>
                    </div>
                  )}
                  {caseDetail?.audit_log && caseDetail.audit_log.length > 0 ? (
                    <ol className="space-y-3">
                      {[...caseDetail.audit_log].reverse().map((entry, i) => (
                        <li key={i} className="border-l-2 border-gray-100 pl-3 text-xs">
                          <p className="text-gray-500">
                            <span className="font-medium text-gray-900">{entry.action}</span>
                            {' | '}{entry.author}
                            {' | '}<span className="num">{entry.timestamp?.slice(0, 19).replace('T', ' ')}</span>
                          </p>
                          {entry.note && <p className="mt-1 text-gray-700">{entry.note}</p>}
                          {entry.this_hash && (
                            <p className="num mt-0.5 text-[10px] text-gray-400">
                              hash {entry.this_hash.slice(0, 16)}...
                            </p>
                          )}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-xs text-gray-400">No entries yet. Every note and decision on this case is added here and hash-chained.</p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
