/**
 * Parse the `--max-budget-usd` CLI argument into a positive USD amount.
 *
 * Accepts plain decimals (`5`, `0.50`, `2.5`) and an optional leading `$`.
 * Negative or zero values are rejected — a budget of zero would block the
 * very first call before any cost has accumulated.
 *
 * Returns `{ ok: true, value }` on success or `{ ok: false, message }` on
 * invalid input. The CLI wrapper translates failures into a stderr message
 * and exit code 2.
 */
export type ParseBudgetResult = { ok: true; value: number } | { ok: false; message: string };

export function parseMaxBudgetUsd(raw: string): ParseBudgetResult {
  const cleaned = raw.replace(/^\$/, "").trim();
  if (cleaned === "") {
    return { ok: false, message: `--max-budget-usd must be a positive USD amount, got '${raw}'` };
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, message: `--max-budget-usd must be a positive USD amount, got '${raw}'` };
  }
  return { ok: true, value: n };
}
