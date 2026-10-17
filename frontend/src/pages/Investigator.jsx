import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchAPI, getRole, getGraphdbStatus, getInvestigations, getInvestigation,
  getEvidenceSubgraph, reviewDecision, streamInvestigation, getDecisionTrail,
} from '../api';
import { Button, Card, Disclosure, SectionHeader, Tabs } from '../components/ui';
import StepList from '../components/investigator/StepList';
import EvidenceGraph from '../components/investigator/EvidenceGraph';
import VerdictCard from '../components/investigator/VerdictCard';
import DecisionTrail from '../components/investigator/DecisionTrail';
import ProgressCard from '../components/investigator/ProgressCard';
import { MemoryList, RemovalCompare } from '../components/investigator/Memory';
import { PHASES } from '../components/investigator/stepText';

const IDENTITY_PROMPT = 'Is ACC00045 part of a mule ring? Check shared devices and KYC.';
const BRAIN = { llm: 'Claude', gemini: 'Gemini', playbook: 'Playbook autopilot' };

const fmt = (n) => Number(n || 0).toLocaleString('en-IN');

function StatusLine({ status, err, mode }) {
  if (err) return <p className="text-xs text-red-600">Graph unavailable: {err}</p>;
  if (!status) return <p className="text-xs text-gray-400">Connecting to the graph...</p>;
  const l = status.labels || {};
  const r = status.relationships || {};
  const auto = status.agent_mode === 'playbook'
    ? 'Playbook autopilot (no LLM key)'
    : `${BRAIN[status.agent_mode] || status.agent_mode}${status.agent_model ? ` (${status.agent_model})` : ''}`;
  const brain = mode ? `${BRAIN[mode]} (chosen)` : auto;
  return (
    <p className="text-xs text-gray-500">
      FalkorDB graph {status.graph || 'rudra'} | {fmt(l.Account)} accounts | {fmt(r.TXN)} transactions | brain: {brain} via {status.transport === 'direct' ? 'in-process tools' : 'MCP'}
    </p>
  );
}

function Toggle({ checked, onChange, disabled, children }) {
  return (
    <label className={`flex items-center gap-2 text-xs text-gray-700 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <span className={`relative h-4 w-7 rounded-full transition-colors ${checked ? 'bg-gray-900' : 'bg-gray-300'}`}>
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${checked ? 'left-3.5' : 'left-0.5'}`} />
      </span>
      <input type="checkbox" className="sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      {children}
    </label>
  );
}

