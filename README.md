# Quack Query

Ask questions about a data file in plain English. The file never leaves your browser.

Upload a CSV, Parquet, or JSON file, type a question, and Quack Query has Claude write a single read-only SQL query that DuckDB runs locally in your browser.

## How it works

- **DuckDB Wasm in the browser.** The file is loaded into an in-memory DuckDB instance running as WebAssembly. All parsing and querying happens client-side.
- **Automatic profile → system prompt.** After loading, the app computes a compact profile of the table (column names, DuckDB types, distinct/null counts, and the full value list for low-cardinality columns). That profile, plus your question, is all that is sent to the server.
- **Serverless function returns SQL only.** `api/query.ts` sends the profile and question to an LLM and returns one read-only SELECT statement. The browser checks it is read-only, runs it in DuckDB, and shows the result table.

## LLM providers

The function supports two providers, selected with environment variables:

| Variable | Purpose |
| --- | --- |
| `LLM_PROVIDER` | `groq` or `anthropic`. Optional: defaults to Groq when `GROQ_API_KEY` is set, otherwise Anthropic. |
| `GROQ_API_KEY` | Groq API key. |
| `GROQ_MODEL` | Optional Groq model override (default `llama-3.3-70b-versatile`). |
| `ANTHROPIC_API_KEY` | Anthropic API key. |
| `ANTHROPIC_MODEL` | Optional Anthropic model override (default `claude-opus-5`). |

Providers live in `api/_providers/` (the underscore keeps Vercel from deploying them as separate functions); adding another OpenAI-compatible host is a copy of `groq.ts` with a different base URL.

Note for editing `api/`: the package is an ES module, and Vercel runs the compiled function natively with Node, so relative imports there must carry a `.js` extension (for example `import { x } from "../shared/sql.js"`). Without it the function crashes at load time with `FUNCTION_INVOCATION_FAILED`. You can reproduce Vercel's build locally with `npx vercel build` and inspect `.vercel/output/functions/api/query.func`.

## Local development

```sh
cp .env.example .env   # then put your API key in .env
npm install
npm run dev
```

A small Vite plugin in `vite.config.ts` serves `api/*.ts` at `/api/*` during `npm run dev`, so no Vercel CLI is required.

## Deploy

Deploy to [Vercel](https://vercel.com). It auto-detects the Vite app and the `api/` directory as serverless functions. In the project settings, add `GROQ_API_KEY` (and `LLM_PROVIDER=groq`), or `ANTHROPIC_API_KEY` for Anthropic.

## Supported formats

CSV / TSV / delimited text (`.csv`, `.tsv`, `.txt`), Parquet (`.parquet`), and JSON (`.json`, `.jsonl`, `.ndjson`).

## Privacy

Your data is processed entirely in the browser with DuckDB Wasm. Only the schema profile — column names, types, counts, and the values of low-cardinality columns — is sent to the model. Row data is never uploaded.
