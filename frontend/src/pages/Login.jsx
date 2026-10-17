import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import BrandMark from '../components/BrandMark';
import { Button, Pill } from '../components/ui';
import { DEMO_PASSWORD, DEMO_USERS, initials, signIn } from '../auth';
import { getGraphdbStatus } from '../api';

const ROLE_TONE = { INVESTIGATOR: 'lime', SUPERVISOR: 'yellow', ADMIN: 'gray' };

function GraphMotif() {
  // Quiet decorative network: lime edges converging, one orange node - echoes the mark.
  const nodes = [[60, 70], [170, 40], [280, 90], [110, 170], [230, 190], [340, 160], [170, 280], [300, 300], [60, 300]];
  const edges = [[0, 3], [1, 3], [1, 4], [2, 4], [2, 5], [3, 6], [4, 6], [4, 7], [5, 7], [6, 8]];
  return (
    <svg viewBox="0 0 400 360" className="h-full w-full" aria-hidden="true">
      {edges.map(([a, b]) => (
        <line key={`${a}-${b}`} x1={nodes[a][0]} y1={nodes[a][1]} x2={nodes[b][0]} y2={nodes[b][1]}
          stroke="#a6d65c" strokeOpacity="0.35" strokeWidth="2" />
      ))}
      {nodes.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i === 4 ? 9 : 6} fill={i === 4 ? '#e8743b' : '#a6d65c'} fillOpacity={i === 4 ? 1 : 0.75} />
      ))}
    </svg>
  );
}

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [stats, setStats] = useState(null);

  useEffect(() => {
    getGraphdbStatus().then(setStats).catch(() => {});
  }, []);

  function finish(result) {
    if (result.error) {
      setError(result.error);
      return;
    }
    const to = location.state?.from && location.state.from !== '/login' ? location.state.from : '/';
    navigate(to, { replace: true, state: { welcome: true } });
  }

  function submit(e) {
    e.preventDefault();
    setError('');
    finish(signIn(email, password));
  }

  const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
  const l = stats?.labels || {};
  const r = stats?.relationships || {};

  return (
    <div className="flex min-h-screen gap-3 bg-canvas p-3">
      <aside className="relative hidden w-[46%] flex-col justify-between overflow-hidden rounded-3xl bg-ink p-10 text-white lg:flex">
        <div className="flex items-center gap-3">
          <BrandMark size={44} className="rounded-[11px] ring-1 ring-white/20" />
          <div className="leading-none">
            <p className="text-2xl font-extrabold tracking-tight">RUDRA</p>
            <p className="mt-1 text-xs font-medium text-white/50">Fund-flow intelligence</p>
          </div>
        </div>
        <div className="pointer-events-none absolute inset-x-6 top-1/2 h-[46%] -translate-y-1/2 opacity-90">
          <GraphMotif />
        </div>
        <div className="relative">
          <p className="max-w-sm text-3xl font-semibold leading-tight tracking-tight">Follow the money. Show the evidence.</p>
          {stats && (
            <div className="mt-6 flex gap-8 text-sm">
              <div><p className="num text-xl font-semibold text-lime">{fmt(l.Account)}</p><p className="text-white/50">accounts</p></div>
              <div><p className="num text-xl font-semibold text-lime">{fmt(r.TXN)}</p><p className="text-white/50">transactions</p></div>
              <div><p className="num text-xl font-semibold text-lime">{fmt(l.Incident)}</p><p className="text-white/50">incidents</p></div>
            </div>
          )}
        </div>
      </aside>

      <main className="flex flex-1 items-center justify-center rounded-3xl bg-white p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <BrandMark size={36} />
            <span className="text-xl font-extrabold tracking-tight text-gray-900">RUDRA</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Sign in</h1>
          <form className="mt-6 space-y-3" onSubmit={submit}>
            <label className="block">
              <span className="text-xs font-medium text-gray-600">Work email</span>
              <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="name@bank.in" required
                className="mt-1 w-full rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-lime" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600">Password</span>
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required
                className="mt-1 w-full rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-lime" />
            </label>
            {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
            <Button type="submit" className="w-full">Sign in</Button>
          </form>

          <div className="mt-10">
            <p className="text-xs font-medium text-gray-500">Demo accounts</p>
            <ul className="mt-2 divide-y divide-gray-100">
              {DEMO_USERS.map((u) => (
                <li key={u.email}>
                  <button type="button" onClick={() => { setEmail(u.email); setPassword(DEMO_PASSWORD); finish(signIn(u.email, DEMO_PASSWORD)); }}
                    className="flex w-full items-center gap-3 py-3 text-left hover:bg-gray-50" title={u.can}>
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-900 text-xs font-semibold text-white">{initials(u.name)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-gray-900">{u.name}</span>
                      <span className="block truncate text-xs text-gray-500">{u.title}</span>
                    </span>
                    <Pill tone={ROLE_TONE[u.role]}>{u.role.charAt(0) + u.role.slice(1).toLowerCase()}</Pill>
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-[11px] text-gray-400">Demo environment. Password for all accounts: {DEMO_PASSWORD}</p>
          </div>
        </div>
      </main>
    </div>
  );
}
