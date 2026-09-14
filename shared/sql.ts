/**
 * SQL text helpers shared by the serverless function (api/) and the browser
 * client (src/). Dependency-free.
 */

const READ_ONLY_KEYWORDS = new Set([
  "SELECT", "WITH", "FROM", "DESCRIBE", "SHOW", "SUMMARIZE",
  "PIVOT", "UNPIVOT", "EXPLAIN", "VALUES",
]);

/** Normalises the model's raw output into a bare SQL statement. */
export function cleanSql(raw: string): string {
  let sql = raw.replace(/\r\n/g, "\n").trim();
  sql = sql.replace(/^```(?:sql)?\s*\n?/i, "").replace(/\n?\s*```$/, "");
  sql = sql.trim();
  sql = sql.replace(/\s*;\s*$/, "");
  return sql;
}

/**
 * Guardrail (not a security boundary): true only for a single statement whose
 * first keyword is a read-only verb. Leading comments are ignored.
 */
export function isReadOnlySql(sql: string): boolean {
  let s = sql;
  for (;;) {
    const trimmed = s.replace(/^\s+/, "");
    if (trimmed.startsWith("--")) s = trimmed.replace(/^--[^\n]*\n?/, "");
    else if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      if (end < 0) return false;
      s = trimmed.slice(end + 2);
    } else { s = trimmed; break; }
  }
  const kw = s.match(/^[A-Za-z]+/)?.[0]?.toUpperCase();
  if (!kw || !READ_ONLY_KEYWORDS.has(kw)) return false;
  // Reject multiple statements: a top-level ';' followed by anything non-blank.
  const noStrings = s.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  const semi = noStrings.indexOf(";");
  return semi < 0 || noStrings.slice(semi + 1).trim() === "";
}
