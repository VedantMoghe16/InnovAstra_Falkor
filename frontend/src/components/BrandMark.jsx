// RUDRA monogram: an ink tile carrying a lime trident drawn as a tiny graph -
// three tip nodes joined to one root node. Rudra's trident + a fund-flow graph.
// Built on a 32-unit grid so it stays crisp from 16px (favicon) to 48px.
export default function BrandMark({ size = 32, className = '', title = 'RUDRA' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label={title}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="32" height="32" rx="9" fill="#161814" />
      <g fill="none" stroke="#a6d65c" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 24V9.5" />
        <path d="M16 19.5C16 15.5 9.5 16 9.5 11.5" />
        <path d="M16 19.5C16 15.5 22.5 16 22.5 11.5" />
      </g>
      <g fill="#a6d65c">
        <circle cx="9.5" cy="9.5" r="2.5" />
        <circle cx="16" cy="7.5" r="2.5" />
        <circle cx="22.5" cy="9.5" r="2.5" />
      </g>
      <circle cx="16" cy="24.5" r="2.4" fill="#161814" stroke="#a6d65c" strokeWidth="2" />
    </svg>
  );
}
