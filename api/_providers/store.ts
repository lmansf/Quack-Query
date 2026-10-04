/**
 * A/B test telemetry store: Upstash Redis over its REST API, using global
 * fetch (no SDK). Configured by UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN,
 * or by the names the Vercel Marketplace integration sets, KV_REST_API_URL +
 * KV_REST_API_TOKEN. Without either pair nothing is stored and the results
 * page reports `configured: false`.
 *
 * Key layout (every key starts with `qq:`; {v} is the variant, {s} the response source):
 *
 * - `qq:agg:{v}:{s}`      hash of integer counters: responses, ok, latency_ms_sum,
 *                         answer_ms_sum + answer_n, attempts_sum + attempts_n,
 *                         predicted_k_sum + predicted_k_n, mapping_hit_milli_sum
 *                         (round(hit * 1000)) + mapping_hit_n, up, down, comments
 * - `qq:lat:{v}:{s}`      latency histogram: bucket upper bound in ms
 *                         (LATENCY_BUCKETS_MS, inclusive) or `inf` -> count
 * - `qq:outcome:{v}:{s}`  ResponseOutcome -> count
 * - `qq:events`           every counted event as JSON plus a server `at` ISO
 *                         timestamp, newest first, the last 20,000
 * - `qq:comments`         {variant, source, comment, at} JSON, newest first, the last 200
 * - `qq:voted:{responseId}`, `qq:commented:{responseId}`
 *                         30-day markers: a response counts at most one vote and
 *                         one comment; repeats are dropped (and not logged)
 */
import type {
  ResponseEvent,
  ResponseOutcome,
  ResponseSource,
  ResultsResponse,
  TelemetryEvent,
  Variant,
  VariantStats,
} from "../../shared/types.js";

// Records rather than arrays, so the compiler flags a union member missing here.
const VARIANT_KEYS: Record<Variant, true> = { A: true, B: true };
const SOURCE_KEYS: Record<ResponseSource, true> = { model: true, edited: true, history: true };
const OUTCOME_KEYS: Record<ResponseOutcome, true> = {
  ok: true,
  query_error: true,
  model_error: true,
  refused: true,
  api_error: true,
  mapping_error: true,
  cancelled: true,
};

/** Every Variant, ResponseSource and ResponseOutcome, in declaration order. */
export const VARIANTS: readonly Variant[] = Object.keys(VARIANT_KEYS) as Variant[];
export const RESPONSE_SOURCES: readonly ResponseSource[] = Object.keys(SOURCE_KEYS) as ResponseSource[];
export const RESPONSE_OUTCOMES: readonly ResponseOutcome[] = Object.keys(OUTCOME_KEYS) as ResponseOutcome[];

/** Latency histogram bucket upper bounds in ms (inclusive); slower responses count under `inf`. */
const LATENCY_BUCKETS_MS = [500, 1000, 2000, 3000, 5000, 8000, 13000, 21000, 34000, 55000] as const;
/** Median reported when it falls in the open-ended `inf` bucket. */
const INF_BUCKET_MEDIAN_MS = 89000;

const EVENTS_KEY = "qq:events";
const EVENTS_KEPT = 20_000;
const COMMENTS_KEY = "qq:comments";
const COMMENTS_KEPT = 200;
/** Comments returned by readResults. */
const COMMENTS_SHOWN = 50;
/** Lifetime of the one-vote / one-comment markers. */
const DEDUPE_TTL_SECONDS = 30 * 24 * 60 * 60;
/** A slow store must not hold a function (or a telemetry request) open for long. */
const TIMEOUT_MS = 5000;
/** z for a two-sided 95% interval. */
const Z95 = 1.959964;

type Command = (string | number)[];
type HashKind = "agg" | "lat" | "outcome";
const HASH_KINDS: readonly HashKind[] = ["agg", "lat", "outcome"];

