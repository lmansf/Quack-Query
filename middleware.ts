/**
 * Vercel Routing Middleware: A/B test on the production URL.
 *
 * Variant A is this deployment. Variant B is a preview deployment of the same
 * Vercel project (branch claude/variant-b-jev-loop). B visitors get an external
 * rewrite to B's deployment, so the address bar keeps the production URL while
 * pages, assets and /api/* functions all come from B.
 *
 * Active only when VERCEL_ENV is "production" and VARIANT_B_ORIGIN is an
 * https:// URL. Anywhere else (B's own preview, local dev) requests pass
 * through untouched, and any error fails open to variant A.
 *
 * Production environment variables:
 *   VARIANT_B_ORIGIN   B's deployment URL, e.g.
 *                      https://quack-query-git-claude-variant-b-jev-loop-<team>.vercel.app
 *   VARIANT_B_PERCENT  share of new visitors sent to B, 0..100 (default 50)
 *   VERCEL_AUTOMATION_BYPASS_SECRET
 *                      set by Vercel when "Protection Bypass for Automation" is
 *                      enabled, so B can stay behind Deployment Protection
 *
 * The qq_variant cookie keeps a visitor in one variant; ?variant=a or
 * ?variant=b pins a browser to a variant for testing.
 */
import { createHmac } from "node:crypto";
import { next, rewrite } from "@vercel/functions/middleware";

type Variant = "A" | "B";

const COOKIE = "qq_variant";
const COOKIE_ATTRIBUTES = "Path=/; Max-Age=31536000; SameSite=Lax; Secure; HttpOnly";
const BYPASS_HEADER = "x-vercel-protection-bypass";
/** Deployment Protection controls (header or query form) a visitor must not pass on to B. */
const BYPASS_CONTROLS = [BYPASS_HEADER, "x-vercel-set-bypass-cookie"];

export const config = {
  // Every path except Vercel's own endpoints (/_vercel/insights, /_vercel/speed-insights, ...).
  matcher: ["/((?!_vercel/).*)"],
  // Node.js runtime (Vercel has deprecated edge for middleware); node:crypto signs the client IP.
  runtime: "nodejs",
};

/**
 * Signed client-IP headers for B's rate limiter. A rewrite to another
 * deployment may present Vercel's proxy address to B instead of the visitor's,
 * which would put every B visitor in one rate-limit bucket. The middleware
 * therefore forwards the visitor's IP with an HMAC that B's guard verifies
 * (api/_providers/guard.ts); unsigned or forged values are ignored there.
 */
const CLIENT_IP_HEADER = "x-qq-client-ip";
const CLIENT_SIG_HEADER = "x-qq-client-sig";

export default function middleware(request: Request): Response {
  try {
    return route(request);
  } catch {
    return next(); // Fail open: variant A.
  }
}

function route(request: Request): Response {
  const origin = variantBOrigin();
  const url = new URL(request.url);
  // Off outside production, and if B's origin is this host (that would loop).
  if (process.env.VERCEL_ENV !== "production" || !origin || new URL(origin).host === url.host) {
    return next();
  }

  const pinned = asVariant(url.searchParams.get("variant")?.trim().toUpperCase());
  const current = cookieVariant(request.headers.get("cookie"));
  const variant = pinned ?? current ?? (Math.random() * 100 < percentB() ? "B" : "A");

  // Headers for the visitor's response: only the cookie, when assigning or pinning.
  const headers = new Headers();
  if (pinned || !current) headers.append("set-cookie", `${COOKIE}=${variant}; ${COOKIE_ATTRIBUTES}`);
  if (variant === "A") return next({ headers });

  // Same path and query on B's origin. The fields are set rather than resolving
  // the path against the origin, where "//evil.example/x" would name another
  // host and receive the bypass secret.
  const target = new URL(origin);
  target.pathname = url.pathname;
  target.search = url.search;
  for (const key of [...target.searchParams.keys()]) {
    if (BYPASS_CONTROLS.includes(key.toLowerCase())) target.searchParams.delete(key);
  }

  // Headers for the request to B: a rewrite replaces the incoming request
  // headers with this set, so start from a copy of them.
  const forwarded = new Headers(request.headers);
  // With the secret attached, a visitor's x-vercel-set-bypass-cookie would get
  // them a cookie that bypasses protection on every deployment of the project.
  for (const name of BYPASS_CONTROLS) forwarded.delete(name);
  // B sees its own host in host/x-forwarded-host, and its API guard compares
  // Origin with that host when a browser sends no Sec-Fetch-Site. A request
  // that is same-origin here is same-origin on B, so give it B's origin; a
  // cross-site Origin stays as is for B to reject.
  const siteHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  if (hostOf(forwarded.get("origin")) === siteHost.toLowerCase()) forwarded.set("origin", origin);
  // Keep B's pages identical to A's: no Vercel Toolbar injected on the preview.
  forwarded.set("x-vercel-skip-toolbar", "1");
  // Request header for B only; it never appears in the visitor's response.
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (secret) forwarded.set(BYPASS_HEADER, secret);
  // Visitor's IP for B's rate limiter, signed so B can trust it (never a visitor's own value).
  forwarded.delete(CLIENT_IP_HEADER);
  forwarded.delete(CLIENT_SIG_HEADER);
  const signingKey = secret || process.env.QQ_PROXY_SECRET;
  const ip = clientIp(request);
  if (signingKey && ip) {
    forwarded.set(CLIENT_IP_HEADER, ip);
    forwarded.set(CLIENT_SIG_HEADER, createHmac("sha256", signingKey).update(`qq-client-ip:${ip}`).digest("hex"));
  }

  return rewrite(target, { headers, request: { headers: forwarded } });
}

/** VARIANT_B_ORIGIN as "https://host[:port]", or null when unset, invalid or not https. */
function variantBOrigin(): string | null {
  try {
    const parsed = new URL(process.env.VARIANT_B_ORIGIN?.trim() ?? "");
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Percent of new visitors assigned to B: VARIANT_B_PERCENT clamped to 0..100, else 50. */
function percentB(): number {
  const raw = process.env.VARIANT_B_PERCENT?.trim();
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isNaN(value) ? 50 : Math.min(100, Math.max(0, value));
}

function asVariant(value: string | null | undefined): Variant | null {
  return value === "A" || value === "B" ? value : null;
}

/** The variant stored in the first qq_variant cookie, or null when absent or invalid. */
function cookieVariant(cookieHeader: string | null): Variant | null {
  for (const pair of (cookieHeader ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq !== -1 && pair.slice(0, eq).trim() === COOKIE) return asVariant(pair.slice(eq + 1).trim());
  }
  return null;
}

/** Host of an Origin header value, or null when absent or unparseable (e.g. "null"). */
function hostOf(value: string | null): string | null {
  try {
    return value ? new URL(value).host : null;
  } catch {
    return null;
  }
}

/** The visitor's IP as Vercel reports it to this (production) deployment. */
function clientIp(request: Request): string | null {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first ? first.slice(0, 64) : null;
}
