/**
 * System-prompt builder shared by the serverless function (api/) and the
 * browser client (src/), so the UI can render exactly what the model sees.
 * Dependency-free: imports only types from ./types.
 */
import type { ColumnProfile, DatasetProfile, RelationshipHint, TableProfile } from "./types";

/** Overlap fraction at or above which a hint (with a unique side) is called a likely join key. */
export const LIKELY_JOIN_OVERLAP = 0.9;

export function describeColumn(col: ColumnProfile): string {
  const distinct = col.distinctCount === -1 ? "distinct count unavailable" : `${col.distinctCount} distinct`;
  let line = `- "${col.name}" ${col.type} — ${distinct}, ${col.nullCount} null`;
  if (col.unique) line += " — unique";
  if (col.min !== undefined && col.max !== undefined) line += ` — range ${col.min} to ${col.max}`;
  if (col.values !== undefined) {
    const values = col.values.map((v) => v.replace(/\r?\n/g, " ").trim()).filter((v) => v.length > 0);
    if (values.length > 0) line += ` — values: ${values.join(", ")}`;
  }
  return line;
}

export function describeTable(profile: TableProfile): string[] {
  return [
    `Table "${profile.table}" (${profile.rowCount.toLocaleString("en-US")} rows), loaded from ${profile.fileName}:`,
    ...profile.columns.map(describeColumn),
  ];
}

export function findColumn(tables: TableProfile[], table: string, column: string): ColumnProfile | undefined {
  return tables.find((t) => t.table === table)?.columns.find((c) => c.name === column);
}

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function describeHint(hint: RelationshipHint, tables: TableProfile[]): string {
  const left = `"${hint.left.table}"."${hint.left.column}"`;
  const right = `"${hint.right.table}"."${hint.right.column}"`;
  const details: string[] = [];
  if (hint.sharedName) details.push("same name");
  const { leftInRight, rightInLeft } = hint;
  const measured = leftInRight !== undefined && rightInLeft !== undefined;
  if (measured) {
    if (hint.sharedValues !== undefined) details.push(`${hint.sharedValues.toLocaleString("en-US")} shared values`);
    details.push(`${percent(leftInRight)} of ${left} values exist in ${right}`);
    details.push(`${percent(rightInLeft)} of ${right} values exist in ${left}`);
  }
  let line = `- ${left} <-> ${right}`;
  if (details.length > 0) line += `: ${details.join(", ")}`;

  if (measured && (leftInRight >= LIKELY_JOIN_OVERLAP || rightInLeft >= LIKELY_JOIN_OVERLAP)) {
    const leftUnique = findColumn(tables, hint.left.table, hint.left.column)?.unique === true;
    const rightUnique = findColumn(tables, hint.right.table, hint.right.column)?.unique === true;
    if (leftUnique || rightUnique) line += " — likely join key";
  }
  return line;
}

/**
 * Builds the (cached) system prompt describing every loaded table and the
 * heuristic relationships between them. Deterministic for a given dataset so
 * the provider's prefix cache can reuse it across questions.
 */
export function buildSystemPrompt(dataset: DatasetProfile): string {
  const lines: string[] = [];
  const tableNames = dataset.tables.map((t) => `"${t.table}"`).join(", ");
  lines.push(
    "You are Quack Query, a SQL assistant. The user's data is loaded into DuckDB tables in their browser.",
    "",
    "Output rule: respond with exactly ONE DuckDB SQL statement and nothing else — no prose, no explanation, no markdown fences, no trailing semicolon. If the question cannot be answered from these tables, respond with SELECT '<short reason>' AS error so the response is still valid SQL.",
    "",
    "Query rules:",
    "- Read-only: SELECT or WITH ... SELECT only.",
    `- Reference tables exactly by their double-quoted names as listed in the schema: ${tableNames}.`,
    "- Double-quote every column identifier exactly as given in the schema.",
    "- Qualify column names with the table name (or an alias) whenever the query touches more than one table.",
    "- Joins across tables are allowed. Prefer the join keys named in the relationship hints; otherwise join on columns with matching names and compatible types.",
    "- Prefer DuckDB idioms (e.g. count(*), date_trunc, strftime, QUALIFY, list_aggregate).",
    "- Add LIMIT 100 unless the question asks for a specific count or an aggregate that naturally returns few rows.",
    "- When matching low-cardinality string values, use the exact values listed in the profile (case matters).",
    "- Give aggregate columns readable aliases.",
    "- When a question could apply to several tables, pick the one whose columns best match the wording.",
    "",
    "Schema:",
  );
  for (const table of dataset.tables) {
    lines.push("", ...describeTable(table));
  }

  if (dataset.hints.length > 0) {
    lines.push("", "Relationship hints (heuristic, computed from the data):");
    for (const hint of dataset.hints) lines.push(describeHint(hint, dataset.tables));
  } else if (dataset.tables.length > 1) {
    lines.push("", "No relationship hints were detected; join only on columns with matching names and compatible types.");
  }
  return lines.join("\n");
}

/**
 * The system prompt plus a short trailer describing what else the model
 * receives per question. For display in the UI ("what the model sees").
 */
export function describeModelView(dataset: DatasetProfile): string {
  return (
    buildSystemPrompt(dataset) +
    "\n\n---\n" +
    "Per question, the model also receives your question text as the user message. " +
    "For the written answer, a second request sends the question, the SQL that ran, and up to 50 result rows."
  );
}
