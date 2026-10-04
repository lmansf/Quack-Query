/**
 * SQL text helpers shared by the serverless function (api/) and the browser
 * client (src/). Dependency-free, with no runtime imports: the server loads
 * this module under native Node ESM.
 */

// EXPLAIN is deliberately absent: EXPLAIN ANALYZE executes the statement it wraps.
const READ_ONLY_KEYWORDS = new Set([
  "SELECT", "WITH", "FROM", "DESCRIBE", "SHOW", "SUMMARIZE",
  "PIVOT", "UNPIVOT", "VALUES",
]);

/** First word of a statement, after any opening parentheses (`(SELECT 1) UNION (SELECT 2)`). */
const FIRST_WORD_RE = /^[ \t\n\r\f(]*([A-Za-z]+)(?![\w$\u0080-\uffff])/;

/**
 * Words that only occur in statements that change data, the schema or the
 * session. Matched as bare words, so a quoted column named "update" is fine.
 * `replace` is absent because DuckDB's `SELECT * REPLACE (...)` is a read.
 */
const WRITE_WORD_RE =
  /\b(insert|update|delete|merge|create|drop|alter|truncate|attach|detach|copy|export|import|install|load|vacuum|checkpoint|begin|commit|rollback|abort|grant|revoke|set|reset|pragma|call|use)\b/i;

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
// A scheme is a run of these characters starting with a letter. The match only starts
// where such a run starts (at the beginning or after another character), which keeps it
// linear on long runs without "://". No lookbehind: older Safari versions cannot parse one,
// and this module is part of the browser bundle.
const URL_RE = /(?:^|[^a-z0-9+.-])[0-9+.-]*[a-z][a-z0-9+.-]*:\/\//i;

/** Patterns for calls of some functions, by name. */
interface CallPatterns {
  /** Bare name, optional whitespace, "(": for text with quoted identifiers blanked. */
  bare: RegExp;
  /** The same with the name double-quoted, which DuckDB also accepts: for text with them kept. */
  quoted: RegExp;
  /** The name anywhere, for text the scanner could not follow. */
  anywhere: RegExp;
}

function callPatterns(names: string): CallPatterns {
  return {
    bare: new RegExp(String.raw`\b(${names})\s*\(`, "i"),
    quoted: new RegExp(String.raw`"(${names})"\s*\(`, "i"),
    anywhere: new RegExp(String.raw`\b(${names})\b`, "i"),
  };
}

/**
 * File/URL-reading table functions (and getvariable). Only calls count, and
 * string contents and other quoted identifiers are blanked first, so a column
 * called "read_at" or "last_scan" and a literal 'glob' are fine. Comments are
 * blanked too, so `read_csv/* x *\/('f')` is still a call.
 */
const READER_CALLS = callPatterns(String.raw`read_\w*|scan_\w*|\w+_scan|glob|sniff_csv|getvariable`);
/** Functions that run SQL given as a string literal, which the other checks never look inside. */
const SQL_TEXT_CALLS = callPatterns("query|json_execute_serialized_sql");
/** Checked with string literals and quoted identifiers blanked out, so a column called "import" is fine. */
const KEYWORD_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /\b(install|load|attach|detach|copy|export|import|set|reset|pragma|call|explain)\b/i, what: "an extension, attach, copy, or settings statement" },
  { re: /\b(httpfs|s3|gcs|azure|hf)\b/i, what: "a remote filesystem" },
];

/**
 * Returns a short description of the first external-access construct found in
 * the statement, or null when it only touches loaded tables. This is one layer
 * of several (DuckDB refuses subqueries and column references inside reader
 * functions, and the deployment's CSP blocks the worker from connecting
 * anywhere but the app's own origin), so it favors catching obfuscation over
 * never producing a false positive. URLs are looked for inside string literals
 * too; function names and keywords only outside them.
 */
export function externalReference(sql: string): string | null {
  const scanned = scanSql(sql);
  // Text the scanner cannot follow is checked raw, names anywhere: that can only over-report.
  const { code, noStrings, bare } = scanned.ok ? scanned : { code: sql, noStrings: sql, bare: sql };
  const calls = (p: CallPatterns): boolean =>
    scanned.ok ? p.bare.test(bare) || p.quoted.test(noStrings) : p.anywhere.test(sql);
  if (URL_RE.test(code)) return "a URL";
  if (calls(READER_CALLS)) return "a file-reading function";
  if (calls(SQL_TEXT_CALLS)) return "a function that runs SQL text";
  for (const { re, what } of KEYWORD_PATTERNS) if (re.test(bare)) return what;
  return null;
}

/**
 * Guardrail, not the only barrier (src/duck.ts runs every query as a subquery,
 * which DuckDB refuses for DML and for several statements): true only for one
 * complete statement that starts with a read-only verb and holds no
 * data-changing or session keyword. Comments, string literals and quoted
 * identifiers are skipped, so their contents never count; trailing semicolons
 * and comments are fine.
 */
