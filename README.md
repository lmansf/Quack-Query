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

## A/B test

Two variants run side by side:

- **A** (this branch, the production branch): one SQL query per question, then the optional written answer.
- **B** (branch `claude/variant-b-jev-loop`): Jev first predicts how many columns the question needs and picks them one by one; the model then gets that mapping as a hint on top of the full schema and may run up to 5 queries, seeing each result (and how many queries remain) before choosing a final query. The written answer step is the same as A's.

Visitors to the production URL are split 50/50 by `middleware.ts`, which pins each browser with a `qq_variant` cookie and serves variant B's deployment on the same URL (pages, assets, and `/api/*`). Both variants record outcome metrics and thumbs up/down to the same store, and `/results` compares them.

### Setup checklist (Vercel dashboard)

1. **Storage.** Add Upstash for Redis from the Vercel Marketplace and connect it to this project for both Production and Preview. It injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`). Without it the app works but nothing is recorded.
2. **Results password.** Set `RESULTS_PASSWORD` (Production and Preview), then open `/results`.
3. **Variant B deployment.** Push the B branch, then copy its stable branch URL from the deployment page (it looks like `https://<project>-git-claude-variant-b-jev-loop-<team>.vercel.app`).
4. **Routing.** Set `VARIANT_B_ORIGIN` to that URL for **Production only**, and optionally `VARIANT_B_PERCENT` (default 50). Redeploy production. Leaving `VARIANT_B_ORIGIN` unset turns the split off (everyone gets A).
5. **Deployment Protection.** Preview URLs are protected by default. Either enable "Protection Bypass for Automation" (the middleware forwards `VERCEL_AUTOMATION_BYPASS_SECRET` automatically, so B stays private) or turn protection off for previews.
6. **Keys for B.** Make sure `GROQ_API_KEY` / `LLM_PROVIDER` have the Preview scope, and add `TYPESAFE_API_KEY` (Jev, from console.typesafe.ai) for Preview.
7. **Check it.** Visit the production URL with `?variant=a` and `?variant=b` to pin your own browser to each side, ask a question, vote, and confirm the counts move on `/results`. Use the results page's default "model responses" view for the comparison; edited re-runs and history replays are recorded but excluded unless you tick the box.

Results show thumbs-up rate with a 95% interval, feedback rate, success rate, median latency, and for B the queries used per question and how often Jev's predicted columns made it into the final SQL. The B − A difference comes with a two-proportion test p-value; treat anything above 0.05 as "not decided yet".

## Supported inputs

Drop or pick files, or paste cells straight from a spreadsheet. Everything table-shaped becomes a table:

- CSV / TSV / any delimited text (`.csv`, `.tsv`, `.txt`, and unknown extensions, which DuckDB sniffs), optionally gzipped (`.csv.gz`).
- Excel workbooks (`.xlsx`, `.xlsm`): each non-empty sheet becomes its own table, named `<file>_<sheet>` when a workbook has several. Dates and times are converted from Excel serials; the reader is built in (no library, no network). Legacy `.xls` and `.xlsb` must be saved as `.xlsx` or CSV first.
- Parquet (`.parquet`) and JSON (`.json`, `.jsonl`, `.ndjson`), optionally gzipped for JSON.
- Pasted rows (tab, comma, semicolon, or pipe separated, first row as header) via Ctrl/Cmd+V anywhere on the page or the "Paste data" panel; they become `pasted`, `pasted_2`, and so on.

## Security model

The functions are public and unauthenticated (the app has no accounts), so the design limits what a stranger or a malicious file can do:

