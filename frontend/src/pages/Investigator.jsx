import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchAPI, getRole, getGraphdbStatus, getInvestigations, getInvestigation,
  getEvidenceSubgraph, reviewDecision, streamInvestigation, getDecisionTrail,
} from '../api';
import StepList from '../components/investigator/StepList';
import EvidenceGraph from '../components/investigator/EvidenceGraph';
import VerdictCard from '../components/investigator/VerdictCard';
import DecisionTrail from '../components/investigator/DecisionTrail';

const IDENTITY_PROMPT = 'Is ACC00045 part of a mule ring? Check shared devices and KYC.';

function fmt(n) {
  return Number(n || 0).toLocaleString('en-IN');
}

function Tile({ value, label, sub, accent }) {
  return (
    <div className="rounded-3xl bg-white p-5">
      <p className="text-xs text-gray-400">{label}</p>
      <p className="num mt-2 text-3xl font-semibold tracking-tight text-gray-900">{value}</p>
      {sub && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-gray-500">
          {accent && <span className="h-2 w-2 rounded-full" style={{ background: accent }} />}
          {sub}
        </p>
      )}
    </div>
  );
}

function StatusTiles({ status, err }) {
  if (err) {
    return <div className="rounded-3xl bg-white p-5 text-sm text-red-600">{err}</div>;
  }
  const l = status?.labels || {};
  const r = status?.relationships || {};
  const BRAIN = { llm: 'Claude', gemini: 'Gemini', playbook: 'Autopilot' };
  const brain = !status ? '' : status.agent_mode === 'playbook'
    ? 'Graph-driven autopilot (no LLM key)'
    : `${BRAIN[status.agent_mode]} (${status.agent_model})`;
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Tile value={fmt(l.Account)} label="Accounts in the context graph" sub={`FalkorDB graph "${status?.graph || 'rudra'}"`} accent="#a6d65c" />
      <Tile value={fmt(r.TXN)} label="Transactions (one edge each)" sub={`${fmt(l.Alert)} alerts, ${fmt(l.Incident)} incidents`} accent="#f2c94c" />
      <Tile value={fmt(l.Investigation)} label="Investigations in memory" sub={`${fmt(l.Finding)} findings, ${fmt(l.Decision)} decisions`} accent="#e8743b" />
      <Tile value={status ? BRAIN[status.agent_mode] || '-' : '-'} label="Agent brain" sub={brain ? `${brain} - tools via ${status.transport === 'direct' ? 'in-process' : 'MCP'}` : ''} accent="#161814" />
    </div>
  );
}

function RemovalCompare({ runs }) {
  const on = runs.graph;
  const off = runs.flat;
  if (!on || !off) return null;
  const row = (r) => ({
    steps: r.steps,
    graphFindings: (r.findings || []).filter((f) => f.provenance === 'GRAPH').length,
    action: (r.decisions || []).map((d) => `${d.action || d.status}`).join(', ') || 'none',
  });
  const a = row(on);
  const b = row(off);
  const Bar = ({ v, max, c }) => (
    <div className="h-2.5 w-full rounded-full bg-gray-100"><div className="h-2.5 rounded-full" style={{ width: `${max ? (v / max) * 100 : 0}%`, background: c }} /></div>
  );
  const maxSteps = Math.max(a.steps, b.steps, 1);
  const maxG = Math.max(a.graphFindings, b.graphFindings, 1);
  return (
    <div className="rounded-3xl bg-white p-6">
      <p className="text-sm font-medium text-gray-900">Removal test</p>
      <p className="text-xs text-gray-400">Same question, graph tools on vs off</p>
      <div className="mt-4 space-y-4 text-xs">
        {[['Tool calls', a.steps, b.steps, maxSteps], ['Graph findings', a.graphFindings, b.graphFindings, maxG]].map(([label, x, y, m]) => (
          <div key={label}>
            <div className="mb-1.5 flex justify-between text-gray-500"><span>{label}</span><span className="num text-gray-900">{x} vs {y}</span></div>
            <div className="space-y-1"><Bar v={x} max={m} c="#a6d65c" /><Bar v={y} max={m} c="#d2d2cd" /></div>
          </div>
        ))}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <div className="rounded-2xl bg-gray-50 p-3"><p className="text-gray-400">Graph on</p><p className="mt-1 font-medium text-gray-900">{on.verdict} | {a.action}</p></div>
          <div className="rounded-2xl bg-gray-50 p-3"><p className="text-gray-400">Graph off</p><p className="mt-1 font-medium text-gray-900">{off.verdict} | {b.action}</p></div>
        </div>
      </div>
    </div>
  );
}

