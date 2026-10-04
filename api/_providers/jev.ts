/**
 * Column mapping with Jev, TypeSafe's fast "System One" classifier (variant B).
 * Env (read by the SDK): TYPESAFE_API_KEY (required), TYPESAFE_BASE_URL,
 * TYPESAFE_DEFAULT_MODEL (default jev-latest).
 *
 * One score call predicts how many columns the SQL needs (k). Then one choice
 * call per slot picks the next column; the slots run one after another because
 * each pick depends on the ones before it (a request's questions are answered in
 * one parallel pass).
 */
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  RateLimitError,
  TypeSafeClient,
  TypeSafeError,
  choice,
  score,
  type JsonValue,
} from "@typesafe-ai/sdk";
import {
  MAPPING_MAX_COLUMNS,
  type ColumnProfile,
  type DatasetProfile,
  type MappingResponse,
  type PredictedColumn,
} from "../../shared/types.js";
import { describeHint } from "../../shared/prompt.js";
import { ProviderError } from "./types.js";

type JsonObject = { [key: string]: JsonValue };

/** Most labels one choice question may have. */
const MAX_CHOICE_LABELS = 255;
const MAX_LABEL_CHARS = 120;
/** Listed values per candidate description, and characters kept per value. */
const DESCRIPTION_VALUES = 10;
const DESCRIPTION_VALUE_CHARS = 100;
/** Soft cap on the JSON state sent with each call. */
const STATE_MAX_CHARS = 60_000;
/** Longest model id passed on (POST /api/step accepts at most 100 characters). */
const MAX_MODEL_CHARS = 100;
/** Time limit for one whole mapping (every Jev call and retry together). */
const MAPPING_DEADLINE_MS = 25_000;

const MISSING_KEY =
  "TYPESAFE_API_KEY is not set for this deployment (add it in the project's environment variables, Preview scope for variant B, and redeploy)";
const REJECTED_KEY =
  "TypeSafe rejected the configured TYPESAFE_API_KEY (401). Check the key and redeploy after updating it";

const COUNT_INSTRUCTIONS =
  "How many distinct table columns must one DuckDB SQL query reference — in SELECT, WHERE, GROUP BY, ORDER BY, and JOIN conditions — to answer the question?";

/** Count rubric: index i means i + 1 columns; the last level means "this many or more". */
const COUNT_LEVELS = countLevels();

function countLevels(): [string, string, ...string[]] {
  const levels = Array.from({ length: MAPPING_MAX_COLUMNS }, (_, i) => {
    if (i === 0) return "1 column";
    if (i === MAPPING_MAX_COLUMNS - 1) return `${i + 1} or more columns`;
    return `${i + 1} columns`;
  });
  const [first, second, ...rest] = levels;
  if (first === undefined || second === undefined) throw new Error("MAPPING_MAX_COLUMNS must be at least 2");
  return [first, second, ...rest];
}

/** One column Jev may pick. */
interface Candidate {
  /** Position in schema order (tables in order, then their columns). */
  index: number;
  /** Choice label: `table.column`, at most MAX_LABEL_CHARS, unique. */
  label: string;
  table: string;
  column: string;
  description: JsonObject;
  /** Word tokens for the lexical pre-ranking. */
  columnTokens: Set<string>;
  tableTokens: Set<string>;
  valueTokens: Set<string>;
  keyLike: boolean;
}

/** Everything one mapping run derives from its input. */
interface Context {
  dataset: DatasetProfile;
  question: string;
  questionTokens: Set<string>;
  candidates: Candidate[];
  /** Index of the first candidate of each table. */
  tableOffsets: number[];
  /** Relationship hints as prompt lines, with the candidate indexes of both ends (-1 when unknown). */
  relationships: { text: string; ends: [number, number] }[];
}

function refKey(table: string, column: string): string {
  return `${table}\u0000${column}`;
}

/** Truncates by code points, so a label never ends in half a surrogate pair. */
function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

function uniqueLabel(base: string, used: Set<string>): string {
  let label = truncate(base, MAX_LABEL_CHARS);
  for (let n = 2; used.has(label); n++) {
    const suffix = `#${n}`;
    label = truncate(base, MAX_LABEL_CHARS - suffix.length) + suffix;
  }
  used.add(label);
  return label;
}

/** Listed values with line breaks flattened; never values withheld as personal. */
function listedValues(col: ColumnProfile): string[] {
  if (col.valuesWithheld || col.values === undefined) return [];
  return col.values.map((v) => v.replace(/\r?\n|\r/g, " ").trim()).filter((v) => v.length > 0);
}

