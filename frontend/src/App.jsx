import { Component, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, useNavigate, useLocation } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Cases from './pages/Cases';
import Incidents from './pages/Incidents';
import Journey from './pages/Journey';
import Graph from './pages/Graph';
import Analytics from './pages/Analytics';
import Live from './pages/Live';
import ModelMetrics from './pages/ModelMetrics';
import Patterns from './pages/Patterns';
import Entities from './pages/Entities';
import Copilot from './pages/Copilot';
import SarReports from './pages/SarReports';
import Settings from './pages/Settings';
import AccountAggregator from './pages/AccountAggregator';
import SimulationStudio from './pages/SimulationStudio';
import GeoMap from './pages/GeoMap';
import Replay from './pages/Replay';
import Collusion from './pages/Collusion';
import Investigator from './pages/Investigator';
import { getRole, setRole } from './api';

class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="p-8">
          <h1 className="text-xl font-bold text-red-600 mb-2">React Error</h1>
          <pre className="bg-red-50 p-4 rounded text-sm overflow-auto whitespace-pre-wrap">
            {this.state.error.message}{'\n\n'}{this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const ICONS = {
  investigator: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7',
  dashboard: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1',
  incidents: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  cases: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
  journey: 'M13 7l5 5m0 0l-5 5m5-5H6',
  graph: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1',
  analytics: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  live: 'M13 10V3L4 14h7v7l9-11h-7z',
  model: 'M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z',
  patterns: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  entities: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
  copilot: 'M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z',
  sar: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  settings: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z',
  aa: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
  simulate: 'M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5',
  map: 'M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7',
  replay: 'M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  collusion: 'M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z',
};

const NAV_GROUPS = [
  {
    title: 'Investigate',
    items: [
      { to: '/', label: 'Dashboard', icon: ICONS.dashboard },
      { to: '/incidents', label: 'Incidents', icon: ICONS.incidents },
      { to: '/cases', label: 'Case Workbench', icon: ICONS.cases },
      { to: '/journey', label: 'Fund Journey', icon: ICONS.journey },
      { to: '/replay', label: 'Temporal Replay', icon: ICONS.replay },
      { to: '/graph', label: 'Network Graph', icon: ICONS.graph },
    ],
  },
  {
    title: 'Analyse',
    items: [
      { to: '/analytics', label: 'Channel / Branch', icon: ICONS.analytics },
      { to: '/map', label: 'Geo Map', icon: ICONS.map },
      { to: '/patterns', label: 'Pattern Library', icon: ICONS.patterns },
      { to: '/entities', label: 'Entity Explorer', icon: ICONS.entities },
      { to: '/collusion', label: 'Collusion Rings', icon: ICONS.collusion },
      { to: '/model', label: 'ML Models', icon: ICONS.model },
    ],
  },
  {
    title: 'Act',
    items: [
      { to: '/investigator', label: 'Investigator Agent', icon: ICONS.investigator },
      { to: '/live', label: 'Live Stream', icon: ICONS.live },
      { to: '/simulate', label: 'Simulation Studio', icon: ICONS.simulate },
      { to: '/copilot', label: 'AI Copilot', icon: ICONS.copilot },
      { to: '/sar', label: 'SAR Reports', icon: ICONS.sar },
    ],
  },
  {
    title: 'Integrate',
    items: [
      { to: '/aa', label: 'Account Aggregator', icon: ICONS.aa },
      { to: '/settings', label: 'Detector Settings', icon: ICONS.settings },
    ],
  },
];

const ROLES = ['INVESTIGATOR', 'SUPERVISOR', 'ADMIN'];

function RoleSwitcher() {
  const [role, setLocalRole] = useState(getRole());
  function change(r) {
    setRole(r);
    setLocalRole(r);
    // Reload to refetch under the new role's permissions
    window.location.reload();
  }
  return (
    <label className="flex items-center gap-3 rounded-2xl bg-white px-3 py-1.5" title="Demo role gate - production uses the bank IDP">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-900 text-xs font-semibold text-white">
        {role.slice(0, 2)}
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-[11px] text-gray-400">Signed in as</span>
        <select
          data-testid="role-switcher"
          value={role}
          onChange={(e) => change(e.target.value)}
          className="-ml-1 cursor-pointer bg-transparent pr-1 text-sm font-medium text-gray-900 focus:outline-none"
        >
          {ROLES.map((r) => <option key={r} value={r}>{r.charAt(0) + r.slice(1).toLowerCase()}</option>)}
        </select>
      </span>
    </label>
  );
}

function NotFound() {
  return (
    <div className="p-12 text-center">
      <h1 className="text-xl font-bold text-gray-900">Page not found</h1>
      <p className="text-sm text-gray-500 mt-2">This route is not registered in the RUDRA app.</p>
    </div>
  );
}

function SideNav() {
  return (
    <aside className="flex w-64 shrink-0 flex-col rounded-3xl bg-white">
      <div className="px-6 pb-4 pt-6">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gray-900">
            <span className="h-3 w-3 rounded-sm bg-lime" />
          </span>
          <span className="text-lg font-semibold tracking-tight text-gray-900">RUDRA</span>
        </div>
        <p className="mt-1 text-xs text-gray-400">Fund-flow intelligence</p>
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.title}>
            <p className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-gray-400">{group.title}</p>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors ${
                    isActive ? 'bg-gray-100 font-medium text-gray-900' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && <span className="absolute -left-3 top-2 bottom-2 w-1 rounded-r bg-gray-900" />}
                    <svg className="h-[18px] w-[18px] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                      <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
                    </svg>
                    {item.label}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="m-3 hidden rounded-2xl bg-gray-50 p-4 [@media(min-height:1100px)]:block">
        <p className="text-sm font-semibold text-gray-900">Context graph</p>
        <p className="mt-1 text-xs leading-relaxed text-gray-500">
          Agent memory and evidence live in FalkorDB. Open the Investigator to watch it reason.
        </p>
        <NavLink to="/investigator" className="mt-3 block rounded-xl bg-gray-900 py-2 text-center text-xs font-medium text-white hover:bg-gray-800">
          Open Investigator
        </NavLink>
      </div>
    </aside>
  );
}

