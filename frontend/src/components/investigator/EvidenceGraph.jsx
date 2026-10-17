import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';

const NODE_COLOR = {
  individual: '#a6d65c', business: '#f2c94c', shell_company: '#e8743b',
  Device: '#161814', IP: '#161814', KYC: '#161814',
};
const LEGEND = [
  ['#161814', 'Cited transaction', 'bar'], ['#e8743b', 'IBM-labelled laundering', 'bar'],
  ['#a6d65c', 'Individual', 'dot'], ['#f2c94c', 'Business', 'dot'], ['#e8743b', 'Shell company', 'dot'],
  ['#161814', 'Shared device / IP / KYC', 'dot'],
];

export default function EvidenceGraph({ data, height = 360 }) {
  const wrap = useRef(null);
  const fg = useRef(null);
  const [width, setWidth] = useState(600);

  useEffect(() => {
    if (!wrap.current) return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const graphData = useMemo(() => {
    const nodes = (data?.nodes || []).map((n) => ({ ...n }));
    const ids = new Set(nodes.map((n) => n.id));
    const links = (data?.links || []).filter((l) => ids.has(l.source) && ids.has(l.target)).map((l) => ({ ...l }));
    return { nodes, links };
  }, [data]);

  useEffect(() => {
    const t = setTimeout(() => fg.current?.zoomToFit(400, 40), 700);
    return () => clearTimeout(t);
  }, [graphData]);

  return (
    <div ref={wrap}>
      {graphData.nodes.length === 0 ? (
        <div className="flex items-center justify-center rounded-2xl bg-gray-50 text-xs text-gray-400" style={{ height }}>
          The evidence subgraph builds up here as the agent cites accounts and transactions.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-gray-50">
          <ForceGraph2D
            ref={fg}
            graphData={graphData}
            width={width}
            height={height}
            backgroundColor="#f7f7f5"
            cooldownTicks={100}
            nodeRelSize={4}
            nodeVal={(n) => (n.identifier ? 4 : n.cited ? 3 : 1.4)}
            nodeLabel={(n) => `${n.id} | ${n.type || n.source || ''}${n.alerts ? ` | ${n.alerts} alert(s)` : ''}${n.is_mule ? ' | mule' : ''}`}
            nodeColor={(n) => (n.is_mule && !n.identifier ? '#e8743b' : NODE_COLOR[n.type] || '#a3a39d')}
            nodeCanvasObjectMode={() => 'after'}
            nodeCanvasObject={(n, ctx, scale) => {
              if (n.cited) {
                ctx.beginPath();
                ctx.arc(n.x, n.y, 7, 0, 2 * Math.PI);
                ctx.strokeStyle = '#161814';
                ctx.lineWidth = 1.4 / scale;
                ctx.stroke();
              }
              if (scale > 2.4 || n.identifier || (n.cited && scale > 1.2)) {
                ctx.font = `${10 / scale}px Inter, sans-serif`;
                ctx.fillStyle = '#42423d';
                ctx.fillText(String(n.id).slice(-10), n.x + 8, n.y + 3);
              }
            }}
            linkColor={(l) => (l.identity ? '#a3a39d' : l.cited ? '#161814' : l.is_fraud ? '#e8743b' : '#d2d2cd')}
            linkWidth={(l) => (l.cited ? 2 : 0.8)}
            linkDirectionalArrowLength={(l) => (l.identity ? 0 : 4)}
            linkDirectionalArrowRelPos={1}
            linkLabel={(l) => (l.identity ? `shares ${l.kind}` : `tid ${l.tid} | USD ${Math.round(Number(l.amount_usd || 0)).toLocaleString('en-IN')} (${l.currency || 'USD'} ${Math.round(Number(l.amount || 0)).toLocaleString('en-IN')}) | ML ${Number(l.ml_score || 0).toFixed(2)}`)}
            linkDirectionalParticles={(l) => (l.cited ? 2 : 0)}
            linkDirectionalParticleWidth={2}
            linkDirectionalParticleColor={() => '#a6d65c'}
          />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-gray-500">
        {LEGEND.map(([c, label, kind]) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className={kind === 'bar' ? 'h-1.5 w-4 rounded-full' : 'h-2.5 w-2.5 rounded-full'} style={{ background: c }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
