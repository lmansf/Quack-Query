/**
 * Display formatting for query result cells. Dependency-free, so modules that
 * must not pull in DuckDB (the loop engine and its Node tests) can use it;
 * `duck.ts` re-exports it for everything else.
 */

/** Human-readable string for any cell value (used for profiles and display). */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return String(v);
  // Strip binary floating-point noise (668.3399999999999 -> 668.34) while keeping 15 significant digits.
  if (typeof v === 'number') return Number.isFinite(v) ? String(Number(v.toPrecision(15))) : String(v);
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) {
    return Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  try {
    return JSON.stringify(v, (_k, val: unknown) => (typeof val === 'bigint' ? val.toString() : val));
  } catch {
    return String(v);
  }
}
