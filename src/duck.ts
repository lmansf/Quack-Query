/**
 * Thin wrapper around DuckDB-Wasm: one lazily-created database, one reused
 * connection, any number of loaded tables (one per uploaded file). Everything
 * runs in the browser. Besides loading and profiling, this module computes
 * cross-table relationship hints (shared column names and value overlap).
 */
import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { DataType, type Field, type Table as ArrowTable } from 'apache-arrow';
import { LOW_CARDINALITY_LIMIT, MAX_OVERLAP_PAIRS, MIN_OVERLAP_FRACTION } from '../shared/types';
import type { ColumnProfile, DatasetProfile, RelationshipHint, TableProfile } from '../shared/types';

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

interface LoadedTable {
  fileName: string;
  /** Name the browser File is registered under in DuckDB's virtual FS. */
  registeredName: string;
  profile: TableProfile;
  /** Kept so tables can be rebuilt after an engine restart. */
  file: File;
}

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;
let connPromise: Promise<duckdb.AsyncDuckDBConnection> | null = null;
/** table name -> loaded table, in insertion order. */
const tables = new Map<string, LoadedTable>();

/**
 * Every file DuckDB may touch lives under this virtual prefix. At startup the
 * database is locked so that only this prefix is accessible: model-generated
 * SQL cannot read URLs or other files no matter how it is written.
 */
const UPLOAD_PREFIX = 'uploads/';
/** Extensions that must be present before the lock, since loading is refused afterwards. */
const PRELOAD_EXTENSIONS = ['parquet', 'json'];
/** Wall-clock limits; a query past its limit is cancelled inside the worker. */
const QUERY_TIMEOUT_MS = 60_000;
const EXPORT_TIMEOUT_MS = 300_000;

const extensionErrors = new Map<string, string>();

/** Names of extensions that failed to load at startup (their features will error later). */
export function unavailableExtensions(): string[] {
  return Array.from(extensionErrors.keys());
}

