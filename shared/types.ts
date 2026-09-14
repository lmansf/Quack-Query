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
  /** Number of distinct non-null values. */
  distinctCount: number;
  /** Number of NULL values. */
  nullCount: number;
  /**
   * The full set of distinct values, present only when the column is
   * low-cardinality (distinctCount <= LOW_CARDINALITY_LIMIT). Values are
   * stringified for transport.
   */
  values?: string[];
}

/** Profile of the single uploaded table. */
export interface TableProfile {
  /** SQL identifier of the table the file was loaded into. */
  table: string;
  /** Original file name, for display and prompt context only. */
  fileName: string;
  /** Total row count. */
  rowCount: number;
  columns: ColumnProfile[];
}

/** Columns with this many distinct values or fewer get their values listed. */
export const LOW_CARDINALITY_LIMIT = 20;

/** POST /api/query request body. */
export interface QueryRequest {
  profile: TableProfile;
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
