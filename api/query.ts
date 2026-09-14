import type {
  ColumnProfile,
  DatasetProfile,
  QueryError,
  QueryRequest,
  QueryResponse,
  RelationshipHint,
  TableProfile,
} from "../shared/types.js";
import { cleanSql, isReadOnlySql } from "../shared/sql.js";
import { ProviderError, type Provider } from "./_providers/types.js";
import { anthropic, DEFAULT_ANTHROPIC_MODEL } from "./_providers/anthropic.js";
import { groq, DEFAULT_GROQ_MODEL, listGroqModels } from "./_providers/groq.js";

const MAX_QUESTION_LENGTH = 2000;

const PROVIDERS: Record<string, Provider> = { anthropic, groq };

/**
 * Picks the LLM provider. `LLM_PROVIDER` wins when set; otherwise use whichever
 * provider has an API key configured (Groq first, then Anthropic).
 */
export function selectProvider(env: NodeJS.ProcessEnv = process.env): { name: string; provider: Provider } | string {
  const requested = env.LLM_PROVIDER?.trim().toLowerCase();
  if (requested) {
    const provider = PROVIDERS[requested];
    if (!provider) return `Unknown LLM_PROVIDER "${requested}". Supported: ${Object.keys(PROVIDERS).join(", ")}`;
    return { name: requested, provider };
  }
  if (env.GROQ_API_KEY) return { name: "groq", provider: groq };
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return { name: "anthropic", provider: anthropic };
  return "No LLM provider configured. Set GROQ_API_KEY or ANTHROPIC_API_KEY (and optionally LLM_PROVIDER).";
}

/** Overlap fraction at or above which a hint (with a unique side) is called a likely join key. */
const LIKELY_JOIN_OVERLAP = 0.9;

function describeColumn(col: ColumnProfile): string {
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

function describeTable(profile: TableProfile): string[] {
  return [
    `Table "${profile.table}" (${profile.rowCount.toLocaleString("en-US")} rows), loaded from ${profile.fileName}:`,
    ...profile.columns.map(describeColumn),
  ];
}

function findColumn(tables: TableProfile[], table: string, column: string): ColumnProfile | undefined {
  return tables.find((t) => t.table === table)?.columns.find((c) => c.name === column);
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function describeHint(hint: RelationshipHint, tables: TableProfile[]): string {
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

function json(status: number, body: QueryResponse | QueryError | (QueryError & { sql: string })): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validate(body: unknown): QueryRequest | string {
  if (typeof body !== "object" || body === null) return "Request body must be a JSON object";
  const { dataset, question } = body as { dataset?: Partial<DatasetProfile>; question?: unknown };
  if (typeof question !== "string" || question.trim().length === 0) return "`question` must be a non-empty string";
  if (question.length > MAX_QUESTION_LENGTH) return `\`question\` must be at most ${MAX_QUESTION_LENGTH} characters`;
  if (typeof dataset !== "object" || dataset === null) return "`dataset` must be an object";
  if (!Array.isArray(dataset.tables) || dataset.tables.length === 0) return "`dataset.tables` must be a non-empty array";
  if (dataset.hints !== undefined && !Array.isArray(dataset.hints)) return "`dataset.hints` must be an array";

  const tables: TableProfile[] = [];
  for (const [i, table] of (dataset.tables as Partial<TableProfile>[]).entries()) {
    const at = `\`dataset.tables[${i}]\``;
    if (typeof table !== "object" || table === null) return `${at} must be an object`;
    if (typeof table.table !== "string" || table.table.length === 0) return `${at}.table must be a non-empty string`;
    if (typeof table.rowCount !== "number" || !Number.isFinite(table.rowCount)) return `${at}.rowCount must be a number`;
    if (!Array.isArray(table.columns) || table.columns.length === 0) return `${at}.columns must be a non-empty array`;
    tables.push({
      ...table,
      table: table.table,
      rowCount: table.rowCount,
      columns: table.columns,
      fileName: typeof table.fileName === "string" ? table.fileName : "upload",
    });
  }
  return { dataset: { tables, hints: dataset.hints ?? [] }, question: question.trim() };
}

/**
 * GET /api/query — configuration check. Reports which provider and model the
 * deployment would use without calling the model. Useful on Vercel to confirm
 * environment variables reached the function.
 */
export async function GET(request: Request): Promise<Response> {
  const selected = selectProvider();
  if (typeof selected === "string") return json(500, { error: selected });

  const body: Record<string, unknown> = { ok: true, provider: selected.name, model: modelFor(selected.name) };
  if (new URL(request.url).searchParams.has("models")) {
    // Ask the provider which models this key can use. Only Groq supports it here.
    if (selected.name !== "groq") return json(400, { error: "Model listing is only available for the groq provider" });
    try {
      body.models = await listGroqModels();
    } catch (error) {
      if (error instanceof ProviderError) return json(error.status, { error: error.message });
      throw error;
    }
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function modelFor(provider: string): string {
  if (provider === "groq") return process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
  return process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
}

export async function POST(request: Request): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return json(400, { error: "Request body must be valid JSON" });
  }
  const input = validate(parsed);
  if (typeof input === "string") return json(400, { error: input });

  const selected = selectProvider();
  if (typeof selected === "string") {
    console.error(`[query] ${selected}`);
    return json(500, { error: selected });
  }

  const systemPrompt = buildSystemPrompt(input.dataset);

  try {
    const result = await selected.provider({ system: systemPrompt, question: input.question });

    if (result.finishReason === "refusal") return json(422, { error: "The model declined this request" });
    if (result.finishReason === "length") {
      return json(502, { error: "The model's response was cut off before it finished the query" });
    }

    const sql = cleanSql(result.text);
    if (sql.length === 0) return json(502, { error: "The model returned an empty response" });
    if (!isReadOnlySql(sql)) return json(422, { error: "Model did not return a read-only query", sql });
    return json(200, { sql });
  } catch (error) {
    if (error instanceof ProviderError) {
      console.error(`[query] ${selected.name} provider error ${error.status}: ${error.message}`);
      return json(error.status, { error: error.message });
    }
    console.error(`[query] ${selected.name} provider failed:`, error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return json(500, { error: `${selected.name} provider failed: ${message}` });
  }
}