export function isReadOnlySql(sql: string): boolean {
  const { bare, ok, end } = scanSql(sql);
  if (!ok) return false;
  // Everything past `end` is whitespace, semicolons and comments.
  const statement = bare.slice(0, end);
  const first = FIRST_WORD_RE.exec(statement)?.[1].toUpperCase();
  if (first === undefined || !READ_ONLY_KEYWORDS.has(first)) return false;
  return !statement.includes(";") && !WRITE_WORD_RE.test(statement);
}

/**
 * The statement without surrounding whitespace, trailing semicolons or trailing
 * comments. The cut comes from the scanner, so a `--` inside a string literal is
 * never taken for a comment.
 */
export function trimStatement(sql: string): string {
  return sql.slice(0, scanSql(sql).end).trim();
}

/**
 * True when the statement closes every string, quoted identifier, dollar quote
 * and block comment it opens, and its parentheses balance without ever closing
 * one it did not open. Only such a statement stays a single unit when wrapped
 * in `(...)`: a stray `)` would end the wrapper early and run what follows.
 */
export function isSelfContained(sql: string): boolean {
  const { bare, ok } = scanSql(sql);
  if (!ok) return false;
  let depth = 0;
  for (const c of bare) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Same-length views of a statement: blanked characters become spaces, so every
 * view lines up with the original text. Unicode spaces outside quotes are
 * blanked in all three (see `scanSql`).
 */
interface ScannedSql {
  /** (i) Comments blanked. */
  code: string;
  /** (ii) Also the contents of string literals blanked; the quote characters stay. */
  noStrings: string;
  /** (iii) Also the contents of quoted identifiers blanked. */
  bare: string;
  /**
   * False when a string, quoted identifier, dollar quote or block comment is
   * unterminated, or when a Unicode space leaves DuckDB's reading uncertain.
   */
  ok: boolean;
  /** Index just past the last character that is not whitespace, a semicolon, or in a comment. */
  end: number;
}

type Blanked = "space" | "comment" | "string" | "ident";

/**
 * Reads a statement left to right the way DuckDB's scanner (PostgreSQL's) does:
 * - `--` comments run to a line break (\n or \r); block comments nest;
 * - '...' strings escape a quote by doubling it. E'...' strings also let a
 *   backslash escape the next character. The E must start a token: the e of
 *   `name'x'` belongs to the identifier, while `1e'x'` is 1 then E'x';
 * - $$...$$ and $tag$...$tag$ dollar quotes; a `$` inside an identifier (`a$b`)
 *   or before a digit (`$1`) opens none;
 * - "..." identifiers escape a double quote by doubling it;
 * - string parts separated by whitespace that includes a line break are one
 *   literal ('a'<newline>'b' is 'ab'), so every part of an E-string escapes.
 * DuckDB's parser first turns some Unicode spaces (U+00A0 and the like) into
 * plain spaces, but only where its quick pre-pass sees no quote or comment;
 * elsewhere they are identifier characters. They count as spaces here, and the
 * result is not `ok` where the other reading would move a string boundary: a
 * Unicode space glued to the start of an E-string or dollar quote, or between
 * the parts of an E-string.
 */
function scanSql(sql: string): ScannedSql {
  const n = sql.length;
  const blanks: { from: number; to: number; kind: Blanked }[] = [];
  const blank = (from: number, to: number, kind: Blanked): void => {
    if (to > from) blanks.push({ from, to, kind });
  };
  let ok = true;
  let end = 0;
  /** Opening quote of a string part that continues an E-string. */
  let eStringPart = -1;
  for (let i = 0; i < n; ) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const to = lineEnd(sql, i);
      blank(i, to, "comment");
      i = to;
      continue;
    }
    if (isSpace(c) || c === ";") {
      i++;
      continue;
    }
    if (isUnicodeSpace(sql.charCodeAt(i))) {
      blank(i, i + 1, "space");
      i++;
      continue;
    }
    const tag = c === "$" ? dollarTag(sql, i) : "";
    /** Just past the token that starts at i; -1 when it runs unterminated to the end. */
    let to: number;
    if (c === "/" && next === "*") {
      to = blockCommentEnd(sql, i);
      blank(i, to < 0 ? n : to, "comment");
      if (to >= 0) {
        i = to;
        continue;
      }
    } else if (c === "'" || ((c === "E" || c === "e") && next === "'")) {
      const open = c === "'" ? i : i + 1;
      const backslash = open > i || i === eStringPart;
      if (open > i && gluedToUnicodeSpace(sql, i)) ok = false;
      to = closingQuote(sql, open, backslash);
      blank(open + 1, to < 0 ? n : to - 1, "string");
      if (backslash && to >= 0) {
        eStringPart = continuation(sql, to);
        if (eStringPart === AMBIGUOUS) ok = false;
      }
    } else if (c === '"') {
      to = closingQuote(sql, i, false);
      blank(i + 1, to < 0 ? n : to - 1, "ident");
    } else if (tag) {
      if (gluedToUnicodeSpace(sql, i)) ok = false;
      const close = sql.indexOf(tag, i + tag.length);
      blank(i + tag.length, close < 0 ? n : close, "string");
      to = close < 0 ? -1 : close + tag.length;
    } else {
      to = wordEnd(sql, i);
    }
    if (to < 0) {
      ok = false;
      end = n;
      break;
    }
    end = i = to;
  }
  const view = (...kinds: Blanked[]): string => {
    let out = "";
    let at = 0;
    for (const { from, to, kind } of blanks) {
      if (!kinds.includes(kind)) continue;
      out += sql.slice(at, from) + " ".repeat(to - from);
      at = to;
    }
    return out + sql.slice(at);
  };
  return {
    code: view("space", "comment"),
    noStrings: view("space", "comment", "string"),
    bare: view("space", "comment", "string", "ident"),
    ok,
    end,
  };
}