function InvestigatorRoute() {
  // Remount per query so asking again from the top bar starts a fresh run.
  const { search } = useLocation();
  return <Investigator key={search} />;
}

function TopBar() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  return (
    <header className="flex items-center gap-3">
      <form
        className="flex flex-1 items-center gap-2 rounded-2xl bg-white px-4 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!q.trim()) return;
          navigate(`/investigator?q=${encodeURIComponent(q.trim())}`);
          setQ('');
        }}
      >
        <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" />
        </svg>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask the investigator - e.g. Investigate incident INC-2749"
          className="w-full bg-transparent text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none"
        />
      </form>
      <RoleSwitcher />
    </header>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <div className="flex h-screen gap-3 bg-canvas p-3 text-gray-900">
          <SideNav />
          <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            <TopBar />
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-3xl">
              <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/incidents" element={<Incidents />} />
              <Route path="/cases" element={<Cases />} />
              <Route path="/journey" element={<Journey />} />
              <Route path="/graph" element={<Graph />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/patterns" element={<Patterns />} />
              <Route path="/entities" element={<Entities />} />
              <Route path="/model" element={<ModelMetrics />} />
              <Route path="/live" element={<Live />} />
              <Route path="/copilot" element={<Copilot />} />
              <Route path="/sar" element={<SarReports />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/aa" element={<AccountAggregator />} />
              <Route path="/simulate" element={<SimulationStudio />} />
              <Route path="/map" element={<GeoMap />} />
              <Route path="/replay" element={<Replay />} />
              <Route path="/collusion" element={<Collusion />} />
              <Route path="/investigator" element={<InvestigatorRoute />} />
              <Route path="*" element={<NotFound />} />
              </Routes>
            </div>
          </main>
        </div>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
