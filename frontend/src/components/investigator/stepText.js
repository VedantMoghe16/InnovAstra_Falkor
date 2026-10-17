// Plain-language translation of agent tool calls, so an investigator reads
// "Followed the money forward from X: 10 chains" instead of `trace_funds`.
import { formatUsd } from '../../format';

export const PHASES = [
  ['orient', 'Orient', 'Opening the case'],
  ['money', 'Follow the money', 'Following the money'],
  ['memory', 'Check memory', 'Checking past decisions'],
  ['decide', 'Decide', 'Deciding'],
];

const PHASE_OF = {
  get_incident: 'orient', account_profile: 'orient', get_playbook: 'orient', list_incidents: 'orient',
  search_alerts: 'orient', get_graph_schema: 'orient',
  trace_funds: 'money', find_cycles: 'money', k_hop_neighbourhood: 'money', shortest_path: 'money',
  pagerank_hubs: 'money', community_of: 'money', shared_identifier_ring: 'money',
  refresh_graph_analytics: 'money', run_cypher_readonly: 'money',
  find_precedents: 'memory',
  record_finding: 'decide', propose_action: 'decide', draft_str: 'decide',
};

export const ACTION_TOOLS = new Set(['record_finding', 'propose_action', 'draft_str']);

// Orient-type lookups made after the agent started following the money are
// part of following a lead (profiling the next account), not re-orienting.
export function phaseFor(tool, moneyStarted) {
  const p = PHASE_OF[tool] || 'money';
  return p === 'orient' && moneyStarted ? 'money' : p;
}

// Assign a phase to every step, in order. Thinking notes attach to the phase
// of the step that follows them (or the last phase seen).
export function withPhases(items) {
  let moneyStarted = false;
  let last = 'orient';
  const out = items.map((it) => {
    if (it.type !== 'step') return { ...it, phase: null };
    const phase = phaseFor(it.tool, moneyStarted);
    if (phase === 'money') moneyStarted = true;
    last = phase;
    return { ...it, phase };
  });
  let next = last;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i].phase) next = out[i].phase;
    else out[i].phase = next;
  }
  return out;
}

export function currentPhase(items) {
  const steps = withPhases(items).filter((s) => s.type === 'step');
  return steps.length ? steps[steps.length - 1].phase : 'orient';
}

const n = (v) => Math.round(Number(v || 0)).toLocaleString('en-IN');
const plural = (k, one, many = `${one}s`) => `${n(k)} ${Number(k) === 1 ? one : many}`;
const ACTION_LABEL = {
  escalate: 'Escalate', draft_str: 'File an STR', open_case: 'Open a case', monitor: 'Monitor',
  request_edd: 'Request enhanced due diligence', clear: 'Clear', dismiss: 'Dismiss', close: 'Close',
};
export const actionLabel = (a) => ACTION_LABEL[a] || String(a || 'action').replace(/_/g, ' ');

function clip(s, len = 90) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > len ? `${t.slice(0, len - 3)}...` : t;
}

