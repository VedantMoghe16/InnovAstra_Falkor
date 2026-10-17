// Display helpers shared across pages.

export function formatUsd(v) {
  const n = Number(v || 0);
  if (n >= 1e9) return `USD ${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `USD ${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `USD ${(n / 1e3).toFixed(1)}K`;
  return `USD ${Math.round(n)}`;
}
