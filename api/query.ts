import type { DatasetProfile, QueryError, QueryRequest, QueryResponse, TableProfile } from "../shared/types.js";
import { cleanSql, isReadOnlySql } from "../shared/sql.js";
import { buildSystemPrompt } from "../shared/prompt.js";
import { ProviderError } from "./_providers/types.js";
import { DEFAULT_ANTHROPIC_MODEL } from "./_providers/anthropic.js";
import { DEFAULT_GROQ_MODEL, listGroqModels } from "./_providers/groq.js";
import { selectProvider } from "./_providers/select.js";
import { jsonResponse } from "./_providers/http.js";

// Re-exported so existing importers keep working after the moves to
// _providers/select.ts and shared/prompt.ts.
export { selectProvider, buildSystemPrompt };

const MAX_QUESTION_LENGTH = 2000;

function json(status: number, body: QueryResponse | QueryError | (QueryError & { sql: string })): Response {
  return jsonResponse(status, body);
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
  return jsonResponse(200, body);
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
