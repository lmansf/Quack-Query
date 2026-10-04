/**
 * Types shared between the browser client (src/) and the serverless
 * function (api/). Keep this file dependency-free.
 */

/** Profile of a single column, computed client-side by DuckDB Wasm. */
export interface ColumnProfile {
  /** Column name exactly as DuckDB reports it. */
  name: string;
  /** DuckDB type name, e.g. "VARCHAR", "BIGINT", "DOUBLE", "DATE". */
  type: string;
  /** Number of distinct non-null values (-1 when it could not be computed). */
  distinctCount: number;
  /** Number of NULL values. */
  nullCount: number;
  /** True when every non-null value is distinct and there are no nulls (candidate key). */
  unique: boolean;
  /**
   * Smallest / largest value, stringified, for numeric and temporal columns
   * (omitted for other types or when the column is entirely NULL).
   */
  min?: string;
  max?: string;
  /**
   * The full set of distinct values, present only when the column is
   * low-cardinality (distinctCount <= LOW_CARDINALITY_LIMIT). Values are
   * stringified for transport.
   */
  values?: string[];
  /**
   * True when the column is low-cardinality but its values were withheld from
   * the profile because the column looks personal (emails, phone numbers,
   * people's names, identifiers such as SSN or passport, secrets).
   */
  valuesWithheld?: boolean;
}

/** Profile of one uploaded table. */
export interface TableProfile {
  /** SQL identifier of the table the file was loaded into (unique within the dataset). */
  table: string;
  /** Original file name, for display and prompt context only. */
  fileName: string;
  /** Total row count. */
  rowCount: number;
  columns: ColumnProfile[];
}

/** A column reference inside a relationship hint. */
export interface ColumnRef {
  table: string;
  column: string;
}

/**
 * A heuristic relationship between two columns of different tables, computed
 * client-side so the model can infer join keys. Both kinds may apply to the
 * same pair; each pair appears at most once, with `sharedName` and, when it
 * was measured, the value overlap.
 */
export interface RelationshipHint {
  left: ColumnRef;
  right: ColumnRef;
  /** The two columns have the same name (case-insensitive). */
  sharedName: boolean;
  /**
   * Fraction (0..1) of left's distinct non-null values that also occur in
   * right, and vice versa. Omitted when the overlap was not measured (types
   * incompatible, or the candidate budget was exhausted).
   */
  leftInRight?: number;
  rightInLeft?: number;
  /** Number of distinct values present in both columns, when measured. */
  sharedValues?: number;
}

/** Everything the model needs to know about the loaded data. */
export interface DatasetProfile {
  tables: TableProfile[];
  hints: RelationshipHint[];
}

/** Columns with this many distinct values or fewer get their values listed. */
export const LOW_CARDINALITY_LIMIT = 20;

/** Upper bound on cross-table column pairs whose value overlap is measured per profile pass. */
export const MAX_OVERLAP_PAIRS = 60;

/** Overlap below this fraction (in both directions) is not reported as a hint. */
export const MIN_OVERLAP_FRACTION = 0.2;

/** POST /api/query request body. */
export interface QueryRequest {
  dataset: DatasetProfile;
  question: string;
}

/** POST /api/query success response body. */
export interface QueryResponse {
  /** A single read-only DuckDB SQL statement, no trailing semicolon, no fences. */
  sql: string;
  /** Model that served the request (recorded in outcome metrics). */
  model?: string;
}

/** POST /api/query error response body (non-2xx status). */
export interface QueryError {
  error: string;
}

/** Max rows / columns of a query result forwarded to the answer step. */
export const ANSWER_MAX_ROWS = 50;
export const ANSWER_MAX_COLUMNS = 30;
/** Max characters per cell forwarded to the answer step. */
export const ANSWER_MAX_CELL_CHARS = 200;

/** POST /api/answer request body: the question, the SQL that ran, and (a prefix of) its result. */
export interface AnswerRequest {
  question: string;
  sql: string;
  columns: string[];
  /** Stringified cells (formatValue), at most ANSWER_MAX_ROWS rows. */
  rows: string[][];
  /** Total rows the query produced (may exceed rows.length). */
  rowCount: number;
}

/** POST /api/answer success response body. */
export interface AnswerResponse {
  /** Short plain-text answer to the question, grounded in the result. */
  answer: string;
}

// ---------------------------------------------------------------------------
// A/B test: variants, outcome metrics, and feedback
// ---------------------------------------------------------------------------

/** "A" is the original app; "B" adds Jev column prediction and the query loop. */
export type Variant = "A" | "B";

