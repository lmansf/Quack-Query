/**
 * Variant B's question loop, free of DOM and DuckDB code: Jev predicts the
 * columns the question needs, then the model may run up to LOOP_MAX_QUERIES
 * exploratory queries (each executed in the browser and summarized back to
 * it) before it names the final query. Network calls, query execution and
 * progress reporting are injected through LoopDeps, so the engine also runs
 * unchanged in Node tests.
 */
import type { QueryResult } from "./duck";
import { formatValue } from "./format";
import { hideDataNames, hideDataTypes, loopErrorText, shapeOnlyRefusal } from "../shared/loop";
import { externalReference, isReadOnlySql } from "../shared/sql";
import {
  LOOP_CELL_CHARS,
  LOOP_MAX_COLUMNS,
  LOOP_MAX_QUERIES,
  LOOP_ROWS_BUDGET_CHARS,
  LOOP_SAMPLE_ROWS,
  type DatasetProfile,
  type LoopAttempt,
  type MappingRequest,
  type MappingResponse,
  type PredictedColumn,
  type StepRequest,
  type StepResponse,
} from "../shared/types";

export interface LoopDeps {
  /** POST /api/mapping; throws on failure. */
  fetchMapping(req: MappingRequest): Promise<MappingResponse>;
  /** POST /api/step; throws on failure. */
  fetchStep(req: StepRequest): Promise<StepResponse>;
  /** The app's preview runner; throws DuckDB errors. */
  runSql(sql: string): Promise<QueryResult>;
  /** Called synchronously at each stage; exceptions it throws are logged and ignored. */
  onProgress(p: LoopProgress): void;
}

export type LoopProgress =
  | { kind: "mapping-start" }
  | { kind: "mapping-done"; mapping: MappingResponse; ms: number }
  /** The model is being asked for its next move. */
  | { kind: "step-start"; remaining: number; queriesRun: number }
  /** The browser starts running query `index` (1-based). */
  | { kind: "attempt-start"; index: number; sql: string }
  /** `index` is 1-based; `remainingAfter` is the budget left once this query is counted. */
  | { kind: "attempt-done"; index: number; attempt: LoopAttempt; remainingAfter: number }
  /**
   * The final query was chosen. `reusedAttempt` is the 1-based attempt whose
   * outcome is reused, or null when the SQL is new (it runs once more right
   * after this event). `refused` is set when the final SQL failed the checks
   * with no budget left to try again; it is not run.
   */
  | { kind: "final"; sql: string; reusedAttempt: number | null; refused?: string };

/** Jev's column prediction failed; the caller stops with outcome "mapping_error". */
export class MappingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MappingError";
  }
}

/** A /api/step call failed or returned something unusable; the caller reports "api_error". */
export class StepError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StepError";
  }
}

export interface LoopOutcome {
  mapping: MappingResponse;
  mappingMs: number;
  /**
   * What the model was shown of each query, oldest first. Each step sends these,
   * except that older attempts lose their sample rows when the step would exceed
   * LOOP_ROWS_BUDGET_CHARS.
   */
  attempts: LoopAttempt[];
  /** Full preview per attempt (null for errors and refusals). */
  attemptResults: (QueryResult | null)[];
  /** The model's final SQL. */
  finalSql: string;
  /** Null when the final query failed or was refused. */
  finalResult: QueryResult | null;
  /** DuckDB error of the final query (from its own run, or from the attempt it repeats), unmasked. */
  finalError?: string;
  /** The final SQL failed the checks with no budget left to try again, so it was not run. */
  finalRefused?: string;
  /** True when the final SQL matched no attempt and was run once more (outside the budget). */
  finalWasNew: boolean;
  /** 1-based attempt whose outcome the final reuses, or null. */
  reusedAttempt: number | null;
  /** Model that served the last step that named one. */
  model?: string;
}

