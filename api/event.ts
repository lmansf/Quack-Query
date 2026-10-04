/**
 * POST /api/event — A/B test telemetry: one event per response, plus thumbs
 * up/down feedback and optional comments (TelemetryEvent in shared/types.ts).
 * Every valid event is answered 204 with no body, even when the store is
 * missing or failing: telemetry must never break the app.
 */
import {
  EVENT_ID_PATTERN,
  MAX_COMMENT_CHARS,
  MAX_PREDICTED_COLUMNS,
  type CommentEvent,
  type FeedbackEvent,
  type QueryError,
  type ResponseEvent,
  type TelemetryEvent,
} from "../shared/types.js";
import { jsonResponse } from "./_providers/http.js";
import { guardRequest, readJsonBody } from "./_providers/guard.js";
import { RESPONSE_OUTCOMES, RESPONSE_SOURCES, VARIANTS, recordEvent, storeConfigured } from "./_providers/store.js";

type Body = Record<string, unknown>;

interface Range {
  min: number;
  max: number;
  integer?: boolean;
}

const DURATION_MS: Range = { min: 0, max: 3_600_000 };
const MAPPING_MS: Range = { min: 0, max: 600_000 };
const ROW_COUNT: Range = { min: 0, max: 1e12, integer: true };
const TABLES: Range = { min: 0, max: 100, integer: true };
const ATTEMPTS: Range = { min: 0, max: 10, integer: true };
const PREDICTED_K: Range = { min: 0, max: 64, integer: true };
const SHARE: Range = { min: 0, max: 1 };
const MAX_MODEL_CHARS = 100;
const MAX_COLUMN_CHARS = 200;
const EVENT_TYPES = ["response", "feedback", "comment"] as const;
const RATINGS = ["up", "down"] as const;

let warnedUnconfigured = false;

function json(status: number, body: QueryError): Response {
  return jsonResponse(status, body);
}

/** Thrown by the field readers below and turned into a 400 by validateEvent. */
class InvalidEvent extends Error {}

function invalid(message: string): never {
  throw new InvalidEvent(message);
}

function oneOf<T extends string>(body: Body, key: string, values: readonly T[]): T {
  const value = body[key];
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    invalid(`\`${key}\` must be one of ${values.map((v) => JSON.stringify(v)).join(", ")}`);
  }
  return value as T;
}

function eventId(body: Body, key: "id" | "responseId"): string {
  const value = body[key];
  if (typeof value !== "string" || !EVENT_ID_PATTERN.test(value)) invalid(`\`${key}\` must match ${EVENT_ID_PATTERN}`);
  return value;
}

function numberField(body: Body, key: string, range: Range): number {
  const value = body[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < range.min ||
    value > range.max ||
    (range.integer === true && !Number.isInteger(value))
  ) {
    invalid(`\`${key}\` must be ${range.integer ? "an integer" : "a number"} from ${range.min} to ${range.max}`);
  }
  return value;
}

function booleanField(body: Body, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") invalid(`\`${key}\` must be true or false`);
  return value;
}

function modelField(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length > MAX_MODEL_CHARS) {
    invalid(`\`${key}\` must be a string of at most ${MAX_MODEL_CHARS} characters`);
  }
  return value;
}

function columnsField(body: Body, key: string): string[] {
  const value = body[key];
  if (
    !Array.isArray(value) ||
    value.length > MAX_PREDICTED_COLUMNS ||
    !value.every((column) => typeof column === "string" && column.length <= MAX_COLUMN_CHARS)
  ) {
    invalid(`\`${key}\` must be an array of at most ${MAX_PREDICTED_COLUMNS} strings of at most ${MAX_COLUMN_CHARS} characters`);
  }
  return [...(value as string[])];
}

function commentField(body: Body): string {
  const value = body.comment;
  const text = typeof value === "string" ? value.trim() : "";
  // Counted in code points, so an emoji is one character.
  const length = [...text].length;
  if (length < 1 || length > MAX_COMMENT_CHARS) {
    invalid(`\`comment\` must be a string of 1-${MAX_COMMENT_CHARS} characters (after trimming whitespace)`);
  }
  return text;
}

/** Optional fields may be omitted or null; either way they are left out of the event. */
function optional<T>(body: Body, key: string, read: (body: Body, key: string) => T): T | undefined {
  const value = body[key];
  return value === undefined || value === null ? undefined : read(body, key);
}

function optionalNumber(body: Body, key: string, range: Range): number | undefined {
  return optional(body, key, (b, k) => numberField(b, k, range));
}

// Each builder creates a fresh object with only the contract's keys, so
// anything else the client sent is dropped.

function responseEvent(body: Body): ResponseEvent {
  return {
    type: "response",
    id: eventId(body, "id"),
    variant: oneOf(body, "variant", VARIANTS),
    source: oneOf(body, "source", RESPONSE_SOURCES),
    outcome: oneOf(body, "outcome", RESPONSE_OUTCOMES),
    latencyMs: numberField(body, "latencyMs", DURATION_MS),
    rowCount: optionalNumber(body, "rowCount", ROW_COUNT),
    model: optional(body, "model", modelField),
    answerStep: booleanField(body, "answerStep"),
    answerMs: optionalNumber(body, "answerMs", DURATION_MS),
    tables: numberField(body, "tables", TABLES),
    attempts: optionalNumber(body, "attempts", ATTEMPTS),
    finalWasNew: optional(body, "finalWasNew", booleanField),
    predictedK: optionalNumber(body, "predictedK", PREDICTED_K),
    predictedColumns: optional(body, "predictedColumns", columnsField),
    mappingHit: optionalNumber(body, "mappingHit", SHARE),
    mappingMs: optionalNumber(body, "mappingMs", MAPPING_MS),
  };
}

function feedbackEvent(body: Body): FeedbackEvent {
  return {
    type: "feedback",
    responseId: eventId(body, "responseId"),
    variant: oneOf(body, "variant", VARIANTS),
    source: oneOf(body, "source", RESPONSE_SOURCES),
    rating: oneOf(body, "rating", RATINGS),
  };
}

function commentEvent(body: Body): CommentEvent {
  return {
    type: "comment",
    responseId: eventId(body, "responseId"),
    variant: oneOf(body, "variant", VARIANTS),
    source: oneOf(body, "source", RESPONSE_SOURCES),
    comment: commentField(body),
  };
}

/** The validated event, or a message saying what is wrong with it. */
function validateEvent(body: unknown): TelemetryEvent | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "Request body must be a JSON object";
  const fields = body as Body;
  try {
    switch (oneOf(fields, "type", EVENT_TYPES)) {
      case "response":
        return responseEvent(fields);
      case "feedback":
        return feedbackEvent(fields);
      case "comment":
        return commentEvent(fields);
    }
  } catch (error) {
    if (error instanceof InvalidEvent) return error.message;
    throw error;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  const blocked = guardRequest(request);
  if (blocked) return blocked;

  const parsed = await readJsonBody(request);
  if (parsed instanceof Response) return parsed;
  const event = validateEvent(parsed);
  if (typeof event === "string") return json(400, { error: event });

  if (!storeConfigured()) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        "[event] No Redis store configured (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or KV_REST_API_URL + KV_REST_API_TOKEN); telemetry events are dropped",
      );
    }
    return new Response(null, { status: 204 });
  }
  try {
    await recordEvent(event);
  } catch (error) {
    console.error(`[event] could not record a ${event.type} event:`, error);
  }
  return new Response(null, { status: 204 });
}
