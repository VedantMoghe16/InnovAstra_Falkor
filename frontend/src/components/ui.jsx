// Shared building blocks for the RUDRA UI. One visual language: white rounded
// cards on the grey canvas, near-black primary actions, lime/yellow/orange accents.
// Use these instead of ad-hoc Tailwind so screens stay consistent and calm.
import { useState } from 'react';

export function Card({ children, className = '', padded = true }) {
  return <section className={`rounded-3xl bg-white ${padded ? 'p-6' : ''} ${className}`}>{children}</section>;
}

export function SectionHeader({ title, subtitle, action }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

const BTN = {
  primary: 'bg-gray-900 text-white hover:bg-gray-800',
  secondary: 'bg-gray-100 text-gray-800 hover:bg-gray-200',
  ghost: 'text-gray-700 hover:bg-gray-100',
};

export function Button({ variant = 'primary', size = 'md', className = '', ...props }) {
  const sz = size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2.5 text-sm';
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${BTN[variant]} ${sz} ${className}`}
    />
  );
}

// tone: lime (good / graph), yellow (waiting), orange (risk), gray (neutral), dark (done by agent)
const PILL = {
  lime: 'bg-[#eef7e0] text-[#4d7a1a]',
  yellow: 'bg-[#fbf6d6] text-[#86760f]',
  orange: 'bg-[#fdf0e2] text-[#b0631c]',
  gray: 'bg-gray-100 text-gray-600',
  dark: 'bg-gray-900 text-white',
  red: 'bg-red-50 text-red-700',
};

export function Pill({ tone = 'gray', children, className = '' }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium ${PILL[tone]} ${className}`}>
      {children}
    </span>
  );
}

export function Stat({ label, value, hint, dot }) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="num mt-1 text-2xl font-semibold tracking-tight text-gray-900">{value}</p>
      {hint && (
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500">
          {dot && <span className="h-2 w-2 rounded-full" style={{ background: dot }} />}
          {hint}
        </p>
      )}
    </div>
  );
}

export function EmptyState({ title, body, action }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl bg-gray-50 px-6 py-10 text-center">
      <p className="text-sm font-medium text-gray-800">{title}</p>
      {body && <p className="mt-1 max-w-md text-xs leading-relaxed text-gray-500">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="inline-flex rounded-xl bg-gray-100 p-1 text-xs" role="tablist">
      {tabs.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={value === key}
          onClick={() => onChange(key)}
          className={`rounded-lg px-3 py-1.5 transition-colors ${value === key ? 'bg-white font-medium text-gray-900' : 'text-gray-500 hover:text-gray-800'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// Progressive disclosure: technical detail (Cypher, raw JSON) stays one click away.
export function Disclosure({ label = 'Show details', closeLabel, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const hide = closeLabel || (label.startsWith('Show ') ? `Hide ${label.slice(5)}` : `Hide ${label.toLowerCase()}`);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="text-xs font-medium text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline">
        {open ? hide : label}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}
