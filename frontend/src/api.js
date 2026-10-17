// In dev, vite proxies /api -> http://localhost:8000 (see vite.config.js).
// In a split deployment (e.g. Vercel frontend + separate API host) set
// VITE_API_BASE=https://api.example.com at build time.
export const API = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');

// SSE endpoints bypass the Vite dev proxy, which buffers streamed responses.
export function streamUrl(path) {
  if (API) return `${API}${path}`;
  return import.meta.env.DEV ? `http://localhost:8000${path}` : path;
}

// Current role is held in localStorage so it survives page reloads.
// The Role context (see App.jsx) reads/writes this value.
export function getRole() {
  return localStorage.getItem('rudra_role') || 'INVESTIGATOR';
}

export function setRole(role) {
  localStorage.setItem('rudra_role', role);
}

function withRoleHeaders(extra = {}) {
  return { 'X-User-Role': getRole(), ...extra };
}

// Retry transient network failures (connection reset on first load); HTTP
// errors are not retried.
async function fetchRetry(url, opts, tries = 3) {
  for (let i = 0; ; i += 1) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      if (i >= tries - 1 || e.name === 'AbortError') throw e;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
}

export async function fetchAPI(path) {
  const res = await fetchRetry(`${API}${path}`, { headers: withRoleHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API error: ${res.status} ${text}`);
  }
  return res.json();
}

export async function postAPI(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: withRoleHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`API error: ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export function apiUrl(path) {
  return `${API}${path}`;
}

export const getIncidentRca = (id) => fetchAPI(`/api/incidents/${id}/rca`);
export const getCollusionRings = () => fetchAPI('/api/collusion/rings');

export const getTgnPredictions = (variant) =>
  fetchAPI(`/api/tgn/predictions${variant ? `?variant=${encodeURIComponent(variant)}` : ''}`);

export async function downloadFromAPI(path, filename) {
  const res = await fetch(`${API}${path}`, { headers: withRoleHeaders() });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// -- FalkorDB context graph + investigation agent ---------------------------
export const getGraphdbStatus = () => fetchAPI('/api/graphdb/status');
export const getGraphdbTools = () => fetchAPI('/api/graphdb/tools');
export const getInvestigations = () => fetchAPI('/api/agent/investigations');
export const getDecisionTrail = (id) => fetchAPI(`/api/agent/investigations/${encodeURIComponent(id)}/trail`);
export const getInvestigation = (id) => fetchAPI(`/api/agent/investigations/${encodeURIComponent(id)}`);
export const getEvidenceSubgraph = (accounts = [], tids = []) =>
  fetchAPI(`/api/graphdb/subgraph?accounts=${encodeURIComponent(accounts.join(','))}&tids=${tids.join(',')}`);
export const reviewDecision = (id, approve, note = '') =>
  postAPI(`/api/agent/decisions/${encodeURIComponent(id)}/review`, { approve, note });

// Stream an investigation; calls onEvent for every SSE event. Returns when done.
export async function streamInvestigation(body, onEvent, signal) {
  const res = await fetch(streamUrl('/api/agent/investigate'), {
    method: 'POST',
    headers: withRoleHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text;
    try { detail = JSON.parse(text).detail || text; } catch { /* plain text */ }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try { onEvent(JSON.parse(line.slice(6))); } catch { /* partial line */ }
    }
  }
}

// Today home: pending agent proposals, recent investigations, top incidents, counts.
export const getInbox = () => fetchAPI('/api/agent/inbox');
