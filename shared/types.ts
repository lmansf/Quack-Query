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