// One human sentence for a step. Works with live events (metrics + preview)
// and with replayed ones (args + rows only).
export function stepSentence(step) {
  const a = step.args || {};
  const m = step.metrics || {};
  const has = Object.keys(m).length > 0;
  const acct = a.account_id || '';
  const rows = Number(step.rows || 0);
  if (step.error) return `${step.tool.replace(/_/g, ' ')} could not run: ${clip(step.error, 120)}`;
  let s;
  switch (step.tool) {
    case 'get_incident':
      s = `Opened incident ${a.incident_id || ''}${m.severity ? ` (${String(m.severity).toLowerCase()} severity)` : ''}`;
      break;
    case 'account_profile':
      s = `Checked the profile of ${acct}${m.max_ml_score ? ` - highest ML risk ${Number(m.max_ml_score).toFixed(2)}` : ''}`;
      break;
    case 'get_playbook':
      s = `Loaded the investigation playbook for ${a.typology || 'this pattern'}`;
      break;
    case 'list_incidents':
      s = `Listed open incidents${a.severity ? ` of ${a.severity} severity` : ''}: ${plural(rows, 'incident')}`;
      break;
    case 'search_alerts':
      s = `Searched alerts for "${clip(a.query, 40)}": ${plural(rows, 'match', 'matches')}`;
      break;
    case 'get_graph_schema':
      s = 'Read the graph schema to know what can be asked';
      break;
    case 'trace_funds': {
      const dir = (m.direction || a.direction) === 'backward' ? 'back to its source' : 'forward';
      const chains = has ? m.chains : rows;
      s = chains
        ? `Followed the money ${dir} from ${acct}: ${plural(chains, 'chain')}${m.trace_hops ? `, longest ${plural(m.trace_hops, 'hop')}` : ''}`
        : `Followed the money ${dir} from ${acct}: no onward chain in the time window`;
      if (m.labelled_fraud_hops) s += ` (${plural(m.labelled_fraud_hops, 'labelled laundering hop')})`;
      break;
    }
    case 'find_cycles': {
      const found = has ? m.cycle_found : rows > 0;
      s = found
        ? `Found money returning to ${acct}: ${plural(has ? m.cycles : rows, 'cycle')}${m.max_cycle_flow ? `, largest moves ${formatUsd(m.max_cycle_flow)}` : ''}`
        : `Looked for money returning to ${acct}: no cycle found`;
      break;
    }
    case 'k_hop_neighbourhood':
      s = `Mapped who ${acct} transacts with: ${plural(has ? m.neighbours : rows, 'account')}${m.flagged_neighbours ? `, ${n(m.flagged_neighbours)} already flagged` : ''}`;
      break;
    case 'shortest_path': {
      const ok = has ? m.connected : rows > 0;
      s = ok
        ? `Found a money path from ${a.source_id} to ${a.target_id}${m.length ? ` in ${plural(m.length, 'hop')}` : ''}`
        : `Looked for a money path from ${a.source_id} to ${a.target_id}: not connected`;
      break;
    }
    case 'pagerank_hubs':
      s = `Ranked the most central accounts${a.around_account ? ` around ${a.around_account}` : ''}: ${plural(rows, 'hub')}`;
      break;
    case 'community_of':
      s = has && m.community_size
        ? `Checked the community ${acct} belongs to: ${n(m.community_size)} accounts, ${((m.flagged_ratio || 0) * 100).toFixed(1)}% flagged`
        : `Checked the community ${acct} belongs to`;
      break;
    case 'shared_identifier_ring': {
      const size = has ? m.ring_size : rows;
      s = size
        ? `Checked shared devices, IPs and KYC for ${acct}: ring of ${plural(size, 'account')}`
        : `Checked shared devices, IPs and KYC for ${acct}: nothing shared`;
      break;
    }
    case 'refresh_graph_analytics':
      s = 'Refreshed graph analytics (central accounts and communities)';
      break;
    case 'run_cypher_readonly':
      s = `Ran a custom read-only graph query: ${plural(rows, 'row')}`;
      break;
    case 'find_precedents': {
      const k = has ? m.precedents : rows;
      const who = acct || a.typology || 'this case';
      s = k
        ? `Checked past decisions about ${who}: ${plural(k, 'precedent')}${has ? `, ${n(m.reviewed)} reviewed by a person` : ''}`
        : `Checked past decisions about ${who}: none on record`;
      break;
    }
    case 'record_finding': {
      const d = step.preview || {};
      const prov = d.provenance || a.provenance;
      const cites = d.tids_cited ? ` (${n(d.tids_verified)} of ${n(d.tids_cited)} cited transactions verified)` : '';
      s = `Recorded a ${prov ? `${String(prov).toLowerCase()} ` : ''}finding${a.claim ? `: ${clip(a.claim, 110)}` : ''}${cites}`;
      break;
    }
    case 'propose_action':
    case 'draft_str': {
      const d = step.preview || {};
      const req = actionLabel(d.action_requested || a.action || step.tool);
      if (d.status === 'executed') {
        s = `Did it: ${req}${d.executed ? ` - ${plural(d.executed.accounts_placed, 'account')} on ${d.executed.watchlist}` : ''} (reversible)`;
      } else if (d.status) {
        const fin = d.action_final && d.action_final !== d.action_requested ? `; policy changed it to ${actionLabel(d.action_final)}` : '';
        s = `Proposed: ${req}${fin}${d.status === 'proposed' ? ' - waits for a supervisor' : ` - ${d.status}`}`;
      } else {
        s = step.tool === 'draft_str' ? 'Drafted a suspicious transaction report (STR)' : `Proposed: ${req}`;
      }
      break;
    }
    default:
      s = `${step.tool.replace(/_/g, ' ')}: ${plural(rows, 'row')}`;
  }
  return step.timed_out ? `${s} (timed out, partial result)` : s;
}
