# Quack Query

Ask questions about a data file in plain English. The file never leaves your browser.

Upload one or more CSV, Parquet, or JSON files, type a question, and Quack Query has an LLM write a single read-only SQL query that DuckDB runs locally in your browser. Each file becomes a table, and queries may join across them.

## How it works

- **DuckDB Wasm in the browser.** Every file is loaded into its own table in one in-memory DuckDB instance running as WebAssembly. All parsing, profiling, and querying happens client-side.
- **Automatic profiles → system prompt.** After loading, the app profiles each table (column names, DuckDB types, distinct/null counts, min/max for numeric and date columns, a uniqueness flag, and the full value list for low-cardinality columns). All table profiles, plus your question, are what gets sent to the server.
- **Relationship hints.** With two or more tables, the app looks for join keys: columns that share a name across tables, and column pairs whose values actually overlap (measured with a DuckDB join on distinct values). Numeric and date pairs are only considered when a column name looks like a key (`id`, `customer_id`, `sku`, …) or references the other table, so quantities and prices are not mistaken for ids. The hints are shown in the UI and included in the prompt, with the strongest ones marked as likely join keys.
- **Serverless function returns SQL only.** `api/query.ts` sends the profiles, hints, and question to an LLM and returns one read-only SELECT statement, joins allowed. The browser checks it is read-only, runs it in DuckDB, and shows the query beside the results.
- **Answer step.** After the results render, the browser sends the question, the SQL, and the first 50 result rows to `api/answer.ts`, which asks the same LLM provider for a short plain-language answer grounded in those rows. It appears under the query output. Only the (truncated) result rows are sent, never the source files.
- **Editable SQL and history.** The generated SQL sits in an editor with Run (Ctrl/Cmd+Enter) and Copy. Every run is recorded in a History panel (question, SQL, row count or error), persisted in the browser's localStorage, and can be replayed without calling the model.
- **Safe previews.** Results are counted first and only the first 500 rows are fetched for display, so large results are never materialized in the browser. Results over 100,000 rows ask for confirmation before the preview runs. The exact row count is always shown.
- **Quick chart.** When a result has two columns and one is numeric, a Chart toggle draws a bar chart (or a line chart when the other column holds dates) as inline SVG with hover values.
- **Export.** Export CSV / Export Parquet write the full result of the current query through DuckDB's `COPY` and download it. Exports over 1,000,000 rows ask for confirmation.
- **What the model sees.** Each dataset shows a collapsible panel with the exact system prompt the model receives, built from the same shared code the server uses.

## LLM providers

The function supports two providers, selected with environment variables:

| Variable | Purpose |
| --- | --- |
| `LLM_PROVIDER` | `groq` or `anthropic`. Optional: defaults to Groq when `GROQ_API_KEY` is set, otherwise Anthropic. |
| `GROQ_API_KEY` | Groq API key. |
| `GROQ_MODEL` | Optional Groq model override (default `openai/gpt-oss-120b`). Groq retires models regularly; `GET /api/query?models=1` lists the IDs your key can currently use. |
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
