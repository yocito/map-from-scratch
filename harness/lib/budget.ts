import type { Budget, CheckRun, Stat, Summary } from './types.ts';

export interface BudgetRow {
  name: string;
  stat: Stat;
  max: number | null;
  min: number | null;
  actual: number | null;
  pass: boolean;
  reason?: string;
}

export interface CheckRow {
  id: string;
  reported: number;
  failed: number;
  pass: boolean;
  reason?: string;
  detail?: string;
}

// A budget is the performance requirement of the request, written down:
//   "frame_ms": {"stat": "p95", "max": 8.3}
// A metric that never showed up is a failure, not a pass.
export function checkBudgets(summaries: Record<string, Partial<Summary>>, budgets: Record<string, Budget>): BudgetRow[] {
  return Object.entries(budgets).map(([name, b]) => {
    const stat = b.stat ?? 'p50';
    const actual = summaries[name]?.[stat] ?? null;
    const row = { name, stat, max: b.max ?? null, min: b.min ?? null, actual };
    if (actual === null) return { ...row, pass: false, reason: 'not reported' };
    const pass = (b.max == null || actual <= b.max) && (b.min == null || actual >= b.min);
    return { ...row, pass };
  });
}

// The checks of spec.yaml's verification section: each must be reported in
// every iteration, and pass every time. A check that never ran is a failure.
export function checkVerification(ids: string[], checks: Record<string, CheckRun[]>, iterations: number): CheckRow[] {
  return ids.map((id) => {
    const runs = checks[id] ?? [];
    const failedRuns = runs.filter((r) => !r.pass);
    const row = { id, reported: runs.length, failed: failedRuns.length };
    if (runs.length === 0) return { ...row, pass: false, reason: 'not reported' };
    if (runs.length < iterations) return { ...row, pass: false, reason: `reported in ${runs.length} of ${iterations} iterations` };
    return { ...row, pass: failedRuns.length === 0, detail: failedRuns[0]?.detail };
  });
}
