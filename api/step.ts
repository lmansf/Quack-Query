/**
 * POST /api/step (variant B): one turn of the iterative query loop. The
 * browser runs each query the model asks for and reports the result in the
 * next turn (the data never leaves the browser); the model may run up to
 * LOOP_MAX_QUERIES queries and ends with a final one. The body is a
 * StepRequest; the response is a StepResponse.
 */
import {
  LOOP_CELL_CHARS,
  LOOP_ERROR_CHARS,
  LOOP_MAX_COLUMNS,
  LOOP_MAX_QUERIES,
  LOOP_SAMPLE_ROWS,
  MAPPING_MAX_COLUMNS,
  type DatasetProfile,
  type LoopAttempt,
  type MappingResponse,
  type PredictedColumn,
  type QueryError,
  type StepRequest,
  type StepResponse,
} from "../shared/types.js";
import { cleanSql, externalReference, isReadOnlySql } from "../shared/sql.js";
import { buildLoopSystemPrompt, buildLoopUserMessage, hideDataNames, loopErrorText, parseStepReply } from "../shared/loop.js";
import { ProviderError, type ProviderResult } from "./_providers/types.js";
import { MAX_PROMPT_CHARS, MAX_STRING, finiteNumber, isRecord, validateQueryLike } from "./_providers/dataset.js";
import { selectProvider } from "./_providers/select.js";
import { jsonResponse } from "./_providers/http.js";
import { guardRequest, readJsonBody } from "./_providers/guard.js";

const MAX_SQL_LENGTH = 20_000;
const MAX_MODEL_LENGTH = 100;
const RETRY_NUDGE = "Your previous reply was not a JSON object of the required form. Reply with only the JSON object.";

function json(status: number, body: StepResponse | QueryError): Response {
  return jsonResponse(status, body);
}

function stringList(v: unknown, maxItems: number): string[] | null {
  if (!Array.isArray(v) || v.length > maxItems) return null;
  return v.every((x): x is string => typeof x === "string" && x.length <= MAX_STRING) ? v : null;
}

function validateMapping(v: unknown): MappingResponse | string {
  if (!isRecord(v)) return "`mapping` must be an object";
  const { k, expectedCount, countProbabilities, columns, model, calls } = v;
  if (!finiteNumber(k) || !Number.isInteger(k) || k < 1 || k > MAPPING_MAX_COLUMNS) {
    return `\`mapping.k\` must be an integer from 1 to ${MAPPING_MAX_COLUMNS}`;
  }
  if (!finiteNumber(expectedCount)) return "`mapping.expectedCount` must be a number";
  if (!Array.isArray(countProbabilities) || countProbabilities.length > MAPPING_MAX_COLUMNS || !countProbabilities.every(finiteNumber)) {
    return `\`mapping.countProbabilities\` must be an array of at most ${MAPPING_MAX_COLUMNS} numbers`;
  }
  if (!Array.isArray(columns) || columns.length > MAPPING_MAX_COLUMNS) {
    return `\`mapping.columns\` must be an array of at most ${MAPPING_MAX_COLUMNS} entries`;
  }
  const cleanColumns: PredictedColumn[] = [];
  for (const [i, col] of columns.entries()) {
    const at = `\`mapping.columns[${i}]\``;
    if (!isRecord(col)) return `${at} must be an object`;
    const { table, column, probability } = col;
    if (typeof table !== "string" || table.length > MAX_STRING || typeof column !== "string" || column.length > MAX_STRING) {
      return `${at} must have .table and .column strings of at most ${MAX_STRING} characters`;
    }
    if (!finiteNumber(probability) || probability < 0 || probability > 1) return `${at}.probability must be a number from 0 to 1`;
    cleanColumns.push({ table, column, probability });
  }
  if (typeof model !== "string" || model.length > MAX_MODEL_LENGTH) {
    return `\`mapping.model\` must be a string of at most ${MAX_MODEL_LENGTH} characters`;
  }
  if (!finiteNumber(calls) || calls < 0) return "`mapping.calls` must be a number >= 0";
  return { k, expectedCount, countProbabilities, columns: cleanColumns, model, calls };
}

/**
 * Rebuilds one attempt from untrusted input; cells are capped and errors clipped. In
 * shape-only mode rows are dropped, and error values and data-derived column names are
 * masked again here (the browser already does both), so no value reaches the model.
 */