/** How a response came about: the model answering a question, an edited re-run, or a history replay. */
export type ResponseSource = "model" | "edited" | "history";

/** Final state of one response. */
export type ResponseOutcome =
  | "ok" // results shown
  | "query_error" // DuckDB rejected or failed the query
  | "model_error" // the model said the question cannot be answered (single `error` column)
  | "refused" // the SQL failed the read-only / external-access checks
  | "api_error" // /api/query (or B's loop/mapping endpoints) returned an error
  | "mapping_error" // B only: Jev column prediction failed, so B stopped
  | "cancelled"; // the user declined the large-result warning

/** Pattern every client-generated response id must match. */
export const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
/** Longest accepted feedback comment, in characters. */
export const MAX_COMMENT_CHARS = 500;
/** Most predicted columns recorded per response. */
export const MAX_PREDICTED_COLUMNS = 16;

/**
 * Sent once per response (success or failure). Outcome metrics only: no
 * question text, SQL, or data values. Column names in `predictedColumns` are
 * schema information, the same kind the model already receives.
 */
export interface ResponseEvent {
  type: "response";
  /** Client-generated id; feedback events reference it. */
  id: string;
  variant: Variant;
  source: ResponseSource;
  outcome: ResponseOutcome;
  /** Milliseconds from submitting the question (or pressing Run/Load) to results or an error on screen. */
  latencyMs: number;
  /** Rows the final query produced, when outcome is "ok". */
  rowCount?: number;
  /** Model that wrote the SQL, when known. */
  model?: string;
  /** Whether the written-answer step was requested for this response. */
  answerStep: boolean;
  /** Milliseconds the written-answer step took, when it ran. */
  answerMs?: number;
  /** Number of tables loaded when the response was produced. */
  tables: number;
  // --- Variant B only -------------------------------------------------------
  /** Queries the loop ran (0-5), excluding the final query when it was new. */
  attempts?: number;
  /** True when the model's final SQL differed from every query it had run. */
  finalWasNew?: boolean;
  /** Number of columns Jev predicted the question needs. */
  predictedK?: number;
  /** "table.column" for each predicted column, in prediction order. */
  predictedColumns?: string[];
  /** Share (0-1) of predicted columns referenced by the final SQL. */
  mappingHit?: number;
  /** Milliseconds the Jev mapping took. */
  mappingMs?: number;
}

/** A thumbs up or down on a response. Sent once; the UI locks after voting. */
export interface FeedbackEvent {
  type: "feedback";
  responseId: string;
  variant: Variant;
  source: ResponseSource;
  rating: "up" | "down";
}

/** Optional free-text comment after a thumbs down (at most MAX_COMMENT_CHARS). */
export interface CommentEvent {
  type: "comment";
  responseId: string;
  variant: Variant;
  source: ResponseSource;
  comment: string;
}

/** POST /api/event body. The endpoint answers 204 with no body. */
export type TelemetryEvent = ResponseEvent | FeedbackEvent | CommentEvent;

/** Per-variant aggregates shown on the results page. Rates are null when their denominator is 0. */
export interface VariantStats {
  responses: number;
  ok: number;
  up: number;
  down: number;
  comments: number;
  /** up / (up + down). */
  upRate: number | null;
  /** Wilson 95% interval for upRate. */
  upRateCi: [number, number] | null;
  /** (up + down) / responses. */
  feedbackRate: number | null;
  /** ok / responses. */
  okRate: number | null;
  /** Median latency estimated from a bucketed histogram. */
  medianLatencyMs: number | null;
  meanAnswerMs: number | null;
  /** Variant B: mean queries the loop ran. */
  meanAttempts: number | null;
  /** Variant B: mean predicted column count. */
  meanPredictedK: number | null;
  /** Variant B: mean share of predicted columns used by the final SQL. */
  meanMappingHit: number | null;
  /** Response counts keyed by ResponseOutcome. */
  outcomes: Record<string, number>;
}

/** GET /api/results response (requires the `x-results-password` header). */
export interface ResultsResponse {
  /** False when no Redis store is configured; all numbers are then zero. */
  configured: boolean;
  generatedAt: string;
  /** "model" counts only the model's responses to questions; "all" adds edited re-runs and history replays. */
  scope: "model" | "all";
  variants: Record<Variant, VariantStats>;
  /** B's upRate minus A's, with a two-sided two-proportion z-test p-value; null until both have votes. */
  upRateDiff: { diff: number; pValue: number } | null;
  /** Most recent comments first, at most 50 (always across all sources). */
  comments: { variant: Variant; source: ResponseSource; comment: string; at: string }[];
}