function EmptyStart() {
  return (
    <Card>
      <p className="text-sm font-medium text-gray-900">Nothing investigated yet</p>
      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-gray-500">
        Pick a suggestion above or type your own question. The agent opens the case, follows the money through the graph,
        checks what was decided before, then gives a verdict with the evidence behind it - and proposes actions for a person to approve.
      </p>
      <ol className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {PHASES.map(([key, label], i) => (
          <li key={key} className="text-xs">
            <span className="num text-gray-400">{i + 1}</span>
            <p className="mt-0.5 font-medium text-gray-800">{label}</p>
          </li>
        ))}
      </ol>
    </Card>
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
  const [tab, setTab] = useState('steps');
  const [history, setHistory] = useState([]);
  const [runs, setRuns] = useState({});
  const [error, setError] = useState(null);
  const [reviewMsg, setReviewMsg] = useState('');
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
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
        // Two contrasting incidents (a cycle if there is one, the biggest flow, another pattern) + the identity lane.
        const other = top.find((i) => i.primary_pattern !== top[0]?.primary_pattern);
        const picks = [circ, top[0], other].filter(Boolean).map((i) => `Investigate incident ${i.incident_id}`);
        setPrompts([...[...new Set(picks)].slice(0, 2), IDENTITY_PROMPT]);
      })
      .catch(() => setPrompts([IDENTITY_PROMPT]));
  }, [refreshHistory]);

  // Deep links: /investigator?q=... runs once; /investigator?open=<id> replays a stored investigation.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    const open = params.get('open');
    if (!q && !open) return undefined;
    const t = setTimeout(() => (open ? openPast(open) : run(q)), 0);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Elapsed-seconds ticker while a run streams.
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);

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
    const t0 = Date.now();
    setStartedAt(t0);
    setNow(t0);
    setItems([]);
    setVerdict(null);
    setSummary('');
    setSubgraph(null);
    setTrail(null);
    setMcp(null);
    setError(null);
    setReviewMsg('');
    setTab('steps');
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
      setStartedAt(0);
      setItems(tr.steps.map((s) => ({ ...s, type: 'step', args: s.args })));
      setVerdict({ ...(tr.verdict_detail || {}), verdict: tr.verdict, confidence: tr.confidence,
        investigation_id: tr.id, findings: tr.findings, decisions: tr.decisions, precedents: tr.precedents,
        steps: tr.steps.length,
        seconds: tr.finished_at && tr.started_at ? Math.round((tr.finished_at - tr.started_at) * 10) / 10 : null });
      setSummary(tr.summary || '');
      setSubgraph(tr.subgraph);
      setTab('steps');
      getDecisionTrail(id).then(setTrail).catch(() => {});
    } catch (e) {
      setError(`Could not open ${id}: ${e.message || e}`);
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

  const steps = items.filter((i) => i.type === 'step');
  const totalMs = steps.reduce((a, b) => a + (b.ms || 0), 0);
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  const howSub = [
    `${steps.length} step${steps.length === 1 ? '' : 's'}`,
    `${totalMs.toFixed(0)} ms in the graph`,
    verdict?.seconds ? `${verdict.seconds}s end to end` : null,
    mcp ? `${mcp.tools.length} of ${mcp.tools_total} tools via ${mcp.transport}${mcp.graph_tools === false ? ' (graph tools off)' : ''}` : null,
  ].filter(Boolean).join(' | ');

  return (
    <div className="space-y-4 pb-8">
      <Card>
        <SectionHeader
          title={<span className="text-2xl font-semibold tracking-tight">Investigate</span>}
          subtitle="Ask about an incident or an account. The agent follows the money through the graph and shows its work."
        />
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); run(); }}>
          <input
            aria-label="Question"
            className="min-w-0 flex-1 rounded-2xl bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-lime"
            placeholder="Investigate incident INC-2749, or: Is 222-811D80C30 a mule?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={running}
          />
          {running ? (
            <Button variant="secondary" className="px-6" onClick={() => abort.current?.abort()}>Stop</Button>
          ) : (
            <Button type="submit" className="px-6" disabled={!question.trim()}>Investigate</Button>
          )}
        </form>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">Try</span>
          {prompts.map((p) => (
            <button key={p} type="button" disabled={running} onClick={() => run(p)}
              className="rounded-full bg-gray-50 px-3 py-1.5 text-xs text-gray-600 hover:bg-[#eef7e0] hover:text-[#4d7a1a] disabled:opacity-50">
              {p}
            </button>
          ))}
        </div>
        {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
        <div className="mt-4">
          <Disclosure label="Options">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl bg-gray-50 px-4 py-3">
              <label className="flex items-center gap-2 text-xs text-gray-700">
                Brain
                <select aria-label="Brain" value={mode} onChange={(e) => setMode(e.target.value)} disabled={running}
                  className="rounded-lg bg-white px-2 py-1.5 text-xs text-gray-800 focus:outline-none">
                  <option value="">Auto</option>
                  <option value="llm">Claude</option>
                  <option value="gemini">Gemini</option>
                  <option value="playbook">Playbook autopilot</option>
                </select>
              </label>
              <Toggle checked={graphTools} onChange={setGraphTools} disabled={running}>Graph tools</Toggle>
              <span className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" className="bg-white" disabled={running || !question.trim()}
                  onClick={() => run(question, !graphTools)}>
                  Run again {graphTools ? 'without' : 'with'} graph tools
                </Button>
                <span className="text-xs text-gray-500">Removal test - shows what the graph adds (compared at the bottom)</span>
              </span>
            </div>
          </Disclosure>
        </div>
        <div className="mt-4 border-t border-gray-100 pt-3">
          <StatusLine status={status} err={statusErr} mode={mode} />
        </div>
      </Card>

      {running && <ProgressCard items={items} mcp={mcp} seconds={seconds} subgraph={subgraph} />}

      {!running && verdict && (
        <VerdictCard verdict={verdict} summary={summary} canReview={canReview} onReview={onReview} reviewMsg={reviewMsg} graphOff={mcp?.graph_tools === false} />
      )}

      {!running && !verdict && items.length > 0 && (
        <Card>
          <p className="text-sm font-medium text-gray-900">Investigation stopped before a verdict</p>
          <p className="mt-1 text-xs text-gray-500">The steps it completed are below. Run it again to get a verdict.</p>
        </Card>
      )}

      {!running && items.length > 0 && (
        <Card>
          <SectionHeader
            title="How it got there"
            subtitle={howSub}
            action={<Tabs tabs={[['steps', 'Steps'], ['money', 'Money trail'], ['trail', 'Decision trail']]} value={tab} onChange={setTab} />}
          />
          {tab === 'steps' && <StepList items={items} />}
          {tab === 'money' && (
            <>
              <p className="mb-3 text-xs text-gray-500">Accounts and transactions the findings cite, pulled live from FalkorDB. Thick dark edges are cited; hover for amounts.</p>
              <EvidenceGraph data={subgraph} height={440} />
            </>
          )}
          {tab === 'trail' && (
            <>
              <p className="mb-3 text-xs text-gray-500">Findings -&gt; the decisions they caused -&gt; human reviews and precedents, as stored in the graph.</p>
              <DecisionTrail data={trail} />
            </>
          )}
        </Card>
      )}

      {!running && !verdict && items.length === 0 && <EmptyStart />}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <div className={runs.graph && runs.flat ? 'lg:col-span-2' : 'lg:col-span-3'}>
          <MemoryList history={history} onOpen={openPast} activeId={verdict?.investigation_id} disabled={running} />
        </div>
        <RemovalCompare runs={runs} />
      </div>
    </div>
  );
}