function describeCandidate(table: string, col: ColumnProfile, values: string[]): JsonObject {
  const description: JsonObject = {
    table,
    column: col.name,
    type: col.type,
    distinct: col.distinctCount === -1 ? null : col.distinctCount,
    nulls: col.nullCount,
    unique: col.unique,
  };
  if (col.min !== undefined && col.max !== undefined) description.range = `${col.min} to ${col.max}`;
  if (values.length > 0) {
    description.values = values.slice(0, DESCRIPTION_VALUES).map((v) => truncate(v, DESCRIPTION_VALUE_CHARS));
  }
  return description;
}

// ---------------------------------------------------------------------------
// Lexical pre-ranking (only when more candidates remain than a choice may hold)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "by", "with", "and", "or", "is", "are", "was", "were",
  "be", "been", "do", "does", "did", "what", "which", "who", "whom", "whose", "how", "many", "much", "per", "each",
  "from", "as", "me", "my", "we", "our", "you", "your", "it", "its", "this", "that", "these", "those", "there",
  "their", "than", "then", "show", "list", "give", "get", "find", "tell", "all", "any", "some", "into", "over",
  "can", "could", "would", "should", "please",
]);

/** Folds simple English plurals so "orders" matches "order_id". */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/** Lower-case word tokens: snake_case and camelCase split, stop words dropped, plurals folded. */
function tokenize(text: string): string[] {
  return text
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t))
    .map(stem);
}

const KEY_SUFFIX_RE = /(^|[_\s.-])(id|ids|key|code|no|num|number|sku|uuid|guid|pk|fk|ref)$/;

/** Names that conventionally hold identifiers (mirrors looksLikeKey in src/duck.ts). */
function looksLikeKey(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "id" || KEY_SUFFIX_RE.test(n) || /[a-z](Id|Key|Code|No|Num)$/.test(name.trim());
}

function overlap(tokens: Set<string>, question: Set<string>): number {
  let n = 0;
  for (const t of tokens) if (question.has(t)) n++;
  return n;
}

/**
 * Keeps the MAX_CHOICE_LABELS remaining candidates with the best cheap lexical
 * score, in schema order: words shared between the question and the column
 * name, its listed values, and its table name, plus bonuses that favour joins
 * for the picks so far (columns of chosen tables, their key-like columns, and
 * both ends of relationship hints that touch a chosen table).
 */
function preRank(ctx: Context, remaining: Candidate[], chosen: Candidate[]): Candidate[] {
  if (remaining.length <= MAX_CHOICE_LABELS) return remaining;
  const chosenTables = new Set(chosen.map((c) => c.table));
  const joinEnds = new Set<number>();
  for (const { ends } of ctx.relationships) {
    const touchesChosen = ends.some((i) => i >= 0 && chosenTables.has(ctx.candidates[i]?.table ?? ""));
    if (touchesChosen) for (const i of ends) if (i >= 0) joinEnds.add(i);
  }
  const q = ctx.questionTokens;
  const scored = remaining.map((c) => {
    let s = 4 * overlap(c.columnTokens, q) + 3 * overlap(c.valueTokens, q) + 2 * overlap(c.tableTokens, q);
    if (chosenTables.has(c.table)) s += c.keyLike ? 7 : 3;
    if (joinEnds.has(c.index)) s += 3;
    return { c, s };
  });
  scored.sort((a, b) => b.s - a.s || a.c.index - b.c.index);
  const keep = new Set(scored.slice(0, MAX_CHOICE_LABELS).map(({ c }) => c.index));
  return remaining.filter((c) => keep.has(c.index));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * The JSON state for one call: the question, every table with its row count
 * and columns, and the relationship hints (plus the picks so far for a slot).
 * Over STATE_MAX_CHARS it is shrunk step by step: drop column types, keep only
 * the columns `keep` names (the candidates offered in this call and the picks),
 * keep only hints between kept columns, drop the hints, drop the column lists.
 */
function buildState(ctx: Context, keep: ReadonlySet<number>, chosen?: string[]): JsonObject {
  const { dataset } = ctx;
  const make = (columns: (tableIndex: number) => JsonValue[], relationships: string[]): JsonObject => {
    const state: JsonObject = {
      question: ctx.question,
      tables: dataset.tables.map((t, i): JsonObject => ({ table: t.table, rows: t.rowCount, columns: columns(i) })),
      relationships,
    };
    if (chosen !== undefined) state.chosen = chosen;
    return state;
  };
  const allHints = ctx.relationships.map((r) => r.text);
  const keptHints = ctx.relationships
    .filter(({ ends: [l, r] }) => keep.has(l) && keep.has(r))
    .map((r) => r.text);
  const typed = (i: number): JsonValue[] =>
    (dataset.tables[i]?.columns ?? []).map((c): JsonObject => ({ name: c.name, type: c.type }));
  const names = (i: number): JsonValue[] => (dataset.tables[i]?.columns ?? []).map((c) => c.name);
  const kept = (i: number): JsonValue[] => {
    const offset = ctx.tableOffsets[i] ?? 0;
    return (dataset.tables[i]?.columns ?? []).filter((_, j) => keep.has(offset + j)).map((c) => c.name);
  };
  const stages: [(i: number) => JsonValue[], string[]][] = [
    [typed, allHints],
    [names, allHints],
    [kept, allHints],
    [kept, keptHints],
    [kept, []],
  ];
  for (const [columns, relationships] of stages) {
    const state = make(columns, relationships);
    if (JSON.stringify(state).length <= STATE_MAX_CHARS) return state;
  }
  return make(() => [], []);
}

// ---------------------------------------------------------------------------
// Answers (the SDK returns the parsed JSON unchecked, so check it here)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function unexpected(what: string): ProviderError {
  return new ProviderError(502, `Jev returned an unexpected response: ${what}`);
}