export async function runLoop(
  input: { dataset: DatasetProfile; question: string; shapeOnly: boolean },
  deps: LoopDeps,
): Promise<LoopOutcome> {
  const { dataset, question, shapeOnly } = input;
  const emit = (p: LoopProgress): void => {
    try {
      deps.onProgress(p);
    } catch (err) {
      console.error("[loop] progress handler failed:", err);
    }
  };

  // 1. Jev predicts which columns the question needs.
  emit({ kind: "mapping-start" });
  const started = performance.now();
  let mapping: MappingResponse;
  try {
    mapping = await deps.fetchMapping({ dataset, question });
  } catch (err) {
    throw new MappingError(`Column prediction failed: ${errorMessage(err)}`, { cause: err });
  }
  if (!mapping || !Array.isArray(mapping.columns)) {
    throw new MappingError("Column prediction failed: the server returned no columns.");
  }
  const mappingMs = Math.round(performance.now() - started);
  emit({ kind: "mapping-done", mapping, ms: mappingMs });

  // 2. The model runs queries until it names the final one or the budget is spent.
  const attempts: LoopAttempt[] = [];
  const attemptResults: (QueryResult | null)[] = [];
  /** Each attempt's DuckDB error as raised (attempts carry the masked, clipped text the model saw). */
  const rawErrors: (string | null)[] = [];
  let model: string | undefined;
  let step: StepResponse;
  for (;;) {
    const remaining = LOOP_MAX_QUERIES - attempts.length;
    emit({ kind: "step-start", remaining, queriesRun: attempts.length });
    step = await requestStep(deps, {
      dataset,
      question,
      mapping,
      attempts: withinRowsBudget(attempts),
      remaining,
      shapeOnly,
    });
    if (step.model) model = step.model;
    // A "query" with no budget left is treated as the final answer. A final query that
    // fails the checks is reported back like a refused query while budget remains.
    const final = step.action !== "query" || remaining <= 0;
    // In shape-only mode an exploratory PIVOT is refused too (its result is never shown
    // to the model when it is the final query, so a final PIVOT may run).
    const refusal = refusalReason(step) ?? (shapeOnly && !final ? shapeOnlyRefusal(step.sql) : null);
    if (final && (refusal === null || remaining <= 0)) break;
    const index = attempts.length + 1;
    let ran: { attempt: LoopAttempt; result: QueryResult | null; rawError: string | null };
    if (refusal !== null) {
      ran = { attempt: { sql: step.sql, outcome: "refused", error: refusal }, result: null, rawError: null };
    } else {
      emit({ kind: "attempt-start", index, sql: step.sql });
      ran = await runAttempt(step.sql, deps, shapeOnly, dataset);
    }
    attempts.push(ran.attempt);
    attemptResults.push(ran.result);
    rawErrors.push(ran.rawError);
    emit({ kind: "attempt-done", index, attempt: ran.attempt, remainingAfter: LOOP_MAX_QUERIES - attempts.length });
  }

  // 3. The final query: reuse an attempt's outcome when possible, otherwise run it once more.
  const base = { mapping, mappingMs, attempts, attemptResults, ...(model !== undefined ? { model } : {}) };
  const proposed = step.sql;
  const refusal = refusalReason(step);
  if (refusal !== null) {
    // Only reached with no budget left: a refused final is otherwise reported back as an attempt.
    emit({ kind: "final", sql: proposed, reusedAttempt: null, refused: refusal });
    return { ...base, finalSql: proposed, finalResult: null, finalRefused: refusal, finalWasNew: false, reusedAttempt: null };
  }

  const same = matchingAttempt(attempts, proposed);
  if (same >= 0) {
    emit({ kind: "final", sql: proposed, reusedAttempt: same + 1 });
    const repeated = attempts[same];
    const repeatedError = rawErrors[same] ?? repeated.error ?? "The query failed.";
    return {
      ...base,
      finalSql: proposed,
      finalResult: attemptResults[same],
      ...(repeated.outcome === "error" ? { finalError: repeatedError } : {}),
      finalWasNew: false,
      reusedAttempt: same + 1,
    };
  }

  emit({ kind: "final", sql: proposed, reusedAttempt: null });
  try {
    const result = await deps.runSql(proposed);
    return { ...base, finalSql: proposed, finalResult: result, finalWasNew: true, reusedAttempt: null };
  } catch (err) {
    return { ...base, finalSql: proposed, finalResult: null, finalError: errorMessage(err), finalWasNew: true, reusedAttempt: null };
  }
}

/** One /api/step turn; any failure or malformed reply becomes a StepError. */
async function requestStep(deps: LoopDeps, req: StepRequest): Promise<StepResponse> {
  let res: StepResponse;
  try {
    res = await deps.fetchStep(req);
  } catch (err) {
    throw new StepError(errorMessage(err), { cause: err });
  }
  if (!res || (res.action !== "query" && res.action !== "final")) {
    throw new StepError("The server returned an unknown step action.");
  }
  if (typeof res.sql !== "string" || !res.sql.trim()) throw new StepError("The server returned no SQL.");
  return { ...res, sql: res.sql.trim() };
}