/** Whitespace to DuckDB's scanner (a vertical tab is not). */
function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f";
}

/** The Unicode spaces DuckDB's parser turns into plain spaces before scanning. */
function isUnicodeSpace(code: number): boolean {
  return code === 0xa0 || (code >= 0x2000 && code <= 0x200b) || code === 0x202f ||
    code === 0x205f || code === 0x2060 || code === 0x3000 || code === 0xfeff;
}

/** A letter to DuckDB's scanner: ASCII letters, `_`, and every non-ASCII character. */
function isLetter(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || code === 0x5f || code >= 0x80;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/** Index of the line break (\n or \r) that ends the `--` comment at `at`, or the end of the text. */
function lineEnd(sql: string, at: number): number {
  let i = at + 2;
  while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i++;
  return i;
}

/** Just past the `*` `/` that closes the block comment opened at `open` (comments nest), or -1. */
function blockCommentEnd(sql: string, open: number): number {
  let depth = 0;
  for (let i = open; i < sql.length; ) {
    if (sql[i] === "/" && sql[i + 1] === "*") {
      depth++;
      i += 2;
    } else if (sql[i] === "*" && sql[i + 1] === "/") {
      i += 2;
      if (--depth === 0) return i;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * Just past the quote that closes the string or identifier opened by the quote
 * at `open`, or -1. A doubled quote is an escaped one; with `backslash`
 * (E-strings) a backslash escapes the character after it.
 */
function closingQuote(sql: string, open: number, backslash: boolean): number {
  const quote = sql[open];
  for (let i = open + 1; i < sql.length; i++) {
    if (sql[i] === quote) {
      if (sql[i + 1] !== quote) return i + 1;
      i++;
    } else if (backslash && sql[i] === "\\") {
      i++;
    }
  }
  return -1;
}

/** `continuation` result when a Unicode space between two string parts leaves it uncertain. */
const AMBIGUOUS = -2;

/**
 * For a string literal that closed just before `at`: the index of the quote of
 * the part that continues it, when only whitespace with a line break and `--`
 * comments lie in between ('a'<newline>'b' is the one literal 'ab'); else -1.
 */
function continuation(sql: string, at: number): number {
  let lineBreak = false;
  let unicodeSpace = false;
  for (let i = at; i < sql.length; ) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      i = lineEnd(sql, i);
    } else if (isSpace(c)) {
      if (c === "\n" || c === "\r") lineBreak = true;
      i++;
    } else if (isUnicodeSpace(sql.charCodeAt(i))) {
      unicodeSpace = true;
      i++;
    } else {
      if (c !== "'" || !lineBreak) return -1;
      return unicodeSpace ? AMBIGUOUS : i;
    }
  }
  return -1;
}

/** The `$$` or `$tag$` that opens a dollar quote at `at`, or "" when that `$` opens none. */
function dollarTag(sql: string, at: number): string {
  let i = at + 1;
  if (isLetter(sql.charCodeAt(i))) {
    do i++;
    while (isLetter(sql.charCodeAt(i)) || isDigit(sql.charCodeAt(i)));
  }
  return sql[i] === "$" ? sql.slice(at, i + 1) : "";
}

/**
 * True when the identifier characters running up to `at` include a Unicode
 * space. Should DuckDB's pre-pass leave that space alone, the run is a single
 * identifier and no token starts at `at`.
 */
function gluedToUnicodeSpace(sql: string, at: number): boolean {
  for (let i = at - 1; i >= 0; i--) {
    const code = sql.charCodeAt(i);
    if (isUnicodeSpace(code)) return true;
    if (!isLetter(code) && !isDigit(code) && code !== 0x24) return false;
  }
  return false;
}

/** A number: 1, 1_000, 1.5, .5, 1e-3. */
const NUMBER_RE = /(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[Ee][+-]?\d(?:_?\d)*)?/y;

/**
 * Just past the identifier, keyword or number at `at`, else past the single
 * character there. An identifier takes in digits and `$` (`a$1` is one name);
 * a number stops before letters (`1abc` is 1 then abc).
 */
function wordEnd(sql: string, at: number): number {
  const isWordLetter = (code: number): boolean => isLetter(code) && !isUnicodeSpace(code);
  if (isWordLetter(sql.charCodeAt(at))) {
    let i = at + 1;
    while (isWordLetter(sql.charCodeAt(i)) || isDigit(sql.charCodeAt(i)) || sql[i] === "$") i++;
    return i;
  }
  NUMBER_RE.lastIndex = at;
  const number = NUMBER_RE.exec(sql);
  return at + (number ? number[0].length : 1);
}