/** One named answer of a System One result (the SDK returns the parsed JSON unchecked). */
function answerOf(result: unknown, name: string): unknown {
  if (!isRecord(result) || !isRecord(result.answers)) throw unexpected("no answers");
  return result.answers[name];
}

/** Probabilities in rubric order (missing levels count as 0) and the expected score. */
function readCount(answer: unknown): { probabilities: number[]; score: number } {
  if (!isRecord(answer) || !isRecord(answer.probabilities)) throw unexpected("the count answer has no probabilities");
  const raw = answer.probabilities;
  const probabilities = COUNT_LEVELS.map((_, i) => {
    const p = finite(raw[String(i)]);
    return p === undefined ? 0 : clamp01(p);
  });
  const total = probabilities.reduce((sum, p) => sum + p, 0);
  if (total <= 0) throw unexpected("the count answer has no usable probabilities");
  const expected = finite(answer.score) ?? probabilities.reduce((sum, p, i) => sum + p * i, 0) / total;
  return { probabilities, score: expected };
}

/** Index of the largest value; ties go to the lower index. */
function argmax(values: number[]): number {
  let best = 0;
  values.forEach((v, i) => {
    if (v > (values[best] ?? -Infinity)) best = i;
  });
  return best;
}

/** The picked candidate and its probability; falls back to the most probable offered label. */
function readChoice(answer: unknown, offered: Candidate[]): { pick: Candidate; probability: number } {
  if (!isRecord(answer)) throw unexpected("the column answer is missing");
  const raw = isRecord(answer.probabilities) ? answer.probabilities : {};
  const probabilityOf = (label: string): number | undefined => {
    const p = Object.hasOwn(raw, label) ? finite(raw[label]) : undefined;
    return p === undefined ? undefined : clamp01(p);
  };
  const byLabel = new Map(offered.map((c) => [c.label, c]));
  let pick = typeof answer.choice === "string" ? byLabel.get(answer.choice) : undefined;
  if (pick === undefined) {
    let best = -1;
    for (const c of offered) {
      const p = probabilityOf(c.label);
      if (p !== undefined && p > best) {
        best = p;
        pick = c;
      }
    }
  }
  if (pick === undefined) throw unexpected("the column answer names no offered column");
  const confidence = finite(answer.confidence);
  return { pick, probability: probabilityOf(pick.label) ?? (confidence === undefined ? 0 : clamp01(confidence)) };
}

