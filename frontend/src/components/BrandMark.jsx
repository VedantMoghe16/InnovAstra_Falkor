// RUDRA mark: ink tile, three nodes (lime, orange, lime) whose edges converge on
// one lime root - a trident drawn as a fund-flow graph. 32-unit grid.
export default function BrandMark({ size = 32, className = '', title = 'RUDRA' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={title}
      className={className} xmlns="http://www.w3.org/2000/svg">
      <rect width="32" height="32" rx="7.5" fill="#161814" />
      <g stroke="#a6d65c" strokeWidth="1.9" strokeLinecap="round">
        <line x1="8.6" y1="11.4" x2="15.2" y2="22.6" />
        <line x1="16" y1="9.6" x2="16" y2="22" />
        <line x1="23.4" y1="11.4" x2="16.8" y2="22.6" />
      </g>
      <circle cx="8.4" cy="11" r="2.7" fill="#a6d65c" />
      <circle cx="23.6" cy="11" r="2.7" fill="#a6d65c" />
      <circle cx="16" cy="8.2" r="2.7" fill="#e8743b" />
      <circle cx="16" cy="24" r="3.3" fill="#a6d65c" />
    </svg>
  );
}
