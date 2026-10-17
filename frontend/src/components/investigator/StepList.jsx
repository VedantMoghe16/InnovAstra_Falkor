import { useState } from 'react';
import { Disclosure } from '../ui';
import { PHASES, ACTION_TOOLS, stepSentence, withPhases } from './stepText';

function QueryDetail({ step }) {
  return (
    <div className="query-detail space-y-2 rounded-2xl bg-gray-50 p-3">
      <p className="font-mono text-[11px] text-gray-500">
        {step.tool} | {Number(step.rows || 0)} row{step.rows === 1 ? '' : 's'} | {Number(step.ms || 0).toFixed(1)} ms
        {step.provenance ? ` | ${step.provenance}` : ''}
      </p>
      {step.args && Object.keys(step.args).length > 0 && (
        <p className="break-all font-mono text-[11px] text-gray-500">{JSON.stringify(step.args)}</p>
      )}
      {step.cypher && (
        <pre className="max-h-64 overflow-auto rounded-xl bg-gray-900 p-3 text-[11px] leading-relaxed text-[#cfe9a8]">{step.cypher}</pre>
      )}
      {step.note && <p className="text-[11px] text-[#b0631c]">{step.note}</p>}
      {step.preview && (
        <pre className="max-h-48 overflow-auto rounded-xl bg-white p-3 text-[11px] text-gray-600">
          {JSON.stringify(step.preview, null, 1).slice(0, 2500)}
        </pre>
      )}
    </div>
  );
}

export function StepLine({ step }) {
  const isAction = ACTION_TOOLS.has(step.tool);
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(step.cypher || step.args);
  return (
    <li className="flex gap-3 py-2">
      <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${step.error ? 'bg-red-50 text-red-600' : isAction ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-500'}`}>
        {step.n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-3">
          <p className={`min-w-0 flex-1 text-sm leading-snug ${step.error ? 'text-red-600' : 'text-gray-800'}`}>{stepSentence(step)}</p>
          {step.ms > 0 && <span className="num shrink-0 pt-0.5 text-[11px] text-gray-400">{step.ms.toFixed(0)} ms</span>}
          {hasDetail && (
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
              className="shrink-0 pt-0.5 text-[11px] font-medium text-gray-400 hover:text-gray-900">
              {open ? 'Hide query' : 'Query'}
            </button>
          )}
        </div>
        {open && <div className="mt-2"><QueryDetail step={step} /></div>}
      </div>
    </li>
  );
}

function FindingsRollup({ steps }) {
  if (!steps.length) return null;
  const ms = steps.reduce((a, x) => a + (x.ms || 0), 0);
  return (
    <li className="flex gap-3 py-2.5">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-900 text-[10px] font-semibold text-white">{steps.length}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-3">
          <p className="min-w-0 flex-1 text-sm leading-snug text-gray-800">Recorded {steps.length} findings as it went - each one is listed in the verdict above</p>
          {ms > 0 && <span className="num shrink-0 pt-0.5 text-[11px] text-gray-400">{ms.toFixed(0)} ms</span>}
        </div>
        <div className="mt-1">
          <Disclosure label={`Show the ${steps.length} recording steps`}>
            <ol className="divide-y divide-gray-50">{steps.map((st) => <StepLine key={st.n} step={st} />)}</ol>
          </Disclosure>
        </div>
      </div>
    </li>
  );
}

export function ThinkingLine({ text }) {
  return <li className="py-1.5 pl-9 text-xs italic leading-relaxed text-gray-500">{text}</li>;
}

// The "Steps" tab: a plain-language timeline grouped into the four phases.
export default function StepList({ items }) {
  const phased = withPhases(items);
  const groups = PHASES.map(([key, label]) => ({
    key, label, items: phased.filter((it) => it.phase === key),
  })).filter((g) => g.items.some((it) => it.type === 'step'));

  if (groups.length === 0) {
    return <p className="rounded-2xl bg-gray-50 p-6 text-center text-xs text-gray-500">No steps recorded for this investigation.</p>;
  }
  // Many record_finding calls repeat the findings shown in the verdict card; roll them into one line.
  const collapse = phased.filter((it) => it.tool === 'record_finding').length > 2;
  return (
    <div className="space-y-6">
      {groups.map((g, gi) => {
        const steps = g.items.filter((it) => it.type === 'step');
        const ms = steps.reduce((a, s) => a + (s.ms || 0), 0);
        return (
          <section key={g.key}>
            <div className="flex items-baseline gap-3 border-b border-gray-100 pb-2">
              <span className="text-[11px] font-semibold text-gray-400">{gi + 1}</span>
              <h3 className="text-sm font-semibold text-gray-900">{g.label}</h3>
              <span className="text-xs text-gray-500">{steps.length} step{steps.length === 1 ? '' : 's'}{ms > 0 ? ` | ${ms.toFixed(0)} ms in the graph` : ''}</span>
            </div>
            <ol className="divide-y divide-gray-50">
              {collapse && g.key === 'decide' && <FindingsRollup steps={steps.filter((x) => x.tool === 'record_finding')} />}
              {g.items.filter((it) => !(collapse && it.tool === 'record_finding')).map((it, i) => (it.type === 'thinking'
                ? <ThinkingLine key={`t${i}`} text={it.text} />
                : <StepLine key={`s${it.n}-${i}`} step={it} />))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