/** Runs one exploratory query that passed the checks and summarizes it for the model. */
async function runAttempt(
  sql: string,
  deps: LoopDeps,
  shapeOnly: boolean,
  dataset: DatasetProfile,
): Promise<{ attempt: LoopAttempt; result: QueryResult | null; rawError: string | null }> {
  let result: QueryResult;
  try {
    result = await deps.runSql(sql);
  } catch (err) {
    const raw = errorMessage(err);
    return { attempt: { sql, outcome: "error", error: loopErrorText(raw, shapeOnly) }, result: null, rawError: raw };
  }
  return { attempt: summarizeAttempt(sql, result, shapeOnly, dataset), result, rawError: null };
}

/**
 * Copies of the attempts whose sample rows fit LOOP_ROWS_BUDGET_CHARS together:
 * the newest attempt keeps the most, and older attempts lose rows first (their
 * shape and errors are always kept).
 */
function withinRowsBudget(attempts: LoopAttempt[]): LoopAttempt[] {
  let left = LOOP_ROWS_BUDGET_CHARS;
  const fitted = attempts.map((a) => ({ ...a }));
  for (let i = fitted.length - 1; i >= 0; i--) {
    const attempt = fitted[i];
    if (!attempt?.rows) continue;
    const kept: string[][] = [];
    for (const row of attempt.rows) {
      // Cells plus their separators, as the prompt lays them out.
      const size = row.reduce((n, cell) => n + cell.length + 3, 0);
      if (size > left) break;
      left -= size;
      kept.push(row);
    }
    if (kept.length > 0) attempt.rows = kept;
    else delete attempt.rows;
  }
  return fitted;
}

/** Why the step's SQL must not run (server refusal, not read-only, external access), or null. */
function refusalReason(step: StepResponse): string | null {
  if (typeof step.refused === "string") return step.refused.trim() || "the server refused this query";
  if (!isReadOnlySql(step.sql)) return "not a single read-only SELECT statement";
  const external = externalReference(step.sql);
  if (external !== null) return `references ${external}, which is not allowed; queries may only read the loaded tables`;
  return null;
}

/**
 * The attempt a final SQL repeats: among executed attempts with the same SQL,
 * the most recent ok one, else the most recent error. -1 when there is none
 * (refused attempts never ran, so they have no outcome to reuse).
 */
function matchingAttempt(attempts: LoopAttempt[], sql: string): number {
  const ok = lastIndexWhere(attempts, (a) => a.outcome === "ok" && sameSql(a.sql, sql));
  return ok >= 0 ? ok : lastIndexWhere(attempts, (a) => a.outcome === "error" && sameSql(a.sql, sql));
}

function lastIndexWhere<T>(items: T[], test: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i])) return i;
  return -1;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const clip = (text: string): string => text.slice(0, LOOP_CELL_CHARS);

/**
 * What the model sees of a successful query: its shape (columns, DuckDB types,
 * row count; at most LOOP_MAX_COLUMNS columns) plus, unless `shapeOnly`, the
 * first LOOP_SAMPLE_ROWS rows as display strings. Every name and cell is cut
 * to LOOP_CELL_CHARS characters. In shape-only mode, column names and nested
 * types that could come from the data (see hideDataNames, hideDataTypes) are
 * hidden when `dataset` is given.
 */
export function summarizeAttempt(
  sql: string,
  result: QueryResult,
  shapeOnly: boolean,
  dataset?: DatasetProfile,
): LoopAttempt {
  const width = Math.min(result.columns.length, LOOP_MAX_COLUMNS);
  const names = result.columns.slice(0, width).map(clip);
  const types = result.types.slice(0, width).map(clip);
  const attempt: LoopAttempt = {
    sql,
    outcome: "ok",
    columns: shapeOnly && dataset ? hideDataNames(names, sql, dataset) : names,
    types: shapeOnly && dataset ? hideDataTypes(types, sql, dataset) : types,
    rowCount: result.rowCount,
  };
  if (!shapeOnly) {
    attempt.rows = result.rows
      .slice(0, LOOP_SAMPLE_ROWS)
      .map((row) => row.slice(0, width).map((v) => clip(formatValue(v))));
  }
  return attempt;
}

