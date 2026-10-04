import type { QueryError, QueryResponse } from "../shared/types.js";
import { cleanSql, externalReference, isReadOnlySql } from "../shared/sql.js";
import { buildSystemPrompt } from "../shared/prompt.js";
import { ProviderError } from "./_providers/types.js";
import { DEFAULT_ANTHROPIC_MODEL } from "./_providers/anthropic.js";
import { DEFAULT_GROQ_MODEL, listGroqModels } from "./_providers/groq.js";
import { MAX_PROMPT_CHARS, validateQueryLike } from "./_providers/dataset.js";
import { selectProvider } from "./_providers/select.js";
import { jsonResponse } from "./_providers/http.js";
import { guardRequest, readJsonBody } from "./_providers/guard.js";

// Re-exported so existing importers keep working after the moves to
// _providers/select.ts and shared/prompt.ts.
export { selectProvider, buildSystemPrompt };

function json(status: number, body: QueryResponse | QueryError | (QueryError & { sql: string })): Response {
  return jsonResponse(status, body);
}

/**
 * GET /api/query — configuration check. Reports which provider and model the
 * deployment would use without calling the model. Useful on Vercel to confirm
 * environment variables reached the function.
 */
export async function GET(request: Request): Promise<Response> {
  const blocked = guardRequest(request);
  if (blocked) return blocked;
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
  const blocked = guardRequest(request);
  if (blocked) return blocked;

  const parsed = await readJsonBody(request);
  if (parsed instanceof Response) return parsed;
  const input = validateQueryLike(parsed);
  if (typeof input === "string") return json(400, { error: input });

  const selected = selectProvider();
  if (typeof selected === "string") {
    console.error(`[query] ${selected}`);
    return json(500, { error: selected });
  }

  const systemPrompt = buildSystemPrompt(input.dataset);
  if (systemPrompt.length > MAX_PROMPT_CHARS) {
    return json(413, { error: "The schema profile is too large for one request; remove some tables and try again" });
  }

  try {
    const result = await selected.provider({ system: systemPrompt, question: input.question });

    if (result.finishReason === "refusal") return json(422, { error: "The model declined this request" });
    if (result.finishReason === "length") {
      return json(502, { error: "The model's response was cut off before it finished the query" });
    }

    const sql = cleanSql(result.text);
    if (sql.length === 0) return json(502, { error: "The model returned an empty response" });
    if (!isReadOnlySql(sql)) return json(422, { error: "Model did not return a read-only query", sql });
    const external = externalReference(sql);
    if (external !== null) return json(422, { error: `Model returned a query that references ${external}; refused`, sql });
    return json(200, { sql, model: result.model });
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
