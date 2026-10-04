/**
 * Validation of the `{ dataset, question }` part of a request body, shared by
 * the functions that take one (query, mapping, step).
 */
import type {
  ColumnProfile,
  ColumnRef,
  DatasetProfile,
  RelationshipHint,
  TableProfile,
} from "../../shared/types.js";

export const MAX_QUESTION_LENGTH = 2000;
/** Caps that bound the size (and so the cost) of one prompt. */
export const MAX_TABLES = 25;
export const MAX_COLUMNS_PER_TABLE = 400;
export const MAX_VALUES_PER_COLUMN = 25;
export const MAX_STRING = 300;
export const MAX_HINTS = 500;
export const MAX_PROMPT_CHARS = 200_000;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function finiteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Rebuilds a column profile from untrusted input, keeping only known fields within size limits. */
function validateColumn(v: unknown, at: string): ColumnProfile | string {
  if (!isRecord(v)) return `${at} must be an object`;
  if (typeof v.name !== "string" || v.name.length === 0 || v.name.length > MAX_STRING) return `${at}.name must be a string of 1-${MAX_STRING} characters`;
  if (typeof v.type !== "string" || v.type.length > MAX_STRING) return `${at}.type must be a string`;
  if (!finiteNumber(v.distinctCount) || !finiteNumber(v.nullCount)) return `${at}.distinctCount and .nullCount must be numbers`;
  const col: ColumnProfile = {
    name: v.name,
    type: v.type,
    distinctCount: v.distinctCount,
    nullCount: v.nullCount,
    unique: v.unique === true,
  };
  if (v.min !== undefined) {
    if (typeof v.min !== "string" || v.min.length > MAX_STRING) return `${at}.min must be a short string`;
    col.min = v.min;
  }
  if (v.max !== undefined) {
    if (typeof v.max !== "string" || v.max.length > MAX_STRING) return `${at}.max must be a short string`;
    col.max = v.max;
  }
  if (v.values !== undefined) {
    if (!Array.isArray(v.values) || v.values.length > MAX_VALUES_PER_COLUMN) return `${at}.values must be an array of at most ${MAX_VALUES_PER_COLUMN}`;
    if (!v.values.every((x) => typeof x === "string" && x.length <= MAX_STRING)) return `${at}.values must be short strings`;
    col.values = v.values as string[];
  }
  if (v.valuesWithheld === true) col.valuesWithheld = true;
  return col;
}

function validateHint(v: unknown, at: string): RelationshipHint | string {
  if (!isRecord(v) || !isRecord(v.left) || !isRecord(v.right)) return `${at} must have left and right`;
  const ref = (r: Record<string, unknown>): ColumnRef | null =>
    typeof r.table === "string" && r.table.length <= MAX_STRING && typeof r.column === "string" && r.column.length <= MAX_STRING
      ? { table: r.table, column: r.column }
      : null;
  const left = ref(v.left);
  const right = ref(v.right);
  if (!left || !right) return `${at} must reference table and column names`;
  const hint: RelationshipHint = { left, right, sharedName: v.sharedName === true };
  for (const key of ["leftInRight", "rightInLeft", "sharedValues"] as const) {
    const value = v[key];
    if (value === undefined) continue;
    if (!finiteNumber(value) || value < 0) return `${at}.${key} must be a non-negative number`;
    hint[key] = value;
  }
  return hint;
}

/**
 * Validates and rebuilds `{ dataset, question }` from an untrusted request body
 * (other fields are ignored). Returns an error message for a 400 on failure.
 */
export function validateQueryLike(body: unknown): { dataset: DatasetProfile; question: string } | string {
  if (!isRecord(body)) return "Request body must be a JSON object";
  const { dataset, question } = body;
  if (typeof question !== "string" || question.trim().length === 0) return "`question` must be a non-empty string";
  if (question.length > MAX_QUESTION_LENGTH) return `\`question\` must be at most ${MAX_QUESTION_LENGTH} characters`;
  if (!isRecord(dataset)) return "`dataset` must be an object";
  if (!Array.isArray(dataset.tables) || dataset.tables.length === 0) return "`dataset.tables` must be a non-empty array";
  if (dataset.tables.length > MAX_TABLES) return `\`dataset.tables\` must have at most ${MAX_TABLES} entries`;
  if (dataset.hints !== undefined && !Array.isArray(dataset.hints)) return "`dataset.hints` must be an array";
  const rawHints: unknown[] = Array.isArray(dataset.hints) ? dataset.hints : [];
  if (rawHints.length > MAX_HINTS) return `\`dataset.hints\` must have at most ${MAX_HINTS} entries`;

  const tables: TableProfile[] = [];
  for (const [i, table] of dataset.tables.entries()) {
    const at = `\`dataset.tables[${i}]\``;
    if (!isRecord(table)) return `${at} must be an object`;
    if (typeof table.table !== "string" || table.table.length === 0 || table.table.length > MAX_STRING) return `${at}.table must be a string of 1-${MAX_STRING} characters`;
    if (!finiteNumber(table.rowCount)) return `${at}.rowCount must be a number`;
    if (!Array.isArray(table.columns) || table.columns.length === 0) return `${at}.columns must be a non-empty array`;
    if (table.columns.length > MAX_COLUMNS_PER_TABLE) return `${at}.columns must have at most ${MAX_COLUMNS_PER_TABLE} entries`;
    const columns: ColumnProfile[] = [];
    for (const [j, col] of table.columns.entries()) {
      const parsed = validateColumn(col, `${at}.columns[${j}]`);
      if (typeof parsed === "string") return parsed;
      columns.push(parsed);
    }
    const fileName = typeof table.fileName === "string" ? table.fileName.slice(0, MAX_STRING) : "upload";
    tables.push({ table: table.table, rowCount: table.rowCount, columns, fileName });
  }
  const hints: RelationshipHint[] = [];
  for (const [i, hint] of rawHints.entries()) {
    const parsed = validateHint(hint, `\`dataset.hints[${i}]\``);
    if (typeof parsed === "string") return parsed;
    hints.push(parsed);
  }
  return { dataset: { tables, hints }, question: question.trim() };
}