/**
 * Comments dropped; capture groups: 1 string literal, 2 quoted identifier
 * (contents), 3 number, 4 bare identifier (DuckDB allows any non-ASCII
 * character in one), 5 "::" or any other single character.
 */
const SQL_TOKEN_RE =
  /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|('(?:[^']|'')*'?)|"((?:[^"]|"")*)"?|(\d[\w.]*)|([A-Za-z_\u0080-￿][\w$\u0080-￿]*)|(::|\S)/g;

interface SqlToken {
  kind: "string" | "quoted" | "number" | "word" | "punct";
  text: string;
}

function sqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  for (const m of sql.matchAll(SQL_TOKEN_RE)) {
    if (m[1] !== undefined) tokens.push({ kind: "string", text: m[1] });
    else if (m[2] !== undefined) tokens.push({ kind: "quoted", text: m[2].replace(/""/g, '"') });
    else if (m[3] !== undefined) tokens.push({ kind: "number", text: m[3] });
    else if (m[4] !== undefined) tokens.push({ kind: "word", text: m[4] });
    else if (m[5] !== undefined) tokens.push({ kind: "punct", text: m[5] });
  }
  return tokens;
}

/**
 * SQL keywords that also make common column names. Bare, they are read as keywords
 * (`EXTRACT(YEAR FROM …)`, `ORDER BY`), so they count as column references only
 * when double-quoted, as the system prompt asks for every column.
 */
const KEYWORD_WORDS = new Set([
  "all", "and", "any", "as", "asc", "between", "by", "case", "cast", "cross", "current", "date", "day", "desc",
  "distinct", "else", "end", "except", "exists", "extract", "false", "filter", "first", "following", "from", "full",
  "group", "having", "hour", "in", "inner", "intersect", "interval", "is", "join", "last", "left", "like", "ilike",
  "limit", "minute", "month", "natural", "not", "null", "nulls", "offset", "on", "or", "order", "outer", "over",
  "partition", "preceding", "qualify", "quarter", "range", "right", "row", "rows", "second", "select", "then", "time",
  "timestamp", "true", "unbounded", "union", "using", "values", "week", "when", "where", "window", "with", "year",
]);

/**
 * Lower-cased identifiers the statement uses as references: bare or quoted,
 * each part of a qualified name on its own (`s.quantity` yields `s` and
 * `quantity`). Skipped: string literals, comments, aliases and cast targets
 * (`AS name`, `::TYPE`), function names (`sum(`), typed literals (`DATE '…'`),
 * and bare, unqualified SQL keywords (KEYWORD_WORDS).
 */
function referencedIdentifiers(sql: string): Set<string> {
  const tokens = sqlTokens(sql);
  const names = new Set<string>();
  tokens.forEach((tok, i) => {
    if (tok.kind !== "word" && tok.kind !== "quoted") return;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (prev && ((prev.kind === "word" && prev.text.toLowerCase() === "as") || prev.text === "::" || prev.kind === "number")) {
      return;
    }
    if (tok.kind === "word" && next && (next.text === "(" || next.kind === "string")) return;
    if (tok.kind === "word" && prev?.text !== "." && KEYWORD_WORDS.has(tok.text.toLowerCase())) return;
    names.add(tok.text.toLowerCase());
  });
  return names;
}

/**
 * Share (0-1) of the predicted columns whose name the SQL references as a whole
 * identifier, case-insensitively: bare or double-quoted, optionally qualified
 * by a table or alias. `id` does not match `customer_id`. 0 when nothing was predicted.
 */
export function mappingHit(columns: PredictedColumn[], sql: string): number {
  if (columns.length === 0) return 0;
  const names = referencedIdentifiers(sql);
  const hits = columns.filter((c) => names.has(c.column.toLowerCase())).length;
  return hits / columns.length;
}

/** Whitespace outside quotes collapsed, trailing semicolons dropped; case and literals kept. */
function normalizeSql(sql: string): string {
  return sql
    .replace(/('(?:[^']|'')*'|"(?:[^"]|"")*")|\s+/g, (_match, quoted: string | undefined) => quoted ?? " ")
    .replace(/[\s;]+$/, "")
    .trim();
}

/** True when two statements differ only in whitespace or a trailing ';' (case-sensitive otherwise). */
export function sameSql(a: string, b: string): boolean {
  return normalizeSql(a) === normalizeSql(b);
}
