// Demo sign-in for the hackathon build. Accounts are local to this demo; the
// role they carry drives the existing X-User-Role RBAC on every API call.
// A production deployment replaces this with the bank's IDP (SSO / LDAP).
import { setRole } from './api';

const SESSION_KEY = 'rudra_session';

export const DEMO_PASSWORD = 'rudra-demo';

export const DEMO_USERS = [
  { email: 'investigator@rudra.demo', name: 'Asha Rao', role: 'INVESTIGATOR', title: 'AML Investigator',
    can: 'Runs investigations, records findings, opens cases' },
  { email: 'supervisor@rudra.demo', name: 'Vikram Mehta', role: 'SUPERVISOR', title: 'Compliance Supervisor',
    can: 'Everything above, plus approves agent proposals and files STRs' },
  { email: 'admin@rudra.demo', name: 'Neha Iyer', role: 'ADMIN', title: 'Platform Admin',
    can: 'Everything above, plus thresholds and model retraining' },
];

export function getSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return s && s.email && s.role ? s : null;
  } catch {
    return null;
  }
}

export function signIn(email, password) {
  const user = DEMO_USERS.find((u) => u.email === String(email || '').trim().toLowerCase());
  if (!user || password !== DEMO_PASSWORD) {
    return { error: 'That email and password do not match a demo account.' };
  }
  const session = { email: user.email, name: user.name, role: user.role, title: user.title, at: Date.now() };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* storage blocked */ }
  setRole(user.role);
  return { session };
}

export function signOut() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ }
}

export function initials(name) {
  return String(name || '?').split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}
