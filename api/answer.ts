import {
  ANSWER_MAX_CELL_CHARS,
  ANSWER_MAX_COLUMNS,
  ANSWER_MAX_ROWS,
  type AnswerRequest,
  type AnswerResponse,
  type QueryError,
} from "../shared/types.js";
import { ProviderError } from "./_providers/types.js";
import { selectProvider } from "./_providers/select.js";
import { jsonResponse } from "./_providers/http.js";

const MAX_QUESTION_LENGTH = 2000;
const MAX_SQL_LENGTH = 20000;

/** Constant system prompt for the answer step. The opening sentence is fixed (the test harness keys on it). */
export function buildAnswerSystemPrompt(): string {
  return [
    "You are Quack Query's analyst. The user asked a question about their data. A SQL query was generated for that question and executed in DuckDB. You are now shown the question, the SQL, and the result, and your job is to answer the question from that result.",
    "",
    "Rules:",
    "- Answer the question directly in plain prose, 1 to 4 sentences. A short bulleted list is fine when the question asks for a list or a per-group breakdown of at most 8 items.",
    "- Ground every number in the result rows. Quote figures as they appear; you may round to 2 decimals and add thousands separators. Keep units and currency implicit unless the column name states them.",
    "- If the result is empty, say that no rows matched and what that means for the question.",
    "- If the result was truncated (more rows were produced than are shown), say the summary is based on the first N of M rows.",
    "- If the result has a single column named `error`, relay its text as the reason the question could not be answered.",
    "- Never invent data that is not in the result.",
    "- Do not restate the SQL.",
    "- No markdown headers and no code fences.",
    "- Do not mention being an AI.",
  ].join("\n");
}

function cell(value: string): string {
  return value.replace(/\r?\n|\r/g, " ");
}

/** User message: the question, the SQL, and the result as a compact pipe-delimited table. */
export function buildAnswerUserMessage(input: AnswerRequest): string {
  const truncated = input.rowCount > input.rows.length;
  const lines = [
    "Question:",
    input.question,
    "",
    "SQL that was executed:",
    input.sql,
    "",
    `Result (${input.rows.length} of ${input.rowCount} rows${truncated ? ", truncated" : ""}):`,
  ];
  if (input.rows.length === 0) {
    lines.push("(no rows)");
  } else {
    lines.push(input.columns.map(cell).join(" | "));
    for (const row of input.rows) lines.push(row.map(cell).join(" | "));
  }
  return lines.join("\n");
}

function validate(body: unknown): AnswerRequest | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "Request body must be a JSON object";
  const { question, sql, columns, rows, rowCount } = body as Partial<Record<keyof AnswerRequest, unknown>>;
  if (typeof question !== "string" || question.trim().length === 0) return "`question` must be a non-empty string";
  if (question.length > MAX_QUESTION_LENGTH) return `\`question\` must be at most ${MAX_QUESTION_LENGTH} characters`;
  if (typeof sql !== "string") return "`sql` must be a string";
  if (sql.length > MAX_SQL_LENGTH) return `\`sql\` must be at most ${MAX_SQL_LENGTH} characters`;
  if (!Array.isArray(columns) || !columns.every((c) => typeof c === "string")) return "`columns` must be an array of strings";
  if (columns.length > ANSWER_MAX_COLUMNS) return `\`columns\` must have at most ${ANSWER_MAX_COLUMNS} entries`;
  if (!Array.isArray(rows)) return "`rows` must be an array";
  if (rows.length > ANSWER_MAX_ROWS) return `\`rows\` must have at most ${ANSWER_MAX_ROWS} entries`;
  if (typeof rowCount !== "number" || !Number.isFinite(rowCount) || rowCount < 0) return "`rowCount` must be a number >= 0";

  const cleanRows: string[][] = [];
  for (const [i, row] of rows.entries()) {
    if (!Array.isArray(row) || !row.every((c) => typeof c === "string")) return `\`rows[${i}]\` must be an array of strings`;
    if (row.length > columns.length) return `\`rows[${i}]\` has more cells than \`columns\``;
    cleanRows.push((row as string[]).map((c) => c.slice(0, ANSWER_MAX_CELL_CHARS)));
  }
  return {
    question: question.trim(),
    sql,
    columns: (columns as string[]).map((c) => c.slice(0, ANSWER_MAX_CELL_CHARS)),
    rows: cleanRows,
    rowCount: Math.max(rowCount, cleanRows.length),
  };
}

function json(status: number, body: AnswerResponse | QueryError): Response {
  return jsonResponse(status, body);
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
    console.error(`[answer] ${selected}`);
    return json(500, { error: selected });
  }

  try {
    const result = await selected.provider({
      system: buildAnswerSystemPrompt(),
      question: buildAnswerUserMessage(input),
    });

    if (result.finishReason === "refusal") return json(422, { error: "The model declined this request" });
    // "length" is tolerated: a cut-off answer is still readable prose.
    const answer = result.text.trim();
    if (answer.length === 0) return json(502, { error: "The model returned an empty response" });
    return json(200, { answer });
  } catch (error) {
    if (error instanceof ProviderError) {
      console.error(`[answer] ${selected.name} provider error ${error.status}: ${error.message}`);
      return json(error.status, { error: error.message });
    }
    console.error(`[answer] ${selected.name} provider failed:`, error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return json(500, { error: `${selected.name} provider failed: ${message}` });
  }
}