function validateAttempt(v: unknown, at: string, shapeOnly: boolean, dataset: DatasetProfile): LoopAttempt | string {
  if (!isRecord(v)) return `${at} must be an object`;
  const { sql, outcome } = v;
  if (typeof sql !== "string" || sql.length > MAX_SQL_LENGTH) return `${at}.sql must be a string of at most ${MAX_SQL_LENGTH} characters`;
  if (outcome !== "ok" && outcome !== "error" && outcome !== "refused") return `${at}.outcome must be "ok", "error", or "refused"`;
  const attempt: LoopAttempt = { sql, outcome };
  const present = (value: unknown): boolean => value !== undefined && value !== null;

  if (present(v.columns)) {
    const columns = stringList(v.columns, LOOP_MAX_COLUMNS);
    if (!columns) return `${at}.columns must be an array of at most ${LOOP_MAX_COLUMNS} strings of at most ${MAX_STRING} characters`;
    attempt.columns = shapeOnly ? hideDataNames(columns, sql, dataset) : columns;
  }
  if (present(v.types)) {
    const types = stringList(v.types, LOOP_MAX_COLUMNS);
    if (!types) return `${at}.types must be an array of at most ${LOOP_MAX_COLUMNS} strings of at most ${MAX_STRING} characters`;
    attempt.types = types;
  }
  if (present(v.rowCount)) {
    if (!finiteNumber(v.rowCount) || v.rowCount < 0) return `${at}.rowCount must be a number >= 0`;
    attempt.rowCount = v.rowCount;
  }
  if (present(v.rows)) {
    if (!Array.isArray(v.rows) || v.rows.length > LOOP_SAMPLE_ROWS) return `${at}.rows must be an array of at most ${LOOP_SAMPLE_ROWS} rows`;
    const rows: string[][] = [];
    for (const [i, row] of v.rows.entries()) {
      if (!Array.isArray(row) || row.length > LOOP_MAX_COLUMNS || !row.every((c): c is string => typeof c === "string")) {
        return `${at}.rows[${i}] must be an array of at most ${LOOP_MAX_COLUMNS} strings`;
      }
      rows.push(row.map((c) => c.slice(0, LOOP_CELL_CHARS)));
    }
    if (!shapeOnly) attempt.rows = rows;
  }
  if (present(v.error)) {
    if (typeof v.error !== "string") return `${at}.error must be a string`;
    // Refusal reasons come from the checks, not from the data.
    attempt.error = outcome === "error" ? loopErrorText(v.error, shapeOnly) : v.error.slice(0, LOOP_ERROR_CHARS);
  }
  return attempt;
}

function validate(body: unknown): StepRequest | string {
  const base = validateQueryLike(body);
  if (typeof base === "string") return base;
  if (!isRecord(body)) return "Request body must be a JSON object";
  const { mapping, attempts, remaining, shapeOnly } = body;
  if (typeof shapeOnly !== "boolean") return "`shapeOnly` must be a boolean";
  const cleanMapping = validateMapping(mapping);
  if (typeof cleanMapping === "string") return cleanMapping;
  if (!Array.isArray(attempts) || attempts.length > LOOP_MAX_QUERIES) {
    return `\`attempts\` must be an array of at most ${LOOP_MAX_QUERIES} entries`;
  }
  const cleanAttempts: LoopAttempt[] = [];
  for (const [i, attempt] of attempts.entries()) {
    const parsed = validateAttempt(attempt, `\`attempts[${i}]\``, shapeOnly, base.dataset);
    if (typeof parsed === "string") return parsed;
    cleanAttempts.push(parsed);
  }
  const expected = LOOP_MAX_QUERIES - cleanAttempts.length;
  if (remaining !== expected) {
    return `\`remaining\` must be ${expected} (${LOOP_MAX_QUERIES} minus the number of attempts)`;
  }
  return { ...base, mapping: cleanMapping, attempts: cleanAttempts, remaining: expected, shapeOnly };
}

/**
 * The parsed reply, or null when it is unusable: unparseable, or cut off by the
 * token limit (its SQL may be truncated). Refusals are handled by the caller.
 */
function usableReply(result: ProviderResult, remaining: number): ReturnType<typeof parseStepReply> {
  if (result.finishReason === "length") return null;
  return parseStepReply(result.text, remaining);
}

/** Why the server will not let the browser run this SQL, or null when it passes the checks. */
function refusalReason(sql: string): string | null {
  if (!isReadOnlySql(sql)) return "the query is not a single read-only statement";
  const external = externalReference(sql);
  return external === null ? null : `the query references ${external}, which is not allowed`;
}

export async function POST(request: Request): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  const blocked = guardRequest(request);
  if (blocked) return blocked;

  const parsed = await readJsonBody(request);
  if (parsed instanceof Response) return parsed;
  const input = validate(parsed);
  if (typeof input === "string") return json(400, { error: input });

  const selected = selectProvider();
  if (typeof selected === "string") {
    console.error(`[step] ${selected}`);
    return json(500, { error: selected });
  }

  const system = buildLoopSystemPrompt(input.dataset);
  if (system.length > MAX_PROMPT_CHARS) {
    return json(413, { error: "The schema profile is too large for one request; remove some tables and try again" });
  }
  const question = buildLoopUserMessage(input);
  if (question.length > MAX_PROMPT_CHARS) {
    return json(413, { error: "The query results sent with this step are too large for one request" });
  }

  try {
    let result = await selected.provider({ system, question });
    if (result.finishReason === "refusal") return json(422, { error: "The model declined this request" });
    let reply = usableReply(result, input.remaining);
    if (reply === null) {
      // One retry with a reminder of the reply format.
      result = await selected.provider({ system, question: `${question}\n\n${RETRY_NUDGE}` });
      if (result.finishReason === "refusal") return json(422, { error: "The model declined this request" });
      reply = usableReply(result, input.remaining);
    }
    if (reply === null) {
      if (result.finishReason === "length") {
        return json(502, { error: "The model's response was cut off before it finished the query" });
      }
      // Only the length is logged: the reply may quote values from the user's data.
      console.error(`[step] ${selected.name} reply was not a usable JSON object (${result.text.length} characters)`);
      return json(502, { error: "The model did not reply with a query in the required JSON form" });
    }

    const sql = cleanSql(reply.sql);
    if (sql.length === 0) return json(502, { error: "The model returned an empty query" });
    const body: StepResponse = { action: reply.action, sql, model: result.model };
    const refused = refusalReason(sql);
    if (refused !== null) body.refused = refused;
    return json(200, body);
  } catch (error) {
    if (error instanceof ProviderError) {
      console.error(`[step] ${selected.name} provider error ${error.status}: ${error.message}`);
      return json(error.status, { error: error.message });
    }
    console.error(`[step] ${selected.name} provider failed:`, error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return json(500, { error: `${selected.name} provider failed: ${message}` });
  }
}
