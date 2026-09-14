/**
 * Thin wrapper around DuckDB-Wasm: one lazily-created database, one reused
 * connection, one loaded table at a time. Everything runs in the browser.
 */
import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { DataType, type Field, type Table as ArrowTable } from 'apache-arrow';
import { LOW_CARDINALITY_LIMIT } from '../shared/types';
import type { ColumnProfile, TableProfile } from '../shared/types';

export { isReadOnlySql } from '../shared/sql';

/** Result of `runQuery`: column names plus rows in column order. */
export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** Real number of rows the query produced (before truncation). */
  rowCount: number;
  /** True when `rows` was cut to `maxRows`. */
  truncated: boolean;
}

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;
let connPromise: Promise<duckdb.AsyncDuckDBConnection> | null = null;
let currentTable: string | null = null;
let currentFile: string | null = null;

/** Instantiates the single DuckDB-Wasm instance. Safe to call repeatedly. */
export async function initDuckDB(): Promise<void> {
  await getDb();
}

function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const bundle = await duckdb.selectBundle({
        mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
        eh: { mainModule: ehWasm, mainWorker: ehWorker },
      });
      const worker = new Worker(bundle.mainWorker!);
      const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
      const db = new duckdb.AsyncDuckDB(logger, worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      return db;
    })();
  }
  return dbPromise;
}

function getConn(): Promise<duckdb.AsyncDuckDBConnection> {
  if (!connPromise) connPromise = getDb().then((db) => db.connect());
  return connPromise;
}

/** Name of the currently loaded table, or null if nothing is loaded. */
export function getTableName(): string | null {
  return currentTable;
}

/** Quotes a SQL identifier, doubling embedded double quotes. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quotes a SQL string literal, doubling embedded single quotes. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Derives a safe table name from a file name (see rules in the header). */
function tableNameFor(fileName: string): string {
  let base = fileName.replace(/\.[^.]*$/, '').toLowerCase();
  base = base.replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (/^[0-9]/.test(base)) base = `t_${base}`;
  return base || 'data';
}

