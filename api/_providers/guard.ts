/**
 * Request guard shared by the public functions. The endpoints are
 * unauthenticated by design (the app has no accounts), so this layer limits
 * how much a stranger can cost the operator:
 *
 * - Same-origin only: browsers send `Origin` on cross-site fetches, and
 *   `Sec-Fetch-Site` on every fetch. A request from another website is
 *   rejected before any model call. Tools like curl can forge headers, which
 *   is why the rate limit below exists as well.
 * - Body size cap: bounds the prompt (and therefore the cost) of one call.
 * - Rate limit: a small token bucket per client IP. Vercel functions keep
 *   memory per warm instance only, so this is best-effort, not a hard cap;
 *   pair it with a spend limit on the provider account.
 */
import { jsonResponse } from "./http.js";

/** Largest accepted request body in bytes. */
export const MAX_BODY_BYTES = 512 * 1024;

const WINDOW_MS = 60_000;
/** Requests per client per minute (per warm function instance). */
const LIMIT_PER_WINDOW = Number(process.env.RATE_LIMIT_PER_MINUTE) || 20;

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip") || "unknown";
}

/** Returns the seconds to wait when the client is over its budget, else 0. */
function rateLimited(key: string, now = Date.now()): number {
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (buckets.size > 10_000) {
    // Keep memory bounded on long-lived instances.
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  return bucket.count > LIMIT_PER_WINDOW ? Math.ceil((bucket.resetAt - now) / 1000) : 0;
}

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Rejects cross-site browser requests. Same-origin fetches carry either no
 * `Origin` (older browsers) or one that matches the request host, and a
 * `Sec-Fetch-Site` of `same-origin` (or `none` for direct navigations).
 */
function crossSite(request: Request): boolean {
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").toLowerCase();
  const origin = hostOf(request.headers.get("origin"));
  if (origin && host && origin !== host) return true;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  return false;
}

/**
 * Runs the checks that apply before a body is parsed. Returns a Response to
 * send immediately, or null when the request may proceed.
 */
export function guardRequest(request: Request): Response | null {
  if (crossSite(request)) return jsonResponse(403, { error: "Cross-site requests are not allowed" });

  // A JSON content type forces browsers to preflight cross-site calls, which then fail
  // (no CORS headers are ever sent), so other sites cannot spend quota via "simple" requests.
  if (request.method === "POST") {
    const type = (request.headers.get("content-type") ?? "").toLowerCase();
    if (!type.startsWith("application/json")) {
      return jsonResponse(415, { error: "Content-Type must be application/json" });
    }
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return jsonResponse(413, { error: `Request body must be at most ${MAX_BODY_BYTES} bytes` });
  }

  const wait = rateLimited(clientKey(request));
  if (wait > 0) {
    return new Response(JSON.stringify({ error: "Too many requests; please slow down" }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": String(wait) },
    });
  }
  return null;
}

/**
 * Reads and parses a JSON body while enforcing the size cap even when
 * `Content-Length` is absent or wrong. Returns the parsed value, or a
 * Response describing the problem.
 */
export async function readJsonBody(request: Request): Promise<unknown | Response> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return jsonResponse(413, { error: `Request body must be at most ${MAX_BODY_BYTES} bytes` });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return jsonResponse(400, { error: "Request body must be valid JSON" });
  }
}