- **Server request guard** (`api/_providers/guard.ts`): cross-site browser requests are rejected, bodies are capped at 512 KB, POSTs must be JSON, and a per-IP token bucket allows 60 requests per minute per warm function instance (`RATE_LIMIT_PER_MINUTE` to change; variant B makes up to about 8 calls per question). A request passes the same-origin check when the browser marks it `Sec-Fetch-Site: same-origin` (this is what lets the A/B middleware serve B's functions on the production domain), or, for clients that omit that header, when its `Origin` matches the request host, the project's Vercel hostnames (`VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL`, `VERCEL_URL`), or `ALLOWED_ORIGINS` (comma-separated). This is best effort: set a spend limit on your Groq, Anthropic, and TypeSafe accounts as the hard cap.
- **Input caps**: at most 25 tables, 400 columns per table, 25 listed values per column, 300 characters per string, and a 200,000-character prompt. The answer endpoint accepts at most 50 rows of 30 columns with 200-character cells.
- **DuckDB is locked down at startup** (`src/duck.ts`): file access is restricted to the virtual `uploads/` prefix where uploaded files and export buffers live, external access and extension loading are disabled, and the configuration is locked so no statement can undo it. A model-generated query that tries to read a URL or another file fails inside the engine before any network call. The Parquet and JSON extensions are loaded once before the lock (from `extensions.duckdb.org`); if that download fails, Parquet and JSON files report a clear error until the page is reloaded.
- **SQL is also checked in code, twice** (server and browser): a single read-only statement (`EXPLAIN` is excluded because `EXPLAIN ANALYZE` executes) with no data-changing or session keyword, and no URLs, file-reading functions (`read_*`, `*_scan`, `glob`), functions that run SQL text (`query()`), or extension, attach, copy, or settings keywords. The check reads the statement the way DuckDB's scanner does (comments, `'...'`, `E'...'` and `$$...$$` strings, quoted identifiers), so text inside a string can't hide a second statement, and keywords inside strings and quoted identifiers are ignored: a column named `import` or `read_at` still works.
- **Queries only ever run wrapped as a subquery** (`SELECT * FROM (...)`, also for row counts and exports), never as raw text, after a check that the statement closes every quote, comment and parenthesis it opens. DuckDB refuses DML and multiple statements inside a subquery, so even SQL that slipped past the check above fails to parse instead of running.
- **Runaway queries are stopped.** DuckDB Wasm is single-threaded, so a query cannot be interrupted; after 60 seconds (5 minutes for exports) the engine is restarted and the uploaded files are reloaded automatically.
- **Content Security Policy** (`vercel.json`): the page and its workers may only connect to the app's own origin and `extensions.duckdb.org`. Scripts are same-origin only with `'wasm-unsafe-eval'` for DuckDB, workers must be same-origin scripts, no inline styles, framing is denied, and `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `COOP`, `CORP`, and HSTS are set. Do not add `Cross-Origin-Embedder-Policy`: it would block the extension download.
- **Personal data is withheld from the profile.** Columns whose names suggest people, contact details, identifiers, or secrets, or whose values look like emails or phone numbers, are described to the model without their values. The answer step, which sends result rows, can be switched off with the checkbox under the question box.
- **No HTML from data**: every value, model output, and error is rendered with `textContent`; the chart is built with DOM APIs.
- **Nothing sensitive in the client bundle**: only `VITE_`-prefixed env vars are exposed by Vite and none are used; API keys live in the functions' environment. `.env` and `.vercel` are git-ignored.

Residual risks to be aware of before sharing: the rate limit is per function instance, so a determined caller with a script can still spend money (set provider spend limits, and consider Vercel's WAF rate limiting); the model can be steered by text inside a data file (prompt injection), which is why its SQL is validated and the engine is locked rather than trusting the model; the personal-data heuristic is a heuristic, so review the "What the model sees" panel for unusual column names; and the answer step, when enabled, sends up to 50 result rows to the model provider.

## Privacy

Your files are parsed and queried entirely in the browser with DuckDB Wasm and are never uploaded. What does leave the browser, and goes to the LLM provider you configured:

- **With every question:** the schema profile of each table: column names and types, row/distinct/null counts, min and max of numeric and date columns, relationship hints, and the full list of distinct values for columns with 20 or fewer distinct values. Columns that look personal (emails, phone numbers, people's names, addresses, identifiers, secrets) have their values withheld automatically and are marked "withheld" in the Tables panel; the "What the model sees" panel shows the exact text.
- **For the written answer:** the question, the SQL, and the first 50 rows of the query result (30 columns, 200 characters per cell at most). This is row data. Untick "Write a plain-language answer" under the question box to skip it.
- **To the app's own store (for the A/B comparison):** thumbs up/down, optional comments you type after a thumbs down, and outcome metrics per response: variant, timing, row count, error type, model name, and for variant B the number of queries and the predicted column names. Never your questions, SQL, or data values.
- **Nothing else.** Query history stays in your browser's localStorage.