function readerFor(fileName: string): string {
  const ext = (fileName.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();
  switch (ext) {
    case 'csv': case 'tsv': case 'txt': return 'read_csv_auto';
    case 'parquet': return 'read_parquet';
    case 'json': case 'jsonl': case 'ndjson': return 'read_json_auto';
    default:
      throw new Error(
        `Unsupported file type ".${ext}". Supported: .csv, .tsv, .txt, .parquet, .json, .jsonl, .ndjson`,
      );
  }
}

/** Registers a browser File, loads it into a fresh table, and profiles it. */
export async function loadFile(file: File): Promise<TableProfile> {
  const reader = readerFor(file.name); // throws early for unsupported types
  const db = await getDb();
  const conn = await getConn();
  if (currentTable) await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(currentTable)}`);
  if (currentFile) await db.dropFile(currentFile).catch(() => null);
  currentTable = null;
  currentFile = null;

  await db.registerFileHandle(file.name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
  currentFile = file.name;
  const table = tableNameFor(file.name);
  await conn.query(
    `CREATE TABLE ${quoteIdent(table)} AS SELECT * FROM ${reader}(${quoteLiteral(file.name)})`,
  );
  currentTable = table;
  return profileTable(table, file.name);
}

/** Computes row count, column types, distinct/null counts and low-cardinality values. */
export async function profileTable(table: string, fileName: string): Promise<TableProfile> {
  const conn = await getConn();
  const t = quoteIdent(table);

  const countRes = await conn.query(`SELECT count(*) AS n FROM ${t}`);
  const rowCount = Number(countRes.getChildAt(0)?.get(0) ?? 0);

  const desc = await conn.query(`DESCRIBE ${t}`);
  const names = columnValues(desc, 'column_name').map(String);
  const types = columnValues(desc, 'column_type').map(String);

  const stats = await columnStats(t, names);

  const columns: ColumnProfile[] = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const col: ColumnProfile = {
      name,
      type: types[i],
      distinctCount: stats[i].distinct,
      nullCount: stats[i].nulls,
    };
    if (col.distinctCount >= 0 && col.distinctCount <= LOW_CARDINALITY_LIMIT) {
      const q = quoteIdent(name);
      const res = await conn.query(
        `SELECT DISTINCT ${q} FROM ${t} WHERE ${q} IS NOT NULL ORDER BY 1 LIMIT ${LOW_CARDINALITY_LIMIT}`,
      );
      col.values = vectorValues(res, 0).map(formatValue);
    }
    columns.push(col);
  }
  return { table, fileName, rowCount, columns };
}

/** Distinct/null counts for every column; one combined query with per-column fallback. */
async function columnStats(t: string, names: string[]): Promise<{ distinct: number; nulls: number }[]> {
  const conn = await getConn();
  const expr = (n: string, i: number) =>
    `count(DISTINCT ${quoteIdent(n)}) AS d${i}, count(*) - count(${quoteIdent(n)}) AS n${i}`;
  if (names.length === 0) return [];
  try {
    const res = await conn.query(`SELECT ${names.map(expr).join(', ')} FROM ${t}`);
    return names.map((_, i) => ({
      distinct: Number(res.getChildAt(2 * i)?.get(0) ?? 0),
      nulls: Number(res.getChildAt(2 * i + 1)?.get(0) ?? 0),
    }));
  } catch {
    // Some types (LIST/STRUCT/MAP...) reject count(DISTINCT); isolate failures.
    const out: { distinct: number; nulls: number }[] = [];
    for (const [i, n] of names.entries()) {
      try {
        const res = await conn.query(`SELECT ${expr(n, i)} FROM ${t}`);
        out.push({
          distinct: Number(res.getChildAt(0)?.get(0) ?? 0),
          nulls: Number(res.getChildAt(1)?.get(0) ?? 0),
        });
      } catch {
        let nulls = 0;
        try {
          const res = await conn.query(`SELECT count(*) - count(${quoteIdent(n)}) FROM ${t}`);
          nulls = Number(res.getChildAt(0)?.get(0) ?? 0);
        } catch { /* leave 0 */ }
        out.push({ distinct: -1, nulls });
      }
    }
    return out;
  }
}

/** All values of the column at `index` as plain JS values. */
function vectorValues(table: ArrowTable, index: number): unknown[] {
  const vec = table.getChildAt(index);
  const field = table.schema.fields[index];
  const out: unknown[] = [];
  if (!vec || !field) return out;
  const convert = cellConverter(field);
  for (let r = 0; r < table.numRows; r++) out.push(convert(vec.get(r)));
  return out;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** Formats epoch milliseconds as a naive `YYYY-MM-DD HH:MM:SS[.mmm]` (UTC parts). */
function naiveTimestamp(ms: number): string {
  const d = new Date(ms);
  let s = `${d.toISOString().slice(0, 10)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (d.getUTCMilliseconds() !== 0) s += `.${pad(d.getUTCMilliseconds(), 3)}`;
  return s;
}

/** Inserts the decimal point into an unscaled integer string. */
function scaleDecimal(unscaled: string, scale: number): string {
  if (scale <= 0) return unscaled;
  const neg = unscaled.startsWith('-');
  let digits = neg ? unscaled.slice(1) : unscaled;
  digits = digits.padStart(scale + 1, '0');
  const intPart = digits.slice(0, -scale);
  const frac = digits.slice(-scale).replace(/0+$/, '');
  return `${neg ? '-' : ''}${intPart}${frac ? '.' + frac : ''}`;
}

/**
 * Arrow's cell getters return epoch milliseconds for dates/timestamps, raw
 * integers for times and an unscaled big number for decimals. Convert those
 * into readable values based on the column's declared type.
 */
function cellConverter(field: Field): (v: unknown) => unknown {
  const t = field.type;
  if (DataType.isDate(t)) {
    return (v) => (typeof v === 'number' ? new Date(v).toISOString().slice(0, 10) : toPlain(v));
  }
  if (DataType.isTimestamp(t)) {
    const tz = t.timezone;
    return (v) => {
      if (typeof v !== 'number') return toPlain(v);
      return tz ? new Date(v).toISOString() : naiveTimestamp(v);
    };
  }
  if (DataType.isTime(t)) {
    // Value is an integer in the type's unit; render as HH:MM:SS[.fraction].
    const perSecond = { 0: 1, 1: 1e3, 2: 1e6, 3: 1e9 }[t.unit] ?? 1e6;
    return (v) => {
      if (typeof v !== 'number' && typeof v !== 'bigint') return toPlain(v);
      const total = Number(v);
      const secs = Math.floor(total / perSecond);
      const frac = total - secs * perSecond;
      const base = `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`;
      if (frac === 0) return base;
      const width = Math.round(Math.log10(perSecond));
      return `${base}.${pad(frac, width).replace(/0+$/, '')}`;
    };
  }
  if (DataType.isDecimal(t)) {
    const scale = t.scale;
    return (v) => (v === null || v === undefined ? v : scaleDecimal(String(v), scale));
  }
  return toPlain;
}

function columnValues(table: ArrowTable, name: string): unknown[] {
  const idx = table.schema.fields.findIndex((f) => f.name === name);
  return idx < 0 ? [] : vectorValues(table, idx);
}

/** Converts Arrow row/vector wrappers (which expose toJSON) into plain values. */
function toPlain(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (v instanceof Date || typeof v !== 'object') return v;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v.map(toPlain);
  const j = (v as { toJSON?: () => unknown }).toJSON;
  if (typeof j === 'function') return toPlain(j.call(v));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = toPlain(val);
  return out;
}

/** Runs a SQL statement and returns up to `maxRows` rows with raw JS values. */
export async function runQuery(sql: string, maxRows = 500): Promise<QueryResult> {
  const conn = await getConn();
  const table = await conn.query(sql);
  const columns = table.schema.fields.map((f) => f.name);
  const rowCount = table.numRows;
  const limit = Math.min(rowCount, maxRows);
  const vectors = columns.map((_, i) => table.getChildAt(i));
  const converters = table.schema.fields.map(cellConverter);
  const rows: unknown[][] = [];
  for (let r = 0; r < limit; r++) {
    rows.push(vectors.map((vec, i) => converters[i](vec ? vec.get(r) : null)));
  }
  return { columns, rows, rowCount, truncated: rowCount > limit };
}

/** Human-readable string for any cell value (used for profiles and display). */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
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

