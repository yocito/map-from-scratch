// A budget is the performance requirement of the request, written down:
//   "frame_ms": {"stat": "p95", "max": 8.3}
// A metric that never showed up is a failure, not a pass.
export function checkBudgets(summaries, budgets) {
  return Object.entries(budgets).map(([name, b]) => {
    const stat = b.stat ?? 'p50';
    const actual = summaries[name]?.[stat] ?? null;
    const row = { name, stat, max: b.max ?? null, min: b.min ?? null, actual };
    if (actual === null) return { ...row, pass: false, reason: 'not reported' };
    const pass = (b.max === undefined || actual <= b.max) && (b.min === undefined || actual >= b.min);
    return { ...row, pass };
  });
}