function hashKey(kind: HashKind, variant: Variant, source: ResponseSource): string {
  return `qq:${kind}:${variant}:${source}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// REST transport
// ---------------------------------------------------------------------------

interface StoreConfig {
  url: string;
  token: string;
}

/** UPSTASH_* first, else the Marketplace KV_* names. Read per call: cheap, and no import-time state. */
function storeConfig(env: NodeJS.ProcessEnv = process.env): StoreConfig | null {
  const pairs = [
    [env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN],
    [env.KV_REST_API_URL, env.KV_REST_API_TOKEN],
  ];
  for (const [url, token] of pairs) {
    const base = url?.trim();
    const secret = token?.trim();
    if (base && secret) return { url: base.replace(/\/+$/, ""), token: secret };
  }
  return null;
}

/** True when a Redis REST URL and token are set. */
export function storeConfigured(): boolean {
  return storeConfig() !== null;
}

/** Upstash error bodies are `{"error": "..."}`; fall back to the start of the raw text. */
function restErrorMessage(raw: string): string {
  try {
    const json: unknown = JSON.parse(raw);
    if (isRecord(json) && typeof json.error === "string") return json.error;
  } catch {
    // not JSON; fall through
  }
  return raw.trim().slice(0, 200) || "(empty body)";
}

/**
 * Sends commands through the REST `/pipeline` endpoint (one round trip, not
 * atomic) and returns each command's result in order. Throws on an HTTP error,
 * a timeout, a malformed reply, or any command that failed.
 */
export async function pipeline(commands: (string | number)[][]): Promise<unknown[]> {
  const config = storeConfig();
  if (!config) throw new Error("No Redis store is configured");
  if (commands.length === 0) return [];

  const response = await fetch(`${config.url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands.map((command) => command.map(String))),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Redis REST API returned HTTP ${response.status}: ${restErrorMessage(raw)}`);

  let replies: unknown;
  try {
    replies = JSON.parse(raw);
  } catch {
    throw new Error("Redis REST API returned a non-JSON response");
  }
  if (!Array.isArray(replies) || replies.length !== commands.length) {
    throw new Error("Redis REST API returned an unexpected pipeline response");
  }
  return replies.map((reply: unknown, i) => {
    if (isRecord(reply) && reply.error !== undefined && reply.error !== null) {
      throw new Error(`Redis ${String(commands[i]?.[0])} failed: ${String(reply.error)}`);
    }
    if (!isRecord(reply) || !("result" in reply)) throw new Error("Redis REST API returned an unexpected pipeline reply");
    return reply.result;
  });
}

// ---------------------------------------------------------------------------
// Writing events
// ---------------------------------------------------------------------------

function latencyBucket(ms: number): string {
  for (const bound of LATENCY_BUCKETS_MS) if (ms <= bound) return String(bound);
  return "inf";
}

function responseCommands(event: ResponseEvent, agg: string): Command[] {
  const latencyMs = Math.round(event.latencyMs);
  const commands: Command[] = [
    ["HINCRBY", agg, "responses", 1],
    ["HINCRBY", agg, "latency_ms_sum", latencyMs],
    ["HINCRBY", hashKey("lat", event.variant, event.source), latencyBucket(latencyMs), 1],
    ["HINCRBY", hashKey("outcome", event.variant, event.source), event.outcome, 1],
  ];
  if (event.outcome === "ok") commands.push(["HINCRBY", agg, "ok", 1]);
  // Optional measurements: a sum plus a count of the responses that reported one.
  const measured: [sumField: string, countField: string, value: number | undefined][] = [
    ["answer_ms_sum", "answer_n", event.answerMs],
    ["attempts_sum", "attempts_n", event.attempts],
    ["predicted_k_sum", "predicted_k_n", event.predictedK],
    ["mapping_hit_milli_sum", "mapping_hit_n", event.mappingHit === undefined ? undefined : event.mappingHit * 1000],
  ];
  for (const [sumField, countField, value] of measured) {
    if (value === undefined) continue;
    // HINCRBY takes integers only.
    commands.push(["HINCRBY", agg, sumField, Math.round(value)], ["HINCRBY", agg, countField, 1]);
  }
  return commands;
}

function logCommands(event: TelemetryEvent, at: string): Command[] {
  return [
    ["LPUSH", EVENTS_KEY, JSON.stringify({ ...event, at })],
    ["LTRIM", EVENTS_KEY, 0, EVENTS_KEPT - 1],
  ];
}

/**
 * Records one validated event. Votes and comments first claim their
 * response's marker (SET NX) and are counted only when the claim succeeds.
 */
export async function recordEvent(event: TelemetryEvent): Promise<void> {
  const at = new Date().toISOString();
  const agg = hashKey("agg", event.variant, event.source);
  if (event.type === "response") {
    await pipeline([...responseCommands(event, agg), ...logCommands(event, at)]);
    return;
  }

  const marker = event.type === "feedback" ? `qq:voted:${event.responseId}` : `qq:commented:${event.responseId}`;
  const [claimed] = await pipeline([["SET", marker, 1, "NX", "EX", DEDUPE_TTL_SECONDS]]);
  if (claimed !== "OK") return;

  if (event.type === "feedback") {
    await pipeline([["HINCRBY", agg, event.rating, 1], ...logCommands(event, at)]);
    return;
  }
  const entry = { variant: event.variant, source: event.source, comment: event.comment, at };
  await pipeline([
    ["HINCRBY", agg, "comments", 1],
    ["LPUSH", COMMENTS_KEY, JSON.stringify(entry)],
    ["LTRIM", COMMENTS_KEY, 0, COMMENTS_KEPT - 1],
    ...logCommands(event, at),
  ]);
}

// ---------------------------------------------------------------------------
// Reading results
// ---------------------------------------------------------------------------

type Counts = Map<string, number>;
type Totals = Record<HashKind, Counts>;

function emptyTotals(): Totals {
  return { agg: new Map(), lat: new Map(), outcome: new Map() };
}

/** Adds an HGETALL reply into `into`. Over REST it is a flat [field, value, ...] array of strings. */
function addHash(into: Counts, reply: unknown): void {
  const add = (field: unknown, value: unknown) => {
    const n = Number(value);
    if (typeof field === "string" && Number.isFinite(n)) into.set(field, (into.get(field) ?? 0) + n);
  };
  if (Array.isArray(reply)) {
    for (let i = 0; i + 1 < reply.length; i += 2) add(reply[i], reply[i + 1]);
  } else if (isRecord(reply)) {
    for (const [field, value] of Object.entries(reply)) add(field, value);
  }
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** Wilson score interval (95%) for `successes` out of `n`. */
function wilsonInterval(successes: number, n: number): [number, number] | null {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = Z95 * Z95;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Upper bound of the first bucket where the cumulative count reaches half the total. */
function medianLatency(histogram: Counts): number | null {
  const buckets = [...LATENCY_BUCKETS_MS.map(String), "inf"];
  const total = buckets.reduce((sum, bucket) => sum + (histogram.get(bucket) ?? 0), 0);
  if (total <= 0) return null;
  let cumulative = 0;
  for (const bucket of buckets) {
    cumulative += histogram.get(bucket) ?? 0;
    if (cumulative >= total / 2) return bucket === "inf" ? INF_BUCKET_MEDIAN_MS : Number(bucket);
  }
  return INF_BUCKET_MEDIAN_MS;
}

function variantStats({ agg, lat, outcome }: Totals): VariantStats {
  const count = (field: string) => agg.get(field) ?? 0;
  const responses = count("responses");
  const ok = count("ok");
  const up = count("up");
  const down = count("down");
  const votes = up + down;
  // Every known outcome is listed (zero when unseen), then anything else the store holds.
  const outcomes = new Map<string, number>(RESPONSE_OUTCOMES.map((name) => [name, 0]));
  for (const [name, n] of outcome) outcomes.set(name, (outcomes.get(name) ?? 0) + n);
  return {
    responses,
    ok,
    up,
    down,
    comments: count("comments"),
    upRate: ratio(up, votes),
    upRateCi: wilsonInterval(up, votes),
    feedbackRate: ratio(votes, responses),
    okRate: ratio(ok, responses),
    medianLatencyMs: medianLatency(lat),
    meanAnswerMs: ratio(count("answer_ms_sum"), count("answer_n")),
    meanAttempts: ratio(count("attempts_sum"), count("attempts_n")),
    meanPredictedK: ratio(count("predicted_k_sum"), count("predicted_k_n")),
    meanMappingHit: ratio(count("mapping_hit_milli_sum") / 1000, count("mapping_hit_n")),
    outcomes: Object.fromEntries(outcomes),
  };
}

/** erf(x) by Abramowitz & Stegun 7.1.26 (absolute error below 1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/** Standard normal cumulative distribution function. */
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** B's up rate minus A's, with a two-sided pooled two-proportion z-test; null until both have a vote. */
function compareUpRates(a: VariantStats, b: VariantStats): ResultsResponse["upRateDiff"] {
  const nA = a.up + a.down;
  const nB = b.up + b.down;
  if (nA < 1 || nB < 1) return null;
  const diff = b.up / nB - a.up / nA;
  const pooled = (a.up + b.up) / (nA + nB);
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  // A zero standard error means every vote agrees (all up or all down): nothing to tell apart.
  const pValue = standardError > 0 ? 2 * (1 - normalCdf(Math.abs(diff) / standardError)) : 1;
  return { diff, pValue: Math.min(1, Math.max(0, pValue)) };
}

/** LRANGE reply of JSON strings; malformed entries are skipped. */
function parseComments(reply: unknown): ResultsResponse["comments"] {
  const comments: ResultsResponse["comments"] = [];
  if (!Array.isArray(reply)) return comments;
  for (const item of reply) {
    if (typeof item !== "string") continue;
    let value: unknown;
    try {
      value = JSON.parse(item);
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;
    const { variant, source, comment, at } = value;
    if (isOneOf(VARIANTS, variant) && isOneOf(RESPONSE_SOURCES, source) && typeof comment === "string" && typeof at === "string") {
      comments.push({ variant, source, comment, at });
    }
    if (comments.length >= COMMENTS_SHOWN) break;
  }
  return comments;
}

/**
 * Per-variant results. Scope "model" reads only source "model"; "all" sums
 * model, edited and history. Comments are always across all sources. One
 * pipeline; no network call at all when the store is not configured.
 */
export async function readResults(scope: "model" | "all"): Promise<ResultsResponse> {
  const generatedAt = new Date().toISOString();
  const totals: Record<Variant, Totals> = { A: emptyTotals(), B: emptyTotals() };
  if (!storeConfigured()) {
    return {
      configured: false,
      generatedAt,
      scope,
      variants: { A: variantStats(totals.A), B: variantStats(totals.B) },
      upRateDiff: null,
      comments: [],
    };
  }

  const sources: readonly ResponseSource[] = scope === "model" ? ["model"] : RESPONSE_SOURCES;
  const reads: { variant: Variant; kind: HashKind }[] = [];
  const commands: Command[] = [];
  for (const variant of VARIANTS) {
    for (const source of sources) {
      for (const kind of HASH_KINDS) {
        reads.push({ variant, kind });
        commands.push(["HGETALL", hashKey(kind, variant, source)]);
      }
    }
  }
  commands.push(["LRANGE", COMMENTS_KEY, 0, COMMENTS_SHOWN - 1]);

  const replies = await pipeline(commands);
  reads.forEach(({ variant, kind }, i) => addHash(totals[variant][kind], replies[i]));
  const variants: Record<Variant, VariantStats> = { A: variantStats(totals.A), B: variantStats(totals.B) };
  return {
    configured: true,
    generatedAt,
    scope,
    variants,
    upRateDiff: compareUpRates(variants.A, variants.B),
    comments: parseComments(replies[replies.length - 1]),
  };
}
