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
import { externalReference, isReadOnlySql } from "../shared/sql";
import {
  LOOP_CELL_CHARS,
  LOOP_MAX_COLUMNS,
  LOOP_MAX_QUERIES,
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
  /** `index` is 1-based; `remainingAfter` is the budget left once this query is counted. */
  | { kind: "attempt-done"; index: number; attempt: LoopAttempt; remainingAfter: number }
  /**
   * The final query was chosen. `reusedAttempt` is the 1-based attempt whose
   * outcome is reused, or null when the SQL is new (it runs once more right
   * after this event). `refused` is set when the model's final SQL failed the
   * checks: then `sql` is the most recent ok attempt standing in for it
   * (`reusedAttempt` set), or the refused SQL itself when there is none.
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
  /** Exactly what the model saw, oldest first. */
  attempts: LoopAttempt[];
  /** Full preview per attempt (null for errors and refusals). */
  attemptResults: (QueryResult | null)[];
  /** The query to show: the model's final SQL, or the attempt standing in for a refused one. */
  finalSql: string;
  /** Null when the final query failed or was refused. */
  finalResult: QueryResult | null;
  /** DuckDB error of the final query (from its own run, or from the attempt it repeats). */
  finalError?: string;
  /** The final SQL failed the checks and no ok attempt existed to fall back to. */
  finalRefused?: string;
  /** The model's final SQL failed the checks and the most recent ok attempt stands in for it. */
  fallbackFrom?: { sql: string; reason: string };
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
  let model: string | undefined;
  let step: StepResponse;
  for (;;) {
    const remaining = LOOP_MAX_QUERIES - attempts.length;
    emit({ kind: "step-start", remaining, queriesRun: attempts.length });
    step = await requestStep(deps, {
      dataset,
      question,
      mapping,
      attempts: attempts.slice(),
      remaining,
      shapeOnly,
    });
    if (step.model) model = step.model;
    // A "query" with no budget left is treated as the final answer.
    if (step.action !== "query" || remaining <= 0) break;
    const { attempt, result } = await runAttempt(step, deps, shapeOnly);
    attempts.push(attempt);
    attemptResults.push(result);
    emit({ kind: "attempt-done", index: attempts.length, attempt, remainingAfter: LOOP_MAX_QUERIES - attempts.length });
  }

  // 3. The final query: reuse an attempt's outcome when possible, otherwise run it once more.
  const base = { mapping, mappingMs, attempts, attemptResults, ...(model !== undefined ? { model } : {}) };
  const proposed = step.sql;
  const refusal = refusalReason(step);
  if (refusal !== null) {
    const fallback = lastIndexWhere(attempts, (a) => a.outcome === "ok");
    if (fallback < 0) {
      emit({ kind: "final", sql: proposed, reusedAttempt: null, refused: refusal });
      return { ...base, finalSql: proposed, finalResult: null, finalRefused: refusal, finalWasNew: false, reusedAttempt: null };
    }
    const sql = attempts[fallback].sql;
    emit({ kind: "final", sql, reusedAttempt: fallback + 1, refused: refusal });
    return {
      ...base,
      finalSql: sql,
      finalResult: attemptResults[fallback],
      fallbackFrom: { sql: proposed, reason: refusal },
      finalWasNew: false,
      reusedAttempt: fallback + 1,
    };
  }

  const same = matchingAttempt(attempts, proposed);
  if (same >= 0) {
    emit({ kind: "final", sql: proposed, reusedAttempt: same + 1 });
    const repeated = attempts[same];
    return {
      ...base,
      finalSql: proposed,
      finalResult: attemptResults[same],
      ...(repeated.outcome === "error" ? { finalError: repeated.error ?? "The query failed." } : {}),
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

/** Runs one exploratory query, unless it fails the checks (then it is recorded as refused, unrun). */
async function runAttempt(
  step: StepResponse,
  deps: LoopDeps,
  shapeOnly: boolean,
): Promise<{ attempt: LoopAttempt; result: QueryResult | null }> {
  const refusal = refusalReason(step);
  if (refusal !== null) return { attempt: { sql: step.sql, outcome: "refused", error: refusal }, result: null };
  let result: QueryResult;
  try {
    result = await deps.runSql(step.sql);
  } catch (err) {
    return { attempt: { sql: step.sql, outcome: "error", error: errorMessage(err) }, result: null };
  }
  return { attempt: summarizeAttempt(step.sql, result, shapeOnly), result };
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
 * to LOOP_CELL_CHARS characters.
 */
export function summarizeAttempt(sql: string, result: QueryResult, shapeOnly: boolean): LoopAttempt {
  const width = Math.min(result.columns.length, LOOP_MAX_COLUMNS);
  const attempt: LoopAttempt = {
    sql,
    outcome: "ok",
    columns: result.columns.slice(0, width).map(clip),
    types: result.types.slice(0, width).map(clip),
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
 * Lower-cased identifiers the statement uses as references: bare or quoted,
 * each part of a qualified name on its own (`s.quantity` yields `s` and
 * `quantity`). Skipped: string literals, comments, aliases and cast targets
 * (`AS name`, `::TYPE`), function names (`sum(`), typed literals (`DATE '…'`).
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
