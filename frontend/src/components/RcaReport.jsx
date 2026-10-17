// Forensic RCA dossier for one incident (GET /api/incidents/{id}/rca):
// how it happened -> why it worked -> who may be next -> what to fix.
// Amounts here come from the pipeline as recorded (native currencies summed
// together), so they are never labelled as Rs or USD.
import { Disclosure, Pill } from './ui';

function compact(n) {
  const v = Number(n || 0);
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return `${Math.round(v)}`;
}

const MIXED = 'mixed currency, as recorded';

// Pipeline text says "flow of Rs 2,486,915,570" for sums that mix currencies; say
// what it is. Rupee thresholds ("under the Rs 10,00,000 reporting threshold") stay.
const honest = (t) => (t ? String(t).replace(/\b(on|of) Rs\.? ?([\d,]+(?:\.\d+)?)/g, `$1 $2 (${MIXED})`) : t);

function Section({ n, title, children }) {
  return (
    <section className="border-t border-gray-100 pt-4">
      <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[10px] font-semibold text-gray-600">
          {n}
        </span>
        {title}
      </h4>
      <div className="mt-2 space-y-2 pl-7 text-sm text-gray-700">{children}</div>
    </section>
  );
}

function Accounts({ ids }) {
  if (!ids?.length) return <span className="text-gray-400">none found</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {ids.map((id) => (
        <span key={id} className="num rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-700">{id}</span>
      ))}
    </span>
  );
}

export default function RcaReport({ dossier }) {
  if (!dossier) return null;
  if (dossier.error) {
    return <p className="rounded-2xl bg-gray-50 px-4 py-3 text-xs text-gray-600">Root cause analysis unavailable: {dossier.error}</p>;
  }

  const { reconstruction: r, diagnosis: d, recommendations: rec, narrative } = dossier;
  const s = r?.signals || {};
  const targets = dossier.foresight?.next_targets || [];
  const basis = d?.basis === 'inferred'
    ? 'Inferred from the money trail'
    : d?.basis === 'rule' && r?.method?.fatf_code !== 'ML-GENERIC'
      ? 'Matched a known typology'
      : 'General ML anomaly';
  let n = 0;

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Root cause analysis</p>
          <Pill tone="gray">{basis}</Pill>
        </div>
        {narrative && (
          <div className="mt-2">
            <Disclosure label="Show as one paragraph (for the STR narrative)" closeLabel="Hide paragraph">
              <p className="rounded-2xl bg-gray-50 px-4 py-3 text-xs leading-relaxed text-gray-700">{honest(narrative)}</p>
            </Disclosure>
          </div>
        )}
      </div>

      <Section n={++n} title="How it happened">
        <p>
          <span className="font-medium text-gray-900">{r?.method?.fatf_typology || r?.method?.pattern || 'Unclassified'}</span>
          {r?.method?.fatf_code && <span className="ml-1 text-xs text-gray-400">{r.method.fatf_code}</span>}
        </p>
        <div className="grid gap-1.5 text-xs">
          <p><span className="mr-2 text-gray-500">Money entered at</span><Accounts ids={r?.origin} /></p>
          <p><span className="mr-2 text-gray-500">Money left from</span><Accounts ids={r?.cashout} /></p>
        </div>
        {r?.red_flags?.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-gray-600">
            {r.red_flags.map((f) => <li key={f}>{honest(f)}</li>)}
          </ul>
        )}
        <p className="text-xs text-gray-400">
          {Number(s.n_txns || 0).toLocaleString('en-IN')} transactions | amount {compact(s.total_amount)} ({MIXED})
        </p>
      </Section>

      <Section n={++n} title="Why it worked">
        <p>{honest(d?.control_gap) || 'No control gap identified.'}</p>
        {d?.evidence && <p className="text-xs text-gray-500">Evidence: {honest(d.evidence)}</p>}
      </Section>

      {targets.length > 0 && (
        <Section n={++n} title="Who may be next">
          <p className="text-xs text-gray-500">
            Accounts that look structurally like this ring ({dossier.foresight.method || 'graph embedding similarity'}).
          </p>
          <ul className="divide-y divide-gray-100 text-xs">
            {targets.map((t) => (
              <li key={t.entity_id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="num text-gray-800">{t.entity_id}</span>
                <span className="text-gray-500">
                  {(t.similarity * 100).toFixed(0)}% similar | exposure {compact(t.exposure)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-400">Total exposure {compact(dossier.foresight.exposure)} ({MIXED})</p>
        </Section>
      )}

      <Section n={n + 1} title="What to fix">
        <ul className="list-disc space-y-1 pl-4">
          {(rec?.policy_level || []).map((p) => <li key={p.recommendation}>{honest(p.recommendation)}</li>)}
        </ul>
        {rec?.account_level?.length > 0 && (
          <div className="text-xs">
            <p className="mb-1 text-gray-500">Now: enhanced due diligence and a hold on</p>
            <Accounts ids={rec.account_level.map((a) => a.entity_id || a.name)} />
          </div>
        )}
        {d?.remediation && rec?.policy_level?.every((p) => p.recommendation !== d.remediation) && (
          <Disclosure label="Show remediation detail">
            <p className="text-xs text-gray-600">{honest(d.remediation)}</p>
          </Disclosure>
        )}
      </Section>
    </div>
  );
}
