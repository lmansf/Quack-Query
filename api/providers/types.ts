/**
 * Minimal provider contract for "system prompt + one question -> text".
 * Each provider lives in its own file and reads its own env vars.
 */

export interface ProviderInput {
  system: string;
  question: string;
}

export interface ProviderResult {
  /** Raw model text (the SQL, hopefully). */
  text: string;
  /** Why generation stopped. "length" means the output was cut off. */
  finishReason: "stop" | "length" | "refusal" | "other";
  /** Model that actually served the request, for logging. */
  model: string;
}

/** Thrown by providers for failures that map cleanly to an HTTP status. */
export class ProviderError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export type Provider = (input: ProviderInput) => Promise<ProviderResult>;
