/**
 * POST /api/mapping (variant B): Jev predicts how many columns the SQL for the
 * question needs and which ones. The body is a MappingRequest (same shape as
 * QueryRequest); the response is a MappingResponse.
 */
import type { MappingResponse, QueryError } from "../shared/types.js";
import { ProviderError } from "./_providers/types.js";
import { validateQueryLike } from "./_providers/dataset.js";
import { predictMapping } from "./_providers/jev.js";
import { jsonResponse } from "./_providers/http.js";
import { guardRequest, readJsonBody } from "./_providers/guard.js";

function json(status: number, body: MappingResponse | QueryError): Response {
  return jsonResponse(status, body);
}

export async function POST(request: Request): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  const blocked = guardRequest(request);
  if (blocked) return blocked;

  const parsed = await readJsonBody(request);
  if (parsed instanceof Response) return parsed;
  const input = validateQueryLike(parsed);
  if (typeof input === "string") return json(400, { error: input });

  try {
    return json(200, await predictMapping(input.dataset, input.question));
  } catch (error) {
    if (error instanceof ProviderError) {
      console.error(`[mapping] Jev error ${error.status}: ${error.message}`);
      return json(error.status, { error: error.message });
    }
    console.error("[mapping] Jev failed:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return json(500, { error: `Jev failed: ${message}` });
  }
}