function slotInstructions(k: number, slot: number, chosen: string[]): string {
  const needs = `The question needs ${k} distinct table column${k === 1 ? "" : "s"} in one DuckDB SQL query.`;
  const already = chosen.length > 0 ? `Columns already chosen: ${chosen.join(", ")}.` : "No columns have been chosen yet.";
  return `${needs} ${already} Pick column ${slot} of ${k}: the next column the query must reference (selected, filtered, grouped, sorted, or used to join).`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function toProviderError(error: unknown, deadline: AbortSignal): unknown {
  if (error instanceof ProviderError) return error;
  if (deadline.aborted || error instanceof APIUserAbortError) {
    return new ProviderError(504, `Jev did not finish predicting the columns within ${MAPPING_DEADLINE_MS / 1000} seconds`);
  }
  if (error instanceof AuthenticationError) return new ProviderError(500, REJECTED_KEY);
  if (error instanceof RateLimitError) return new ProviderError(429, "Rate limited by Jev; please retry shortly");
  if (error instanceof APIError) {
    // The SDK's message is "<status> <detail>".
    const detail = error.message.replace(/^\d{3}\s*/, "").trim().slice(0, 300) || "no details";
    return new ProviderError(502, `Jev error (${error.status}): ${detail}`);
  }
  if (error instanceof APIConnectionError) return new ProviderError(502, `Could not reach Jev: ${error.message}`);
  if (error instanceof TypeSafeError) return new ProviderError(500, `Jev client error: ${error.message}`);
  return error;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function buildContext(dataset: DatasetProfile, question: string): Context {
  const candidates: Candidate[] = [];
  const tableOffsets: number[] = [];
  const indexOf = new Map<string, number>();
  const used = new Set<string>();
  for (const table of dataset.tables) {
    tableOffsets.push(candidates.length);
    const tableTokens = new Set(tokenize(table.table));
    for (const col of table.columns) {
      const values = listedValues(col);
      const index = candidates.length;
      const key = refKey(table.table, col.name);
      if (!indexOf.has(key)) indexOf.set(key, index);
      candidates.push({
        index,
        label: uniqueLabel(`${table.table}.${col.name}`, used),
        table: table.table,
        column: col.name,
        description: describeCandidate(table.table, col, values),
        columnTokens: new Set(tokenize(col.name)),
        tableTokens,
        valueTokens: new Set(values.flatMap(tokenize)),
        keyLike: looksLikeKey(col.name),
      });
    }
  }
  const relationships = dataset.hints.map((hint) => ({
    text: describeHint(hint, dataset.tables).replace(/^- /, ""),
    ends: [
      indexOf.get(refKey(hint.left.table, hint.left.column)) ?? -1,
      indexOf.get(refKey(hint.right.table, hint.right.column)) ?? -1,
    ] as [number, number],
  }));
  return { dataset, question, questionTokens: new Set(tokenize(question)), candidates, tableOffsets, relationships };
}

/**
 * Predicts how many columns the SQL for `question` needs (k) and which ones,
 * one slot at a time: 1 count call plus one call per slot (a slot left with a
 * single candidate is filled without a call). Throws ProviderError.
 */
export async function predictMapping(dataset: DatasetProfile, question: string): Promise<MappingResponse> {
  if (!process.env.TYPESAFE_API_KEY?.trim()) throw new ProviderError(500, MISSING_KEY);
  const deadline = AbortSignal.timeout(MAPPING_DEADLINE_MS);
  try {
    // Created per request so configuration problems surface as JSON errors.
    // A long Retry-After from Jev falls back to the SDK's short backoff (an interactive request cannot wait a minute).
    const client = new TypeSafeClient({ timeout: 10_000, retry: { maxRetries: 1, maxRetryAfterMs: 2_000 } });
    const ctx = buildContext(dataset, question);
    const { candidates } = ctx;

    const countKeep = new Set(preRank(ctx, candidates, []).map((c) => c.index));
    const counted = await client.systemOne(
      { state: buildState(ctx, countKeep), questions: { count: score(COUNT_INSTRUCTIONS, COUNT_LEVELS) } },
      { signal: deadline },
    );
    let calls = 1;
    let model = typeof counted.model === "string" && counted.model.length > 0 ? counted.model : client.defaultModel;
    const count = readCount(answerOf(counted, "count"));
    const k = Math.max(1, Math.min(argmax(count.probabilities) + 1, candidates.length));

    const chosen: Candidate[] = [];
    const picked = new Set<number>();
    const columns: PredictedColumn[] = [];
    for (let slot = 1; slot <= k; slot++) {
      const remaining = candidates.filter((c) => !picked.has(c.index));
      const only = remaining.length === 1 ? remaining[0] : undefined;
      let pick: Candidate;
      let probability: number;
      if (only !== undefined) {
        pick = only;
        probability = 1;
      } else {
        const offered = preRank(ctx, remaining, chosen);
        const chosenLabels = chosen.map((c) => c.label);
        const keep = new Set([...offered.map((c) => c.index), ...picked]);
        const criteria = Object.fromEntries(offered.map((c) => [c.label, c.description]));
        const result = await client.systemOne(
          {
            state: buildState(ctx, keep, chosenLabels),
            questions: { column: choice(slotInstructions(k, slot, chosenLabels), criteria) },
          },
          { signal: deadline },
        );
        calls++;
        if (typeof result.model === "string" && result.model.length > 0) model = result.model;
        ({ pick, probability } = readChoice(answerOf(result, "column"), offered));
      }
      chosen.push(pick);
      picked.add(pick.index);
      columns.push({ table: pick.table, column: pick.column, probability });
    }

    return {
      k,
      // Jev's score is 0-based over the rubric; like k, it cannot exceed the schema's column count.
      expectedCount: Math.min(count.score + 1, candidates.length),
      countProbabilities: count.probabilities,
      columns,
      model: truncate(model, MAX_MODEL_CHARS),
      calls,
    };
  } catch (error) {
    throw toProviderError(error, deadline);
  }
}