/** Instantiates the single DuckDB-Wasm instance. Safe to call repeatedly. */
export async function initDuckDB(): Promise<void> {
  await getConn();
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

/**
 * Opens the shared connection and locks the database down:
 * 1. allow file access only under UPLOAD_PREFIX,
 * 2. load the extensions uploads/exports need (network fetch, best effort),
 * 3. disable all other external access and extension loading,
 * 4. lock the configuration so no statement can undo the above.
 */
function getConn(): Promise<duckdb.AsyncDuckDBConnection> {
  if (!connPromise) {
    connPromise = (async () => {
      const db = await getDb();
      const conn = await db.connect();
      await conn.query(`SET allowed_directories = [${quoteLiteral(UPLOAD_PREFIX)}]`);
      for (const ext of PRELOAD_EXTENSIONS) {
        try {
          await conn.query(`LOAD ${ext}`);
        } catch (err) {
          extensionErrors.set(ext, err instanceof Error ? err.message : String(err));
        }
      }
      await conn.query('SET autoinstall_known_extensions = false');
      await conn.query('SET autoload_known_extensions = false');
      await conn.query('SET enable_external_access = false');
      await conn.query('SET lock_configuration = true');
      return conn;
    })();
  }
  return connPromise;
}

let resetting: Promise<void> | null = null;

/**
 * Tears down a wedged engine and rebuilds it from the original File objects.
 * DuckDB-Wasm runs single-threaded in its worker, so a runaway query cannot be
 * interrupted; terminating the worker is the only way to get the tab back.
 */
function resetEngine(): Promise<void> {
  if (!resetting) {
    resetting = (async () => {
      const old = dbPromise;
      dbPromise = null;
      connPromise = null;
      extensionErrors.clear();
      if (old) await old.then((db) => db.terminate()).catch(() => null);
      const entries = Array.from(tables.values());
      tables.clear();
      const failures: string[] = [];
      for (const entry of entries) {
        try {
          await addFile(entry.file);
        } catch (err) {
          failures.push(`${entry.fileName}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (failures.length > 0) throw new Error(`Some tables could not be reloaded — ${failures.join('; ')}`);
    })().finally(() => {
      resetting = null;
    });
  }
  return resetting;
}

/**
 * Runs a statement with a wall-clock limit. On timeout the engine is restarted
 * (the running query cannot be interrupted), the loaded files are re-added,
 * and an error is thrown.
 */
async function queryWithTimeout(
  conn: duckdb.AsyncDuckDBConnection,
  sql: string,
  timeoutMs: number,
): Promise<ArrowTable> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  try {
    return await Promise.race([conn.query(sql), timeout]);
  } catch (err) {
    if (err instanceof Error && err.message === 'timeout') {
      const seconds = Math.round(timeoutMs / 1000);
      let note = 'The database was restarted and your files were reloaded.';
      try {
        await resetEngine();
      } catch (resetErr) {
        note = resetErr instanceof Error ? resetErr.message : String(resetErr);
      }
      throw new Error(`Query stopped after ${seconds} seconds. ${note}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Quotes a SQL identifier, doubling embedded double quotes. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quotes a SQL string literal, doubling embedded single quotes. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Derives a safe table name from a file name, made unique among loaded tables. */
function tableNameFor(fileName: string): string {
  let base = fileName.replace(/\.[^.]*$/, '').toLowerCase();
  base = base.replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (/^[0-9]/.test(base)) base = `t_${base}`;
  base = base || 'data';
  let name = base;
  for (let i = 2; tables.has(name); i++) name = `${base}_${i}`;
  return name;
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

/** Registers a browser File, loads it into a new table, profiles and remembers it. */
export async function addFile(file: File): Promise<TableProfile> {
  const reader = readerFor(file.name); // throws early for unsupported types
  const db = await getDb();
  const conn = await getConn();
  const needs = reader === 'read_parquet' ? 'parquet' : reader === 'read_json_auto' ? 'json' : null;
  const missing = needs ? extensionErrors.get(needs) : undefined;
  if (needs && missing) {
    throw new Error(
      `Reading ${needs} files needs DuckDB's ${needs} extension, which could not be downloaded from ` +
        `extensions.duckdb.org when the page loaded (${missing}). Reload the page to try again.`,
    );
  }
  const table = tableNameFor(file.name);
  const registeredName = `${UPLOAD_PREFIX}${table}__${file.name}`;
  await db.registerFileHandle(registeredName, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
  try {
    await conn.query(
      `CREATE TABLE ${quoteIdent(table)} AS SELECT * FROM ${reader}(${quoteLiteral(registeredName)})`,
    );
    const profile = await profileTable(table, file.name);
    tables.set(table, { fileName: file.name, registeredName, profile, file });
    return profile;
  } catch (err) {
    await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(table)}`).catch(() => null);
    await db.dropFile(registeredName).catch(() => null);
    throw err;
  }
}

/** Drops a loaded table and its registered file. Unknown names are ignored. */
export async function removeTable(table: string): Promise<void> {
  const entry = tables.get(table);
  const db = await getDb();
  const conn = await getConn();
  await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
  if (entry) await db.dropFile(entry.registeredName).catch(() => null);
  tables.delete(table);
}

/** Profiles of every loaded table, in insertion order. */
export function listTables(): TableProfile[] {
  return Array.from(tables.values(), (t) => t.profile);
}

/** The full dataset: table profiles plus freshly computed relationship hints. */
export async function buildDataset(): Promise<DatasetProfile> {
  const list = listTables();
  return { tables: list, hints: await computeHints(list) };
}

// ---------------------------------------------------------------------------
// Profiling
// ---------------------------------------------------------------------------

const NUMERIC_RE = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL)/i;
const TEMPORAL_RE = /^(DATE|TIMESTAMP|TIME)/i;

export type TypeFamily = 'numeric' | 'temporal' | 'varchar';

/** Coarse join-compatibility family of a DuckDB type name, or null for others. */
export function typeFamily(type: string): TypeFamily | null {
  if (NUMERIC_RE.test(type)) return 'numeric';
  if (TEMPORAL_RE.test(type)) return 'temporal';
  if (/^VARCHAR/i.test(type)) return 'varchar';
  return null;
}

/** True when a column's min/max should be collected (numeric or temporal). */
function hasRange(type: string): boolean {
  const f = typeFamily(type);
  return f === 'numeric' || f === 'temporal';
}

interface ColumnStats { distinct: number; nulls: number; min?: string; max?: string }

/** Computes row count, column types, distinct/null counts, ranges and low-cardinality values. */
async function profileTable(table: string, fileName: string): Promise<TableProfile> {
  const conn = await getConn();
  const t = quoteIdent(table);

  const countRes = await conn.query(`SELECT count(*) AS n FROM ${t}`);
  const rowCount = Number(countRes.getChildAt(0)?.get(0) ?? 0);

  const desc = await conn.query(`DESCRIBE ${t}`);
  const names = columnValues(desc, 'column_name').map(String);
  const types = columnValues(desc, 'column_type').map(String);

  const stats = await columnStats(t, names, types);

  const columns: ColumnProfile[] = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const s = stats[i];
    const col: ColumnProfile = {
      name,
      type: types[i],
      distinctCount: s.distinct,
      nullCount: s.nulls,
      unique: s.nulls === 0 && s.distinct === rowCount && rowCount > 0,
    };
    if (s.min !== undefined) col.min = s.min;
    if (s.max !== undefined) col.max = s.max;
    if (col.distinctCount >= 0 && col.distinctCount <= LOW_CARDINALITY_LIMIT) {
      const q = quoteIdent(name);
      const res = await conn.query(
        `SELECT DISTINCT ${q} FROM ${t} WHERE ${q} IS NOT NULL ORDER BY 1 LIMIT ${LOW_CARDINALITY_LIMIT}`,
      );
      const values = vectorValues(res, 0).map(formatValue);
      // Personal data stays in the browser: the model learns the column exists, not its contents.
      if (looksSensitive(name, values)) col.valuesWithheld = true;
      else col.values = values;
    }
    columns.push(col);
  }
  return { table, fileName, rowCount, columns };
}

/** Column names that conventionally hold personal or secret data. */
const SENSITIVE_NAME_RE =
  /(^|[_\s-])(e-?mail|phone|mobile|tel|fax|ssn|social|passport|licen[cs]e|iban|swift|bic|account|acct|card|cvv|pin|password|passwd|pwd|token|secret|api_?key|dob|birth(day|date)?|address|street|zip|postal|postcode|salary|income|diagnosis|username|user_?name|login|ip)($|[_\s-])/i;
/** Names that by themselves denote a person. */
const PERSON_NAME_RE = /^(name|full_?name|first_?name|last_?name|surname|customer_?name|person|patient|employee|contact|author|owner)$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s().-]{7,}$/;

/**
 * Heuristic used to keep personal data out of the schema profile: true when
 * the column name suggests PII or secrets, or when most values look like
 * email addresses or phone numbers.
 */
export function looksSensitive(name: string, values: string[]): boolean {
  const n = name.trim();
  if (SENSITIVE_NAME_RE.test(n) || PERSON_NAME_RE.test(n)) return true;
  const nonEmpty = values.filter((v) => v.trim() !== '');
  if (nonEmpty.length === 0) return false;
  const emails = nonEmpty.filter((v) => EMAIL_RE.test(v)).length;
  const phones = nonEmpty.filter((v) => PHONE_RE.test(v) && /\d{7,}/.test(v.replace(/\D/g, ''))).length;
  return emails / nonEmpty.length >= 0.5 || phones / nonEmpty.length >= 0.5;
}

/** Builds the aggregate expressions for one column, aliased by its index. */
function statsExpr(name: string, type: string, i: number): string {
  const q = quoteIdent(name);
  let e = `count(DISTINCT ${q}) AS d${i}, count(*) - count(${q}) AS n${i}`;
  if (hasRange(type)) e += `, min(${q}) AS mn${i}, max(${q}) AS mx${i}`;
  return e;
}

/** Reads the aggregates for column `i` out of a stats result (aliases from `statsExpr`). */
function readStats(res: ArrowTable, i: number): ColumnStats {
  const first = (alias: string): unknown => columnValues(res, alias)[0];
  const out: ColumnStats = {
    distinct: Number(first(`d${i}`) ?? 0),
    nulls: Number(first(`n${i}`) ?? 0),
  };
  const mn = first(`mn${i}`);
  const mx = first(`mx${i}`);
  if (mn !== null && mn !== undefined) out.min = formatValue(mn);
  if (mx !== null && mx !== undefined) out.max = formatValue(mx);
  return out;
}

/** Stats for every column; one combined query with per-column fallback. */
async function columnStats(t: string, names: string[], types: string[]): Promise<ColumnStats[]> {
  const conn = await getConn();
  if (names.length === 0) return [];
  try {
    const res = await conn.query(
      `SELECT ${names.map((n, i) => statsExpr(n, types[i], i)).join(', ')} FROM ${t}`,
    );
    return names.map((_, i) => readStats(res, i));
  } catch {
    // Some types (LIST/STRUCT/MAP...) reject count(DISTINCT); isolate failures.
    const out: ColumnStats[] = [];
    for (const [i, n] of names.entries()) {
      try {
        const res = await conn.query(`SELECT ${statsExpr(n, types[i], i)} FROM ${t}`);
        out.push(readStats(res, i));
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

// ---------------------------------------------------------------------------
// Relationship hints
// ---------------------------------------------------------------------------

interface Candidate {
  left: TableProfile;
  leftCol: ColumnProfile;
  right: TableProfile;
  rightCol: ColumnProfile;
  sharedName: boolean;
  /** A column name references the other table (customer_id <-> customers). */
  nameAffinity: boolean;
}

/** Column names compare equal case-insensitively after trimming. */
function normName(name: string): string {
  return name.trim().toLowerCase();
}

const KEY_SUFFIX_RE = /(^|[_\s.-])(id|ids|key|code|no|num|number|sku|uuid|guid|pk|fk|ref)$/;

/** True for names that conventionally hold identifiers (id, customer_id, orderId, sku). */
export function looksLikeKey(name: string): boolean {
  const n = normName(name);
  return n === 'id' || KEY_SUFFIX_RE.test(n) || /[a-z](Id|Key|Code|No|Num)$/.test(name.trim());
}

/** Crude singular form for matching column stems against table names. */
function stem(name: string): string {
  const n = normName(name).replace(/[^a-z0-9]/g, '');
  return n.endsWith('ies') ? `${n.slice(0, -3)}y` : n.endsWith('s') ? n.slice(0, -1) : n;
}

/** True when a column name is built from the other table's name (customer_id <-> customers). */
export function nameAffinity(colName: string, otherTable: string): boolean {
  const col = normName(colName).replace(/(^|[_\s.-])(id|ids|key|code|no|num|number|pk|fk|ref)$/, '');
  const colStem = stem(col);
  const tableStem = stem(otherTable);
  if (colStem.length < 3 || tableStem.length < 3) return false;
  return colStem === tableStem || colStem.endsWith(tableStem) || tableStem.endsWith(colStem);
}

/** True when the closed ranges [a.min, a.max] and [b.min, b.max] overlap. */
export function rangesIntersect(
  a: { min: string; max: string },
  b: { min: string; max: string },
  numeric: boolean,
): boolean {
  if (numeric) {
    const [aMin, aMax, bMin, bMax] = [a.min, a.max, b.min, b.max].map(Number);
    if ([aMin, aMax, bMin, bMax].some(Number.isNaN)) return true; // unknown: don't exclude
    return aMin <= bMax && bMin <= aMax;
  }
  return a.min <= b.max && b.min <= a.max;
}

/** Cheap pre-check: two fully listed value sets that share nothing cannot join. */
function valuesDisjoint(a: ColumnProfile, b: ColumnProfile): boolean {
  if (!a.values || !b.values) return false;
  const set = new Set(a.values);
  return !b.values.some((v) => set.has(v));
}

/**
 * Type-compatible and plausible join partner without relying on a shared name.
 * Overlapping string values are decent evidence on their own; overlapping
 * numeric or date ranges are not (quantities and ids both live in 1..N), so
 * those families additionally need a key-like name or a table-name affinity.
 */
function plausiblePair(a: ColumnProfile, b: ColumnProfile, affinity: boolean): boolean {
  const fam = typeFamily(a.type);
  if (!fam || fam !== typeFamily(b.type)) return false;
  if (a.distinctCount < 2 || b.distinctCount < 2) return false;
  if (fam === 'varchar') {
    return a.unique || b.unique || (a.distinctCount <= 1000 && b.distinctCount <= 1000);
  }
  if (!affinity && !(looksLikeKey(a.name) && looksLikeKey(b.name))) return false;
  if (a.min === undefined || a.max === undefined || b.min === undefined || b.max === undefined) {
    return false;
  }
  return rangesIntersect(
    { min: a.min, max: a.max },
    { min: b.min, max: b.max },
    fam === 'numeric',
  );
}

/** Every cross-table column pair worth reporting or measuring, unranked. */
function collectCandidates(list: TableProfile[]): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const left = list[i];
      const right = list[j];
      for (const leftCol of left.columns) {
        for (const rightCol of right.columns) {
          const sharedName = normName(leftCol.name) === normName(rightCol.name);
          const affinity =
            (nameAffinity(leftCol.name, right.table) && looksLikeKey(rightCol.name)) ||
            (nameAffinity(rightCol.name, left.table) && looksLikeKey(leftCol.name));
          if (!sharedName && !plausiblePair(leftCol, rightCol, affinity)) continue;
          if (valuesDisjoint(leftCol, rightCol)) continue;
          out.push({ left, leftCol, right, rightCol, sharedName, nameAffinity: affinity });
        }
      }
    }
  }
  return out;
}

/** Lower is measured first: shared names, table-name affinity, candidate keys, then the rest. */
function candidateRank(c: Candidate): number {
  if (c.sharedName) return 0;
  if (c.nameAffinity) return 1;
  if (c.leftCol.unique || c.rightCol.unique) return 2;
  return 3;
}

/** Whether measuring this pair can produce meaningful fractions. */
function measurable(c: Candidate): boolean {
  return (
    c.left.rowCount > 0 && c.right.rowCount > 0 &&
    c.leftCol.distinctCount > 0 && c.rightCol.distinctCount > 0
  );
}

/** Number of distinct non-null values present in both columns, or null on error. */
async function measureOverlap(c: Candidate): Promise<number | null> {
  const conn = await getConn();
  const sameFamily = typeFamily(c.leftCol.type) !== null &&
    typeFamily(c.leftCol.type) === typeFamily(c.rightCol.type);
  // Within a family DuckDB coerces (INTEGER vs BIGINT, DATE vs TIMESTAMP); across
  // families compare as text to avoid binder/cast errors (BIGINT vs VARCHAR ids).
  const cast = c.leftCol.type === c.rightCol.type || sameFamily ? '' : '::VARCHAR';
  const side = (table: string, col: string, alias: string) =>
    `(SELECT DISTINCT ${alias}.${quoteIdent(col)}${cast} AS v FROM ${quoteIdent(table)} ${alias}` +
    ` WHERE ${alias}.${quoteIdent(col)} IS NOT NULL)`;
  const sql =
    `SELECT count(*) AS n FROM ${side(c.left.table, c.leftCol.name, 'l')} a` +
    ` INNER JOIN ${side(c.right.table, c.rightCol.name, 'r')} b ON a.v = b.v`;
  try {
    const res = await conn.query(sql);
    return Number(res.getChildAt(0)?.get(0) ?? 0);
  } catch {
    return null;
  }
}

/** Highest overlap fraction of a hint, or -1 when unmeasured (sorts last). */
function hintScore(h: RelationshipHint): number {
  return Math.max(h.leftInRight ?? -1, h.rightInLeft ?? -1);
}

/** Computes relationship hints across all pairs of different tables. */
async function computeHints(list: TableProfile[]): Promise<RelationshipHint[]> {
  const candidates = collectCandidates(list)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => candidateRank(a.c) - candidateRank(b.c) || a.i - b.i)
    .map(({ c }) => c);

  const hints: RelationshipHint[] = [];
  let measured = 0;
  for (const c of candidates) {
    const hint: RelationshipHint = {
      left: { table: c.left.table, column: c.leftCol.name },
      right: { table: c.right.table, column: c.rightCol.name },
      sharedName: c.sharedName,
    };
    if (measured < MAX_OVERLAP_PAIRS && measurable(c)) {
      measured++;
      const shared = await measureOverlap(c);
      if (shared !== null) {
        hint.sharedValues = shared;
        hint.leftInRight = shared / c.leftCol.distinctCount;
        hint.rightInLeft = shared / c.rightCol.distinctCount;
      }
    }
    if (hint.sharedName || hintScore(hint) >= MIN_OVERLAP_FRACTION) hints.push(hint);
  }
  return hints.sort(
    (a, b) => Number(b.sharedName) - Number(a.sharedName) || hintScore(b) - hintScore(a),
  );
}

// ---------------------------------------------------------------------------
// Arrow value conversion
// ---------------------------------------------------------------------------

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

function columnValues(table: ArrowTable, name: string): unknown[] {
  const idx = table.schema.fields.findIndex((f) => f.name === name);
  return idx < 0 ? [] : vectorValues(table, idx);
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

// ---------------------------------------------------------------------------
// Querying and display
// ---------------------------------------------------------------------------

/** Runs a SQL statement and returns up to `maxRows` rows with raw JS values. */
export async function runQuery(sql: string, maxRows = 500): Promise<QueryResult> {
  const conn = await getConn();
  const table = await queryWithTimeout(conn, sql, QUERY_TIMEOUT_MS);
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

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** File formats `exportQuery` can produce. */
export type ExportFormat = 'csv' | 'parquet';

/** Monotonic suffix that keeps concurrent export temp files distinct. */
let exportCounter = 0;

/**
 * Runs an (already validated, read-only) query and returns its full result
 * serialized as a file. The query is wrapped in DuckDB's `COPY (...) TO`,
 * written to a temp file in DuckDB-Wasm's in-memory virtual filesystem, read
 * back as bytes, and the temp file is removed again.
 *
 * - `csv`: RFC-4180-style CSV (comma separator, `"` quoting with doubled
 *   embedded quotes, `\n` line endings) with a header row. NULLs are written
 *   as empty fields, dates as `YYYY-MM-DD`.
 * - `parquet`: a standard Parquet file (default DuckDB compression).
 *
 * A single trailing `;` on the user SQL is stripped, since a `COPY` subquery
 * cannot end with one. Any DuckDB error propagates to the caller.
 */
export async function exportQuery(sql: string, format: ExportFormat): Promise<Uint8Array> {
  const db = await getDb();
  const conn = await getConn();
  const inner = subqueryText(sql);
  const name = `${UPLOAD_PREFIX}export_${Date.now()}_${exportCounter++}.${format}`;
  const options = format === 'csv' ? 'FORMAT CSV, HEADER true' : 'FORMAT PARQUET';
  const missing = extensionErrors.get(format);
  if (missing) throw new Error(`DuckDB's ${format} extension did not load at startup (${missing})`);
  try {
    // Pre-register the target as an in-memory buffer file (DuckDB-Wasm's documented
    // COPY-to-buffer pattern); the COPY below then writes into the virtual FS.
    await db.registerEmptyFileBuffer(name);
    await queryWithTimeout(conn, `COPY (${inner}) TO ${quoteLiteral(name)} (${options})`, EXPORT_TIMEOUT_MS);
    return await db.copyFileToBuffer(name);
  } finally {
    await db.dropFile(name).catch(() => null);
  }
}

/** Trims a statement and strips a single trailing `;` so it can be used as a subquery. */
function subqueryText(sql: string): string {
  return sql.trim().replace(/;$/, '');
}

/**
 * Exact number of rows a read-only statement produces, computed inside DuckDB
 * (`SELECT count(*) FROM (<sql>)`) so the result is never materialized here.
 * Throws for statements DuckDB will not accept as a subquery (SHOW, PRAGMA...).
 */
export async function countQuery(sql: string): Promise<number> {
  const conn = await getConn();
  const res = await queryWithTimeout(conn, `SELECT count(*) AS n FROM (${subqueryText(sql)}) AS q`, QUERY_TIMEOUT_MS);
  return Number(res.getChildAt(0)?.get(0) ?? 0);
}

/**
 * Like `runQuery`, but fetches only the first `maxRows` rows (`... LIMIT maxRows + 1`)
 * and gets the exact `rowCount` from a separate `countQuery`, so large results
 * never have to be materialized in the browser. Pass `knownRowCount` (from an
 * earlier `countQuery(sql)`) to skip the count. Statements DuckDB rejects as a
 * subquery (SHOW, DESCRIBE, PRAGMA...) fall back to a plain `runQuery`.
 */
export async function runQueryPreview(
  sql: string,
  maxRows = 500,
  knownRowCount?: number,
): Promise<QueryResult> {
  const inner = subqueryText(sql);
  let preview: QueryResult;
  let rowCount: number;
  try {
    preview = await runQuery(`SELECT * FROM (${inner}) AS q LIMIT ${maxRows + 1}`, maxRows + 1);
    rowCount = knownRowCount ?? (await countQuery(inner));
  } catch {
    return runQuery(sql, maxRows);
  }
  return {
    columns: preview.columns,
    rows: preview.rows.slice(0, maxRows),
    rowCount,
    truncated: rowCount > maxRows,
  };
}

/** Human-readable string for any cell value (used for profiles and display). */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return String(v);
  // Strip binary floating-point noise (668.3399999999999 -> 668.34) while keeping 15 significant digits.
  if (typeof v === 'number') return Number.isFinite(v) ? String(Number(v.toPrecision(15))) : String(v);
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
