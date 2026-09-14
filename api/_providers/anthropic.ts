import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, type Provider } from "./types.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";

/** Anthropic provider: Claude with adaptive thinking and a cached system prompt. */
export const anthropic: Provider = async ({ system, question }) => {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new ProviderError(500, "ANTHROPIC_API_KEY is not set for this deployment (add it in the project's environment variables for this environment and redeploy)");
  }
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;

  try {
    // Created lazily (per request) so credential problems surface as JSON errors, not import-time crashes.
    const client = new Anthropic();
    // `fallbacks` is newer than the SDK's typings in v0.80.0, hence the narrow cast.
    const params = {
      model,
      max_tokens: 4096,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: question }],
    } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
    const response = await client.beta.messages.create(params);

    if (response.stop_reason === "refusal") {
      const { stop_details } = response as { stop_details?: { explanation?: string | null } | null };
      const explanation = stop_details?.explanation;
      throw new ProviderError(422, "The model declined this request" + (explanation ? ": " + explanation : ""));
    }

    const text = response.content
      .filter((block): block is Anthropic.Beta.Messages.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    return {
      text,
      finishReason: response.stop_reason === "max_tokens" ? "length" : "stop",
      model: response.model,
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof Anthropic.AuthenticationError) {
      throw new ProviderError(500, "Anthropic rejected the configured ANTHROPIC_API_KEY (HTTP 401). Check the key and redeploy after updating it");
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new ProviderError(429, "Rate limited by Anthropic; please retry shortly");
    }
    if (error instanceof Anthropic.APIError) {
      throw new ProviderError(502, `Anthropic error (${error.status ?? "unknown"}): ${error.message}`);
    }
    throw error;
  }
};
