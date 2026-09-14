/**
 * Groq provider (OpenAI-compatible chat completions API), using global fetch.
 * Env: GROQ_API_KEY (required), GROQ_MODEL, GROQ_BASE_URL.
 */
import { ProviderError, type Provider, type ProviderResult } from "./types";

export const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const MISSING_KEY = "Server is missing a valid GROQ_API_KEY";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Extract `error.message` from a Groq/OpenAI error body, else the trimmed raw text. */
function errorMessage(raw: string): string {
  try {
    const json: unknown = JSON.parse(raw);
    if (isRecord(json) && isRecord(json.error) && typeof json.error.message === "string") {
      return json.error.message;
    }
  } catch {
    // not JSON; fall through
  }
  return raw.trim().slice(0, 300);
}

/** Content may be a string or an array of `{type:"text", text}` parts. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function mapFinishReason(reason: unknown): ProviderResult["finishReason"] {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

export const groq: Provider = async (input) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new ProviderError(500, MISSING_KEY);

  const model = process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
  const baseUrl = (process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/+$/, "");

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.question },
        ],
        temperature: 0,
        max_tokens: 2048,
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ProviderError(502, `Could not reach Groq: ${message}`);
  }

  const raw = await res.text();

  if (!res.ok) {
    const message = errorMessage(raw);
    const { status } = res;
    if (status === 401 || status === 403) throw new ProviderError(500, MISSING_KEY);
    if (status === 429) throw new ProviderError(429, "Rate limited by Groq; please retry shortly");
    if ([400, 404, 413, 422].includes(status)) {
      throw new ProviderError(502, `Groq rejected the request (${status}): ${message}`);
    }
    throw new ProviderError(502, `Groq error (${status}): ${message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ProviderError(502, "Groq returned a non-JSON response");
  }

  const choices = isRecord(json) ? json.choices : undefined;
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
  if (!isRecord(choice)) throw new ProviderError(502, "Groq returned no choices");

  const message = isRecord(choice.message) ? choice.message : undefined;
  return {
    text: contentToText(message?.content),
    finishReason: mapFinishReason(choice.finish_reason),
    model: isRecord(json) && typeof json.model === "string" ? json.model : model,
  };
};
