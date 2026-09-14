/**
 * SQL text helpers shared by the serverless function (api/) and the browser
 * client (src/). Dependency-free.
 */

// EXPLAIN is deliberately absent: EXPLAIN ANALYZE executes the statement it wraps.
const READ_ONLY_KEYWORDS = new Set([
  "SELECT", "WITH", "FROM", "DESCRIBE", "SHOW", "SUMMARIZE",
  "PIVOT", "UNPIVOT", "VALUES",
]);

/** Removes line comments (double dash) and block comments; ignoring string literals is close enough here. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** Normalises the model's raw output into a bare SQL statement. */
export function cleanSql(raw: string): string {
  let sql = raw.replace(/\r\n/g, "\n").trim();
  sql = sql.replace(/^```(?:sql)?\s*\n?/i, "").replace(/\n?\s*```$/, "");
  sql = sql.trim();
  sql = sql.replace(/\s*;\s*$/, "");
  return sql;
}

/**
 * Things a query over already-loaded tables never needs, but which would let a
 * prompt-injected statement reach outside the browser tab: URLs of any scheme,
 * file/URL-reading table functions, extension loading, and attach/copy.
 * DuckDB-Wasm fetches URLs with the browser's own XHR, so this check (plus the
 * deployment's Content-Security-Policy) is what keeps data in the tab.
 */
const URL_RE = /[a-z][a-z0-9+.-]*:\/\//i;
/**
 * File/URL-reading table functions. Matched as bare identifiers on the
 * comment-stripped statement (quotes included), because DuckDB accepts a
 * quoted function name and a comment between the name and its parenthesis.
 */
const READER_RE = /\b(read_[a-z_]*|scan_[a-z_]*|[a-z_]+_scan|glob|sniff_csv|getvariable)\b/i;
/** Checked with string literals and quoted identifiers blanked out, so a column called "import" is fine. */
const KEYWORD_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /\b(install|load|attach|detach|copy|export|import|set|reset|pragma|call|explain)\b/i, what: "an extension, attach, copy, or settings statement" },
  { re: /\b(httpfs|s3|gcs|azure|hf)\b/i, what: "a remote filesystem" },
];

/** Replaces the contents of string literals and quoted identifiers so keyword checks ignore them. */
function blankQuoted(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

/**
 * Returns a short description of the first external-access construct found in
 * the statement, or null when it only touches loaded tables. This is one layer
 * of several (DuckDB refuses subqueries and column references inside reader
 * functions, and the deployment's CSP blocks the worker from connecting
 * anywhere but the app's own origin), so it favors catching obfuscation over
 * never producing a false positive.
 */
export function externalReference(sql: string): string | null {
  const code = stripComments(sql);
  if (URL_RE.test(code)) return "a URL";
  if (READER_RE.test(code)) return "a file-reading function";
  const blanked = blankQuoted(code);
  for (const { re, what } of KEYWORD_PATTERNS) if (re.test(blanked)) return what;
  return null;
}

/**
 * Guardrail (not a security boundary): true only for a single statement whose
 * first keyword is a read-only verb. Leading comments are ignored.
 */
export function isReadOnlySql(sql: string): boolean {
  let s = stripComments(sql);
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
