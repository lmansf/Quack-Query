# Quack Query

Ask questions about a data file in plain English. The file never leaves your browser.

Upload a CSV, Parquet, or JSON file, type a question, and Quack Query has Claude write a single read-only SQL query that DuckDB runs locally in your browser.

## How it works

- **DuckDB Wasm in the browser.** The file is loaded into an in-memory DuckDB instance running as WebAssembly. All parsing and querying happens client-side.
- **Automatic profile → system prompt.** After loading, the app computes a compact profile of the table (column names, DuckDB types, distinct/null counts, and the full value list for low-cardinality columns). That profile, plus your question, is all that is sent to the server.
- **Serverless function returns SQL only.** `api/query.ts` calls the Claude API with the profile as context and returns one read-only SELECT statement. The browser checks it is read-only, runs it in DuckDB, and shows the result table.

## Local development

```sh
cp .env.example .env   # then put your Anthropic API key in .env
npm install
npm run dev
```

A small Vite plugin in `vite.config.ts` serves `api/*.ts` at `/api/*` during `npm run dev`, so no Vercel CLI is required.

## Deploy

Deploy to [Vercel](https://vercel.com). It auto-detects the Vite app and the `api/` directory as serverless functions. Set the `ANTHROPIC_API_KEY` environment variable in the project settings.

## Supported formats

CSV / TSV / delimited text (`.csv`, `.tsv`, `.txt`), Parquet (`.parquet`), and JSON (`.json`, `.jsonl`, `.ndjson`).

## Privacy

Your data is processed entirely in the browser with DuckDB Wasm. Only the schema profile — column names, types, counts, and the values of low-cardinality columns — is sent to the model. Row data is never uploaded.
