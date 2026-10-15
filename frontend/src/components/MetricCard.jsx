const DOT = {
  indigo: '#a6d65c', green: '#a6d65c', blue: '#161814', amber: '#f2c94c', red: '#e8743b', purple: '#8f7ad6',
};

export default function MetricCard({ label, value, delta, color = 'indigo', onClick }) {
  const interactive = onClick ? 'cursor-pointer transition-colors hover:bg-gray-50' : '';
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      className={`rounded-3xl bg-white p-5 ${interactive}`}
    >
      <p className="text-xs text-gray-400">{label}</p>
      <p className="num mt-2 text-3xl font-semibold tracking-tight text-gray-900">{value}</p>
      {delta && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-gray-500">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: DOT[color] || DOT.indigo }} />
          {delta}
        </p>
      )}
    </div>
  );
}
