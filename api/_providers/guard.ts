/**
 * Request guard shared by the public functions. The endpoints are
 * unauthenticated by design (the app has no accounts), so this layer limits
 * how much a stranger can cost the operator:
 *
 * - Same-origin only. Browsers send `Sec-Fetch-Site` on every request; when it
 *   is present, only `same-origin` and `none` (a navigation the user started)
 *   pass, and `Origin` is not compared with `Host`. That matters for the A/B
 *   test: the middleware proxies variant B visitors' requests from the
 *   production domain to B's own deployment, so B's functions see `Host` = B's
 *   deployment while `Origin` = the production domain, and the browser has
 *   already vouched that the page and the API share an origin. Browsers that
 *   do not send `Sec-Fetch-Site` (Safari before 16.4) are checked by `Origin`
 *   instead: when present, its host must be the request's host or an
 *   allowlisted one: `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL` and
 *   `VERCEL_URL` (bare hostnames that Vercel sets) and `ALLOWED_ORIGINS`
 *   (comma-separated hostnames or full URLs). Tools like curl can forge these
 *   headers, which is why the rate limit below exists as well.
 * - JSON only: POST bodies must be `application/json`, a type that makes
 *   browsers preflight cross-site calls, which then fail (no CORS headers are
 *   ever sent).
 * - Body size cap: bounds the prompt (and therefore the cost) of one call.
 * - Rate limit: a request count per client IP per minute. Vercel functions
 *   keep memory per warm instance only, so this is best-effort, not a hard
 *   cap; pair it with a spend limit on the provider account.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { jsonResponse } from "./http.js";

/** Largest accepted request body in bytes. */
export const MAX_BODY_BYTES = 512 * 1024;

const WINDOW_MS = 60_000;
/**
 * Requests per client per minute (per warm function instance). Variant B makes
 * up to ~8 calls per question, so the default leaves room for a few questions a minute.
 */
const LIMIT_PER_WINDOW = Number(process.env.RATE_LIMIT_PER_MINUTE) || 60;

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

/**
 * The A/B middleware forwards B visitors' IPs signed with HMAC-SHA256
 * (`x-qq-client-ip` / `x-qq-client-sig`, keyed by VERCEL_AUTOMATION_BYPASS_SECRET
 * or QQ_PROXY_SECRET), because a rewrite to B's deployment may show B the proxy's
 * address instead. A valid signature makes that IP the rate-limit key; anything
 * else is ignored and the usual headers apply.
 */
function signedClientIp(request: Request): string | null {
  const ip = request.headers.get("x-qq-client-ip");
  const sig = request.headers.get("x-qq-client-sig");
  const key = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || process.env.QQ_PROXY_SECRET;
  if (!ip || !sig || !key || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const expected = createHmac("sha256", key).update(`qq-client-ip:${ip}`).digest();
  const given = Buffer.from(sig, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected) ? ip : null;
}

function clientKey(request: Request): string {
  const signed = signedClientIp(request);
  if (signed) return signed;
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

/** Lowercase `host[:port]` of an absolute URL, or null when it does not parse (e.g. `Origin: null`). */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The hosts the request was addressed to: the forwarded host (set by Vercel's edge) and `Host`. */
function requestHosts(request: Request): string[] {
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0];
  return [forwarded, request.headers.get("host")]
    .map((host) => host?.trim().toLowerCase())
    .filter((host): host is string => !!host);
}

/** Hosts accepted in `Origin` besides the request's own (see the comment at the top of this file). */
function allowlistedHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const entries = [
    env.VERCEL_PROJECT_PRODUCTION_URL,
    env.VERCEL_BRANCH_URL,
    env.VERCEL_URL,
    ...(env.ALLOWED_ORIGINS ?? "").split(","),
  ];
  const hosts = new Set<string>();
  for (const entry of entries) {
    const value = entry?.trim();
    if (!value) continue;
    const host = hostOf(value.includes("://") ? value : `https://${value}`);
    if (host) hosts.add(host);
  }
  return hosts;
}

/**
 * True for a browser request made on behalf of another site. With
 * `Sec-Fetch-Site`, only `same-origin` and `none` pass and `Origin` is not
 * compared with the host; without it, an `Origin` header (when present) must
 * name the request's host or an allowlisted one.
 */
function crossSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) {
    const value = site.trim().toLowerCase();
    return value !== "same-origin" && value !== "none";
  }
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  const host = hostOf(origin);
  if (host === null) return true;
  if (requestHosts(request).includes(host)) return false;
  return !allowlistedHosts().has(host);
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
