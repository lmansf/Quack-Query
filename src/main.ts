import "./style.css";
import {
  initDuckDB,
  loadFile,
  runQuery,
  formatValue,
  isReadOnlySql,
  type QueryResult,
} from "./duck";
import type {
  ColumnProfile,
  QueryError,
  QueryRequest,
  QueryResponse,
  TableProfile,
} from "../shared/types";

const ACCEPT = ".csv,.tsv,.txt,.parquet,.json,.jsonl,.ndjson";
const MAX_ROWS = 500;

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; title?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title !== undefined) node.title = props.title;
  for (const child of children) node.append(child);
  return node;
}

function clear(node: HTMLElement): void {
  node.replaceChildren();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------

interface Shell {
  dropzone: HTMLDivElement;
  fileInput: HTMLInputElement;
  profile: HTMLElement;
  form: HTMLFormElement;
  questionInput: HTMLInputElement;
  askButton: HTMLButtonElement;
  status: HTMLDivElement;
  sql: HTMLElement;
  results: HTMLElement;
  error: HTMLDivElement;
}

function renderShell(root: HTMLElement): Shell {
  const header = el(
    "header",
    {},
    el("h1", { text: "Quack Query" }),
    el("p", { text: "Ask questions about a file. It never leaves your browser." }),
  );

  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = ACCEPT;
  fileInput.hidden = true;

  const dropzone = el(
    "div",
    { className: "dropzone" },
    el("p", { text: "Drop a CSV, Parquet, or JSON file here" }),
    el("button", { text: "Choose file" }),
    fileInput,
  );
  dropzone.tabIndex = 0;

  const profile = el("section");
  profile.hidden = true;

  const questionInput = el("input");
  questionInput.type = "text";
  questionInput.placeholder = "e.g. Which 5 categories have the highest total sales?";
  questionInput.autocomplete = "off";
  questionInput.disabled = true;

  const askButton = el("button", { text: "Ask" });
  askButton.type = "submit";
  askButton.disabled = true;

  const form = el("form", { className: "question" }, questionInput, askButton);

  const status = el("div", { className: "status" });
  const sql = el("section");
  sql.hidden = true;
  const results = el("section");
  results.hidden = true;
  const error = el("div", { className: "error" });
  error.hidden = true;

  const footer = el(
    "footer",
    {},
    el("p", {
      text:
        "Files are processed locally with DuckDB Wasm. Only the schema profile " +
        "(column names, types, counts, and low-cardinality values) is sent to the model.",
    }),
  );

  root.replaceChildren(
    header,
    el("section", {}, dropzone),
    profile,
    el("section", {}, form, status),
    error,
    sql,
    results,
    footer,
  );

  return { dropzone, fileInput, profile, form, questionInput, askButton, status, sql, results, error };
}

// ---------------------------------------------------------------------------
// Rendering pieces
// ---------------------------------------------------------------------------

function renderProfile(container: HTMLElement, profile: TableProfile): void {
  const table = el("table");
  const thead = el("thead");
  thead.append(
    el(
      "tr",
      {},
      ...["Column", "Type", "Distinct", "Nulls", "Values"].map((h) => el("th", { text: h })),
    ),
  );
  const tbody = el("tbody");
  for (const col of profile.columns) tbody.append(profileRow(col));
  table.append(thead, tbody);

  container.replaceChildren(
    el(
      "div",
      { className: "card" },
      el("h2", { text: profile.fileName }),
      el("div", {
        className: "meta",
        text: `Table ${profile.table} · ${profile.rowCount.toLocaleString()} rows · ${profile.columns.length} columns`,
      }),
      el("div", { className: "table-wrap" }, table),
    ),
  );
  container.hidden = false;
}

function profileRow(col: ColumnProfile): HTMLTableRowElement {
  const distinct = col.distinctCount === -1 ? "—" : col.distinctCount.toLocaleString();
  const valuesText = col.values ? col.values.join(", ") : "";
  const valuesCell = el("td", { className: "values", text: valuesText });
  if (valuesText) valuesCell.title = valuesText;
  return el(
    "tr",
    {},
    el("td", { text: col.name }),
    el("td", { text: col.type }),
    el("td", { className: "num", text: distinct }),
    el("td", { className: "num", text: col.nullCount.toLocaleString() }),
    valuesCell,
  );
}

function renderSql(container: HTMLElement, sql: string): void {
  const pre = el("pre", { className: "sql", text: sql });
  const copy = el("button", { className: "secondary", text: "Copy SQL" });
  copy.type = "button";
  copy.addEventListener("click", () => {
    void navigator.clipboard
      .writeText(sql)
      .then(() => {
        copy.textContent = "Copied";
        setTimeout(() => {
          copy.textContent = "Copy SQL";
        }, 1500);
      })
      .catch(() => {
        copy.textContent = "Copy failed";
      });
  });
  container.replaceChildren(el("div", { className: "sql-block" }, pre, copy));
  container.hidden = false;
}

function renderResults(container: HTMLElement, result: QueryResult): void {
  const table = el("table");
  const captionText = result.truncated
    ? `${result.rowCount.toLocaleString()} rows (showing first ${result.rows.length.toLocaleString()})`
    : `${result.rowCount.toLocaleString()} ${result.rowCount === 1 ? "row" : "rows"}`;
  table.append(el("caption", { text: captionText }));

  const thead = el("thead");
  thead.append(el("tr", {}, ...result.columns.map((c) => el("th", { text: c }))));
  const tbody = el("tbody");
  for (const row of result.rows) {
    tbody.append(el("tr", {}, ...row.map((v) => el("td", { text: formatValue(v) }))));
  }
  table.append(thead, tbody);

  container.replaceChildren(el("div", { className: "card" }, el("div", { className: "table-wrap" }, table)));
  container.hidden = false;
}

function showError(box: HTMLDivElement, message: string): void {
  box.textContent = message;
  box.hidden = false;
}

function hideError(box: HTMLDivElement): void {
  box.textContent = "";
  box.hidden = true;
}

/** The model signals "can't answer" by returning a single `error` column. */
function modelErrorFrom(result: QueryResult): string | null {
  if (result.columns.length !== 1 || result.columns[0]?.toLowerCase() !== "error") return null;
  const first = result.rows[0]?.[0];
  return first === undefined ? "The model could not answer this question." : formatValue(first);
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

async function askClaude(profile: TableProfile, question: string): Promise<string> {
  const body: QueryRequest = { profile, question };
  const res = await fetch("/api/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let message = `Request failed (${res.status}${res.statusText ? " " + res.statusText : ""})`;
    const text = await res.text().catch(() => "");
    try {
      const data = JSON.parse(text) as Partial<QueryError>;
      if (typeof data.error === "string" && data.error) message = data.error;
    } catch {
      // Not JSON (e.g. a platform error page); show a trimmed excerpt so the cause is visible.
      const excerpt = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
      if (excerpt) message += `: ${excerpt}`;
    }
    throw new Error(message);
  }

  const data = (await res.json()) as Partial<QueryResponse>;
  if (typeof data.sql !== "string" || !data.sql.trim()) {
    throw new Error("The server returned no SQL.");
  }
  return data.sql.trim();
}

// ---------------------------------------------------------------------------
// App state + flow
// ---------------------------------------------------------------------------

function main(): void {
  const root = document.getElementById("app");
  if (!root) throw new Error("Missing #app root element");
  const ui = renderShell(root);

  let profile: TableProfile | null = null;
  let dbReady = false;
  let busy = false;

  const setStatus = (text: string): void => {
    ui.status.textContent = text;
  };

  const updateFormState = (): void => {
    const enabled = dbReady && profile !== null && !busy;
    ui.questionInput.disabled = !enabled;
    ui.askButton.disabled = !enabled;
  };

  const resetOutput = (): void => {
    hideError(ui.error);
    clear(ui.sql);
    ui.sql.hidden = true;
    clear(ui.results);
    ui.results.hidden = true;
  };

  const handleFile = async (file: File): Promise<void> => {
    if (!dbReady || busy) return;
    busy = true;
    updateFormState();
    resetOutput();
    ui.profile.hidden = true;
    clear(ui.profile);
    profile = null;
    setStatus(`Loading ${file.name}…`);
    try {
      profile = await loadFile(file);
      renderProfile(ui.profile, profile);
      setStatus(`Loaded ${file.name}. Ask a question below.`);
      ui.questionInput.focus();
    } catch (err) {
      setStatus("");
      showError(ui.error, `Could not load ${file.name}: ${errorMessage(err)}`);
    } finally {
      busy = false;
      updateFormState();
    }
  };

  const handleQuestion = async (question: string): Promise<void> => {
    if (!profile || busy) return;
    busy = true;
    updateFormState();
    resetOutput();

    let sql: string;
    try {
      setStatus("Asking Claude…");
      sql = await askClaude(profile, question);
    } catch (err) {
      setStatus("");
      showError(ui.error, errorMessage(err));
      busy = false;
      updateFormState();
      return;
    }

    if (!isReadOnlySql(sql)) {
      setStatus("");
      renderSql(ui.sql, sql);
      showError(ui.error, "The generated SQL is not a read-only SELECT statement, so it was not run.");
      busy = false;
      updateFormState();
      return;
    }

    renderSql(ui.sql, sql);
    try {
      setStatus("Running query…");
      const result = await runQuery(sql, MAX_ROWS);
      const modelError = modelErrorFrom(result);
      if (modelError !== null) {
        setStatus("");
        showError(ui.error, modelError);
      } else {
        renderResults(ui.results, result);
        setStatus("Done.");
      }
    } catch (err) {
      setStatus("");
      showError(ui.error, `Query failed: ${errorMessage(err)}`);
    } finally {
      busy = false;
      updateFormState();
    }
  };

  // --- wiring ---------------------------------------------------------------

  ui.dropzone.addEventListener("click", () => ui.fileInput.click());
  ui.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      ui.fileInput.click();
    }
  });
  ui.fileInput.addEventListener("click", (e) => e.stopPropagation());
  ui.fileInput.addEventListener("change", () => {
    const file = ui.fileInput.files?.[0];
    if (file) void handleFile(file);
    ui.fileInput.value = "";
  });

  ui.dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    ui.dropzone.classList.add("dragover");
  });
  ui.dropzone.addEventListener("dragleave", () => ui.dropzone.classList.remove("dragover"));
  ui.dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    ui.dropzone.classList.remove("dragover");
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  });

  ui.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const question = ui.questionInput.value.trim();
    if (question) void handleQuestion(question);
  });

  // --- boot -----------------------------------------------------------------

  setStatus("Starting DuckDB…");
  initDuckDB()
    .then(() => {
      dbReady = true;
      setStatus("Ready. Upload a CSV, Parquet, or JSON file.");
    })
    .catch((err: unknown) => {
      setStatus("");
      showError(ui.error, `DuckDB failed to start: ${errorMessage(err)}`);
    })
    .finally(updateFormState);
}

main();
