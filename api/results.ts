/**
 * GET /api/results?scope=model|all — A/B test results for the results page.
 * Protected by the RESULTS_PASSWORD environment variable, which the page
 * sends in the `x-results-password` header.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { QueryError, ResultsResponse } from "../shared/types.js";
import { jsonResponse } from "./_providers/http.js";
import { guardRequest } from "./_providers/guard.js";
import { readResults } from "./_providers/store.js";

/** Pause before answering a missing or wrong password, to slow guessing. */
const WRONG_PASSWORD_DELAY_MS = 300;

function json(status: number, body: ResultsResponse | QueryError): Response {
  return jsonResponse(status, body);
}

/** Compares SHA-256 digests in constant time, so neither the password nor its length leaks through timing. */
function passwordMatches(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(given), digest(expected));
}

export async function GET(request: Request): Promise<Response> {
  if (request.method !== "GET") return json(405, { error: "Method not allowed" });
  const blocked = guardRequest(request);
  if (blocked) return blocked;

  // Trimmed because header values reach the function trimmed, so surrounding
  // whitespace (say, a pasted trailing newline) could never be matched.
  const expected = process.env.RESULTS_PASSWORD?.trim();
  if (!expected) return json(503, { error: "RESULTS_PASSWORD is not set for this deployment" });
  const given = request.headers.get("x-results-password");
  if (given === null || !passwordMatches(given, expected)) {
    await new Promise((resolve) => setTimeout(resolve, WRONG_PASSWORD_DELAY_MS));
    return json(401, { error: "Wrong password" });
  }

  const scope = new URL(request.url).searchParams.get("scope") || "model";
  if (scope !== "model" && scope !== "all") return json(400, { error: '`scope` must be "model" or "all"' });

  try {
    return json(200, await readResults(scope));
  } catch (error) {
    console.error("[results] could not read the store:", error);
    const message = error instanceof Error ? error.message : String(error);
    return json(502, { error: `Could not read results from the store: ${message}` });
  }
}