const VERDICT_DOT = { ESCALATE: '#e8743b', REVIEW: '#f2c94c', CLEAR_RECOMMENDED: '#a6d65c', UNCERTAIN: '#a3a39d' };

function MemoryList({ history, onOpen }) {
  return (
    <div className="rounded-3xl bg-white p-6">
      <div className="flex items-baseline justify-between">
        <div>
          <p className="text-sm font-medium text-gray-900">Investigation memory</p>
          <p className="text-xs text-gray-400">Stored in FalkorDB - click to replay</p>
        </div>
        <span className="text-xs text-gray-400">{history.length} total</span>
      </div>
      {history.length === 0 ? (
        <p className="mt-6 text-xs text-gray-400">No investigations yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-gray-100">
          {history.slice(0, 12).map((h) => (
            <li key={h.id}>
              <button type="button" onClick={() => onOpen(h.id)} className="flex w-full items-center gap-3 py-3 text-left hover:bg-gray-50">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gray-100">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: VERDICT_DOT[h.verdict] || '#d2d2cd' }} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-gray-900">{h.question}</span>
                  <span className="block text-[11px] text-gray-400">
                    {h.started_at ? new Date(h.started_at * 1000).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : ''} | {h.steps} steps | {h.mode}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-medium text-gray-900">{h.verdict || h.status}</span>
                  {h.pending_decisions > 0 && <span className="block text-[11px] text-[#86760f]">{h.pending_decisions} pending</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Investigator() {
  const [status, setStatus] = useState(null);
  const [statusErr, setStatusErr] = useState(null);
  const [question, setQuestion] = useState('');
  const [graphTools, setGraphTools] = useState(true);
  const [mode, setMode] = useState('');
  const [prompts, setPrompts] = useState([]);
  const [running, setRunning] = useState(false);
  const [mcp, setMcp] = useState(null);
  const [items, setItems] = useState([]);
  const [verdict, setVerdict] = useState(null);
  const [summary, setSummary] = useState('');
  const [subgraph, setSubgraph] = useState(null);
  const [trail, setTrail] = useState(null);
  const [tab, setTab] = useState('money');
  const [history, setHistory] = useState([]);
  const [runs, setRuns] = useState({});
  const [error, setError] = useState(null);
  const [reviewMsg, setReviewMsg] = useState('');
  const evidence = useRef({ accounts: new Set(), tids: new Set() });
  const abort = useRef(null);
  const role = getRole();
  const canReview = role === 'SUPERVISOR' || role === 'ADMIN';

  const refreshHistory = useCallback(() => {
    getInvestigations().then(setHistory).catch(() => {});
  }, []);

  useEffect(() => {
    getGraphdbStatus().then(setStatus).catch((e) => setStatusErr(String(e.message || e)));
    refreshHistory();
    fetchAPI('/api/incidents')
      .then((incs) => {
        const list = Array.isArray(incs) ? incs : incs.incidents || [];
        const top = [...list].sort((x, y) => (y.total_flow || 0) - (x.total_flow || 0));
        const circ = top.find((i) => /circular/i.test(i.primary_pattern || ''));
        const p = [];
        if (circ) p.push(`Investigate incident ${circ.incident_id}`);
        if (top[0]) p.push(`Investigate incident ${top[0].incident_id}`);
        p.push(IDENTITY_PROMPT);
        setPrompts([...new Set(p)]);
      })
      .catch(() => setPrompts([IDENTITY_PROMPT]));
  }, [refreshHistory]);

  // Deep link from the top-bar ask box: /investigator?q=... runs once on mount.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q');
    if (!q) return undefined;
    const t = setTimeout(() => run(q), 0);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pullSubgraph = useCallback(() => {
    const a = [...evidence.current.accounts].slice(0, 80);
    const t = [...evidence.current.tids].slice(0, 300);
    if (!a.length && !t.length) return;
    getEvidenceSubgraph(a, t).then(setSubgraph).catch(() => {});
  }, []);

  async function run(q, toolsOn = graphTools) {
    const text = (q ?? question).trim();
    if (!text || running) return;
    setQuestion(text);
    setRunning(true);
    setItems([]);
    setVerdict(null);
    setSummary('');
    setSubgraph(null);
    setTrail(null);
    setMcp(null);
    setError(null);
    setReviewMsg('');
    evidence.current = { accounts: new Set(), tids: new Set() };
    abort.current = new AbortController();
    let pending = null;
    try {
      await streamInvestigation(
        { question: text, graph_tools: toolsOn, ...(mode ? { mode } : {}) },
        (ev) => {
          if (ev.type === 'mcp') setMcp(ev);
          else if (ev.type === 'thinking') setItems((xs) => [...xs, ev]);
          else if (ev.type === 'step') {
            setItems((xs) => [...xs, ev]);
            (ev.accounts || []).forEach((x) => evidence.current.accounts.add(x));
            (ev.tids || []).forEach((x) => evidence.current.tids.add(x));
            clearTimeout(pending);
            pending = setTimeout(pullSubgraph, 250);
          } else if (ev.type === 'verdict') {
            setVerdict(ev);
            getDecisionTrail(ev.investigation_id).then(setTrail).catch(() => {});
            setRuns((r) => ({ ...r, [toolsOn ? 'graph' : 'flat']: { ...ev, q: text } }));
          } else if (ev.type === 'token') setSummary((s) => s + ev.text);
          else if (ev.type === 'error') setError(ev.message);
        },
        abort.current.signal,
      );
    } catch (e) {
      if (e.name !== 'AbortError') setError(String(e.message || e));
    } finally {
      setRunning(false);
      refreshHistory();
      getGraphdbStatus().then(setStatus).catch(() => {});
    }
  }

  async function openPast(id) {
    if (running) return;
    setError(null);
    setReviewMsg('');
    try {
      const tr = await getInvestigation(id);
      setQuestion(tr.question);
      setMcp(null);
      setItems(tr.steps.map((s) => ({ ...s, type: 'step', args: s.args })));
      setVerdict({ ...(tr.verdict_detail || {}), verdict: tr.verdict, confidence: tr.confidence,
        investigation_id: tr.id, findings: tr.findings, decisions: tr.decisions, precedents: tr.precedents });
      setSummary(tr.summary || '');
      setSubgraph(tr.subgraph);
      getDecisionTrail(id).then(setTrail).catch(() => {});
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  async function onReview(id, approve) {
    try {
      const r = await reviewDecision(id, approve);
      setReviewMsg(approve
        ? `Approved ${id}. ${r.cases_escalated?.length ? `Escalated cases: ${r.cases_escalated.join(', ')} (see Case Workbench).` : ''}`
        : `Rejected ${id}. The rejection is stored as a precedent for future investigations.`);
      if (verdict?.investigation_id) {
        const tr = await getInvestigation(verdict.investigation_id);
        setVerdict((v) => ({ ...v, decisions: tr.decisions }));
        getDecisionTrail(verdict.investigation_id).then(setTrail).catch(() => {});
      }
      refreshHistory();
    } catch (e) {
      setReviewMsg(`Review failed: ${e.message || e}`);
    }
  }

  const stepCount = items.filter((i) => i.type === 'step').length;
  const totalMs = items.filter((i) => i.type === 'step').reduce((a, b) => a + (b.ms || 0), 0);

  return (
    <div className="space-y-3 pb-6">
      <StatusTiles status={status} err={statusErr} />

      <div className="rounded-3xl bg-white p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-2xl font-semibold tracking-tight text-gray-900">Investigator</p>
            <p className="text-xs text-gray-400">Ask about an incident or account. The agent follows the money through the graph and shows its work.</p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <label className="flex cursor-pointer items-center gap-2 rounded-xl bg-gray-50 px-3 py-2 text-gray-700">
              <span className={`relative h-4 w-7 rounded-full transition-colors ${graphTools ? 'bg-gray-900' : 'bg-gray-300'}`}>
                <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${graphTools ? 'left-3.5' : 'left-0.5'}`} />
              </span>
              <input type="checkbox" className="sr-only" checked={graphTools} onChange={(e) => setGraphTools(e.target.checked)} disabled={running} />
              Graph tools
            </label>
            <select value={mode} onChange={(e) => setMode(e.target.value)} disabled={running} className="rounded-xl bg-gray-50 px-3 py-2 text-gray-700 focus:outline-none">
              <option value="">Auto brain</option>
              <option value="llm">Claude</option>
              <option value="gemini">Gemini</option>
              <option value="playbook">Playbook autopilot</option>
            </select>
          </div>
        </div>
        <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); run(); }}>
          <input
            className="min-w-0 flex-1 rounded-2xl bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-lime"
            placeholder="Investigate incident INC-2749, or: Is 222-811D80C30 a mule?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={running}
          />
          {running ? (
            <button type="button" onClick={() => abort.current?.abort()} className="rounded-2xl bg-gray-100 px-5 text-sm font-medium text-gray-700">Stop</button>
          ) : (
            <button type="submit" disabled={!question.trim()} className="rounded-2xl bg-gray-900 px-5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40">Investigate</button>
          )}
        </form>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {prompts.map((p) => (
            <button key={p} type="button" disabled={running} onClick={() => run(p)} className="rounded-full bg-gray-50 px-3 py-1.5 text-xs text-gray-600 hover:bg-[#eef7e0] hover:text-[#4d7a1a] disabled:opacity-50">
              {p}
            </button>
          ))}
          <button type="button" disabled={running || !question.trim()} onClick={() => run(question, !graphTools)} className="ml-auto rounded-full px-3 py-1.5 text-xs font-medium text-gray-900 underline underline-offset-2 disabled:opacity-40" title="Re-run the same question with graph tools toggled">
            Re-run with graph tools {graphTools ? 'off' : 'on'}
          </button>
        </div>
        {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
      </div>

      <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-12">
        <div className="space-y-3 xl:col-span-7">
          <section className="rounded-3xl bg-white p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-gray-900">Reasoning trace</p>
                <p className="text-xs text-gray-400">
                  {mcp ? `${mcp.tools.length} of ${mcp.tools_total} tools discovered via ${mcp.transport} | ${mcp.mode}${mcp.model ? ` (${mcp.model})` : ''}` : 'Every graph call with its Cypher and FalkorDB timing'}
                </p>
              </div>
              {stepCount > 0 && (
                <div className="text-right">
                  <p className="num text-2xl font-semibold tracking-tight text-gray-900">{stepCount}</p>
                  <p className="text-[11px] text-gray-400">tool calls | {totalMs.toFixed(0)} ms in graph</p>
                </div>
              )}
            </div>
            <div className="mt-4">
              {items.length === 0 && !running ? (
                <p className="rounded-2xl bg-gray-50 p-6 text-center text-xs text-gray-400">
                  Ask a question to start. Click any step to see the exact Cypher, its arguments and what came back.
                </p>
              ) : (
                <StepList items={items} running={running} />
              )}
            </div>
          </section>

          <section className="rounded-3xl bg-white p-6">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-gray-900">{tab === 'money' ? 'Evidence subgraph' : 'Decision trail'}</p>
                <p className="text-xs text-gray-400">
                  {tab === 'money'
                    ? 'Accounts and transactions the findings cite, pulled live from FalkorDB'
                    : 'How the answer was reached: findings, the decisions they caused, reviews and precedents'}
                </p>
              </div>
              <div className="flex rounded-xl bg-gray-100 p-1 text-xs">
                {[['money', 'Money'], ['trail', 'Decision trail']].map(([k, label]) => (
                  <button key={k} type="button" onClick={() => setTab(k)}
                    className={`rounded-lg px-3 py-1.5 ${tab === k ? 'bg-white font-medium text-gray-900' : 'text-gray-500'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {tab === 'money' ? <EvidenceGraph data={subgraph} /> : <DecisionTrail data={trail} />}
          </section>

        </div>
        <div className="space-y-3 xl:col-span-5">
          <VerdictCard verdict={verdict} summary={summary} canReview={canReview} onReview={onReview} reviewMsg={reviewMsg} running={running} />
          <RemovalCompare runs={runs} />
          <MemoryList history={history} onOpen={openPast} />
        </div>
      </div>
    </div>
  );
}
