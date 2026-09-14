/**
 * Provider selection shared by every API function.
 */
import type { Provider } from "./types.js";
import { anthropic } from "./anthropic.js";
import { groq } from "./groq.js";

const PROVIDERS: Record<string, Provider> = { anthropic, groq };

/**
 * Picks the LLM provider. `LLM_PROVIDER` wins when set; otherwise use whichever
 * provider has an API key configured (Groq first, then Anthropic).
 */
export function selectProvider(env: NodeJS.ProcessEnv = process.env): { name: string; provider: Provider } | string {
  const requested = env.LLM_PROVIDER?.trim().toLowerCase();
  if (requested) {
    const provider = PROVIDERS[requested];
    if (!provider) return `Unknown LLM_PROVIDER "${requested}". Supported: ${Object.keys(PROVIDERS).join(", ")}`;
    return { name: requested, provider };
  }
  if (env.GROQ_API_KEY) return { name: "groq", provider: groq };
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return { name: "anthropic", provider: anthropic };
  return "No LLM provider configured. Set GROQ_API_KEY or ANTHROPIC_API_KEY (and optionally LLM_PROVIDER).";
}
