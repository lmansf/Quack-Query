import type { QueryError, QueryRequest, QueryResponse, TableProfile } from "../shared/types";
import { cleanSql, isReadOnlySql } from "../shared/sql";
import { ProviderError, type Provider } from "./providers/types";
import { anthropic } from "./providers/anthropic";
import { groq } from "./providers/groq";

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

/** Builds the (cached) system prompt describing the single table. */
export function buildSystemPrompt(profile: TableProfile): string {
  const lines: string[] = [];
  lines.push(
    "You are Quack Query, a SQL assistant. The user's data is loaded into a single DuckDB table in their browser.",
    "",
    "Output rule: respond with exactly ONE DuckDB SQL statement and nothing else — no prose, no explanation, no markdown fences, no trailing semicolon. If the question cannot be answered from this table, respond with SELECT '<short reason>' AS error so the response is still valid SQL.",
    "",
    "Query rules:",
    "- Read-only: SELECT or WITH ... SELECT only.",
    `- Reference the table exactly as "${profile.table}" (double-quoted).`,
    "- Double-quote every column identifier exactly as given in the schema.",
    "- Prefer DuckDB idioms (e.g. count(*), date_trunc, strftime, QUALIFY, list_aggregate).",
    "- Add LIMIT 100 unless the question asks for a specific count or an aggregate that naturally returns few rows.",
    "- When matching low-cardinality string values, use the exact values listed in the profile (case matters).",
    "- Give aggregate columns readable aliases.",
    "",
    `Table "${profile.table}" (${profile.rowCount.toLocaleString("en-US")} rows), loaded from ${profile.fileName}:`,
  );
  for (const col of profile.columns) {
    const distinct = col.distinctCount === -1 ? "distinct count unavailable" : `${col.distinctCount} distinct`;
    let line = `- "${col.name}" ${col.type} — ${distinct}, ${col.nullCount} null`;
    if (col.values !== undefined) {
      const values = col.values.map((v) => v.replace(/\r?\n/g, " ").trim()).filter((v) => v.length > 0);
      if (values.length > 0) line += ` — values: ${values.join(", ")}`;
    }
    lines.push(line);
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
  const { profile, question } = body as Partial<QueryRequest>;
  if (typeof question !== "string" || question.trim().length === 0) return "`question` must be a non-empty string";
  if (question.length > MAX_QUESTION_LENGTH) return `\`question\` must be at most ${MAX_QUESTION_LENGTH} characters`;
  if (typeof profile !== "object" || profile === null) return "`profile` must be an object";
  if (typeof profile.table !== "string" || profile.table.length === 0) return "`profile.table` must be a non-empty string";
  if (typeof profile.rowCount !== "number" || !Number.isFinite(profile.rowCount)) return "`profile.rowCount` must be a number";
  if (!Array.isArray(profile.columns) || profile.columns.length === 0) return "`profile.columns` must be a non-empty array";
  return { profile: { ...profile, fileName: typeof profile.fileName === "string" ? profile.fileName : "upload" }, question: question.trim() };
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
  if (typeof selected === "string") return json(500, { error: selected });

  const systemPrompt = buildSystemPrompt(input.profile);

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
    if (error instanceof ProviderError) return json(error.status, { error: error.message });
    const message = error instanceof Error ? error.message : "Unknown error";
    return json(500, { error: `${selected.name} provider failed: ${message}` });
  }
}
