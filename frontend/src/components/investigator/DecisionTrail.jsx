import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';

const PROV = { GRAPH: '#a6d65c', ML: '#8f7ad6', RULE: '#f2a33a', PRECEDENT: '#f2c94c', INFERRED: '#a3a39d' };
const STATUS = { proposed: '#f2c94c', executed: '#161814', approved: '#a6d65c', rejected: '#a3a39d', denied: '#e8743b' };

function colorOf(n) {
  if (n.kind === 'investigation') return '#161814';
  if (n.kind === 'finding') return PROV[n.provenance] || PROV.INFERRED;
  if (n.kind === 'decision') return STATUS[n.status] || '#a3a39d';
  if (n.kind === 'review') return n.rel === 'APPROVES' ? '#a6d65c' : '#e8743b';
  if (n.kind === 'prior') return '#d2d2cd';
  return '#ffffff';
}

const LEGEND = [
  ['#161814', 'Investigation'], ['#a6d65c', 'Graph finding'], ['#f2a33a', 'Rule finding'], ['#f2c94c', 'Precedent / proposed'],
  ['#161814', 'Executed decision'], ['#ffffff', 'Account'], ['#d2d2cd', 'Earlier investigation'],
];

export default function DecisionTrail({ data, height = 420 }) {
  const wrap = useRef(null);
  const fg = useRef(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    if (!wrap.current) return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const graphData = useMemo(() => ({
    nodes: (data?.nodes || []).map((n) => ({ ...n })),
    links: (data?.links || []).map((l) => ({ ...l })),
  }), [data]);

  useEffect(() => {
    const t = setTimeout(() => fg.current?.zoomToFit(400, 30), 800);
    return () => clearTimeout(t);
  }, [graphData]);

  return (
    <div ref={wrap}>
      {graphData.nodes.length === 0 ? (
        <div className="flex items-center justify-center rounded-2xl bg-gray-50 text-xs text-gray-400" style={{ height }}>
          The decision trail appears when an investigation finishes.
        </div>
      ) : (
        <div className="relative overflow-hidden rounded-2xl bg-gray-50">
          <ForceGraph2D
            ref={fg}
            graphData={graphData}
            width={width}
            height={height}
            backgroundColor="#f7f7f5"
            dagMode="lr"
            dagLevelDistance={110}
            cooldownTicks={120}
            nodeRelSize={5}
            nodeVal={(n) => (n.kind === 'investigation' ? 4 : n.kind === 'decision' ? 3 : 1.6)}
            onNodeHover={setHover}
            nodeCanvasObject={(n, ctx, scale) => {
              const r = n.kind === 'investigation' ? 9 : n.kind === 'decision' || n.kind === 'review' ? 7 : 5;
              ctx.beginPath();
              if (n.kind === 'decision' || n.kind === 'review') {
                ctx.rect(n.x - r, n.y - r, 2 * r, 2 * r);
              } else {
                ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
              }
              ctx.fillStyle = colorOf(n);
              ctx.fill();
              ctx.lineWidth = 1 / scale;
              ctx.strokeStyle = '#42423d';
              ctx.stroke();
              if (n.kind === 'investigation' || n.kind === 'decision' || n.kind === 'review' || scale > 2.2) {
                ctx.font = `${9 / scale}px Inter, sans-serif`;
                ctx.fillStyle = '#42423d';
                const text = n.kind === 'account' ? String(n.label).slice(-10) : String(n.label).slice(0, 28);
                ctx.fillText(text, n.x + r + 2, n.y + 3);
              }
            }}
            linkColor={() => '#a3a39d'}
            linkWidth={0.8}
            linkDirectionalArrowLength={4}
            linkDirectionalArrowRelPos={1}
            linkLabel={(l) => l.rel}
          />
          {hover && (
            <div className="pointer-events-none absolute right-3 top-3 max-w-xs rounded-xl bg-white p-3 text-xs text-gray-700 shadow-sm">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">{hover.kind}{hover.provenance ? ` | ${hover.provenance}` : ''}{hover.rule ? ` | ${hover.rule}` : ''}</p>
              {hover.label}
            </div>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-gray-500">
        {LEGEND.map(([c, label]) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full border border-gray-400" style={{ background: c }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
