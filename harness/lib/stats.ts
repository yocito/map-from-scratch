import type { Summary } from './types.ts';

// Nearest-rank percentile. Frame-time budgets are stated as "p95 <= x ms",
// and nearest-rank always returns a value that was actually observed.
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarize(values: number[]): Summary {
  const n = values.length;
  if (n === 0) {
    return { n: 0, min: null, p50: null, p95: null, p99: null, max: null, mean: null, stdev: null };
  }
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return {
    n,
    min: Math.min(...values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: Math.max(...values),
    mean,
    stdev: Math.sqrt(variance),
  };
}
