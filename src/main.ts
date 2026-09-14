import "./style.css";
import {
  initDuckDB,
  addFile,
  removeTable,
  buildDataset,
  runQuery,
  formatValue,
  isReadOnlySql,
  type QueryResult,
} from "./duck";
import type {
  ColumnProfile,
  DatasetProfile,
  QueryError,
  QueryRequest,
  QueryResponse,
  RelationshipHint,
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
  tables: HTMLElement;
  relationships: HTMLElement;
  form: HTMLFormElement;
  questionInput: HTMLInputElement;
  askButton: HTMLButtonElement;
  status: HTMLDivElement;
  error: HTMLDivElement;
  output: HTMLElement;
  sql: HTMLDivElement;
  results: HTMLDivElement;
}

function renderShell(root: HTMLElement): Shell {
  const header = el(
    "header",
    {},
    el("h1", { text: "Quack Query" }),
    el("p", { text: "Ask questions about your files. They never leave your browser." }),
  );

  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = ACCEPT;
  fileInput.multiple = true;
  fileInput.hidden = true;

  const dropzone = el(
    "div",
    { className: "dropzone" },
    el("p", { text: "Drop CSV, Parquet, or JSON files here. Each file becomes a table." }),
    el("button", { text: "Choose files" }),
    fileInput,
  );
  dropzone.tabIndex = 0;

  const tables = el("section", { className: "tables" });
  tables.hidden = true;

  const relationships = el("section", { className: "relationships" });
  relationships.hidden = true;

  const questionInput = el("input");
  questionInput.type = "text";
  questionInput.placeholder = "e.g. Total revenue by customer region, joining orders to customers";
  questionInput.autocomplete = "off";
  questionInput.disabled = true;

  const askButton = el("button", { text: "Ask" });
  askButton.type = "submit";
  askButton.disabled = true;

  const form = el("form", { className: "question" }, questionInput, askButton);

  const status = el("div", { className: "status" });
  const error = el("div", { className: "error" });
  error.hidden = true;

  const sql = el("div", { className: "output-sql" });
  const results = el("div", { className: "output-results" });
  const output = el("section", { className: "output" }, sql, results);
  output.hidden = true;

  const footer = el(
    "footer",
    {},
    el("p", {
      text:
        "Files are processed locally with DuckDB Wasm. Only the schema profiles " +
        "(column names, types, counts, ranges, low-cardinality values, and relationship hints) " +
        "are sent to the model.",
    }),
  );

  root.replaceChildren(
    header,
    el("section", {}, dropzone),
    tables,
    relationships,
    el("section", {}, form, status),
    error,
    output,
    footer,
  );

  return {
    dropzone,
    fileInput,
    tables,
    relationships,
    form,
    questionInput,
    askButton,
    status,
    error,
    output,
    sql,
    results,
  };
}

// ---------------------------------------------------------------------------
// Rendering pieces
// ---------------------------------------------------------------------------

function renderTables(
  container: HTMLElement,
  tables: TableProfile[],
  onRemove: (table: string) => void,
): void {
  clear(container);
  if (tables.length === 0) {
    container.hidden = true;
    return;
  }
  container.append(el("h2", { text: "Tables" }));
  for (const profile of tables) container.append(tableCard(profile, onRemove));
  container.hidden = false;
}

function tableCard(profile: TableProfile, onRemove: (table: string) => void): HTMLDivElement {
  const table = el("table");
  const thead = el("thead");
  thead.append(
    el(
      "tr",
      {},
      ...["Column", "Type", "Distinct", "Nulls", "Range", "Values"].map((h) => el("th", { text: h })),
    ),
  );
  const tbody = el("tbody");
  for (const col of profile.columns) tbody.append(profileRow(col));
  table.append(thead, tbody);

  const remove = el("button", { className: "secondary", text: "Remove" });
  remove.type = "button";
  remove.addEventListener("click", () => onRemove(profile.table));

  return el(
    "div",
    { className: "card" },
    el(
      "div",
      { className: "card-header" },
      el(
        "div",
        {},
        el("h3", { text: profile.fileName }),
        el("div", {
          className: "meta",
          text: `Table ${profile.table} · ${profile.rowCount.toLocaleString()} rows · ${profile.columns.length} columns`,
        }),
      ),
      remove,
    ),
    el("div", { className: "table-wrap" }, table),
  );
}

function profileRow(col: ColumnProfile): HTMLTableRowElement {
  const distinct = col.distinctCount === -1 ? "—" : col.distinctCount.toLocaleString();
  const range = col.min !== undefined && col.max !== undefined ? `${col.min} – ${col.max}` : "";
  const valuesText = col.values ? col.values.join(", ") : "";
  const valuesCell = el("td", { className: "values", text: valuesText });
  if (valuesText) valuesCell.title = valuesText;

  const nameCell = el("td", { text: col.name });
  if (col.unique) {
    nameCell.append(" ", el("span", { className: "badge", text: "key", title: "All values are distinct and non-null" }));
  }

  const rangeCell = el("td", { className: "range", text: range });
  if (range) rangeCell.title = range;

  return el(
    "tr",
    {},
    nameCell,
    el("td", { text: col.type }),
    el("td", { className: "num", text: distinct }),
    el("td", { className: "num", text: col.nullCount.toLocaleString() }),
    rangeCell,
    valuesCell,
  );
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function hintDetails(hint: RelationshipHint): string {
  const parts: string[] = [];
  if (hint.sharedName) parts.push("same name");
  if (hint.sharedValues !== undefined && hint.leftInRight !== undefined && hint.rightInLeft !== undefined) {
    const left = `${hint.left.table}.${hint.left.column}`;
    const right = `${hint.right.table}.${hint.right.column}`;
    parts.push(
      `${hint.sharedValues.toLocaleString()} shared`,
      `${percent(hint.leftInRight)} of ${left} in ${right}`,
      `${percent(hint.rightInLeft)} the other way`,
    );
  }
  return parts.join(" · ");
}

function renderRelationships(container: HTMLElement, dataset: DatasetProfile): void {
  clear(container);
  if (dataset.tables.length < 2) {
    container.hidden = true;
    return;
  }
  container.append(el("h2", { text: "Relationships" }));
  if (dataset.hints.length === 0) {
    container.append(el("p", { className: "muted", text: "No likely join keys detected." }));
  } else {
    const list = el("ul", { className: "hints" });
    for (const hint of dataset.hints) {
      const item = el(
        "li",
        {},
        el("code", { text: `${hint.left.table}.${hint.left.column}` }),
        " ↔ ",
        el("code", { text: `${hint.right.table}.${hint.right.column}` }),
      );
      const details = hintDetails(hint);
      if (details) item.append(el("span", { className: "details", text: details }));
      list.append(item);
    }
    container.append(list);
  }
  container.hidden = false;
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

async function askClaude(dataset: DatasetProfile, question: string): Promise<string> {
  const body: QueryRequest = { dataset, question };
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

  let dataset: DatasetProfile = { tables: [], hints: [] };
  let dbReady = false;
  let busy = false;

  const setStatus = (text: string): void => {
    ui.status.textContent = text;
  };

  const updateFormState = (): void => {
    const enabled = dbReady && dataset.tables.length > 0 && !busy;
    ui.questionInput.disabled = !enabled;
    ui.askButton.disabled = !enabled;
  };

  const resetOutput = (): void => {
    hideError(ui.error);
    clear(ui.sql);
    clear(ui.results);
    ui.output.hidden = true;
  };

  const showOutput = (): void => {
    ui.output.hidden = false;
  };

  const renderDataset = (): void => {
    renderTables(ui.tables, dataset.tables, (table) => void handleRemove(table));
    renderRelationships(ui.relationships, dataset);
    updateFormState();
  };

  const refreshDataset = async (): Promise<void> => {
    dataset = await buildDataset();
    renderDataset();
  };

  const handleFiles = async (files: File[]): Promise<void> => {
    if (!dbReady || busy || files.length === 0) return;
    busy = true;
    updateFormState();
    resetOutput();

    const failures: string[] = [];
    let loaded = 0;
    for (const [i, file] of files.entries()) {
      setStatus(files.length > 1 ? `Loading ${file.name} (${i + 1} of ${files.length})…` : `Loading ${file.name}…`);
      try {
        await addFile(file);
        loaded += 1;
      } catch (err) {
        failures.push(`Could not load ${file.name}: ${errorMessage(err)}`);
      }
    }

    try {
      await refreshDataset();
    } catch (err) {
      failures.push(`Could not profile the loaded tables: ${errorMessage(err)}`);
    }

    if (failures.length > 0) showError(ui.error, failures.join("\n"));
    if (loaded > 0) {
      const count = dataset.tables.length;
      setStatus(`Loaded ${loaded} ${loaded === 1 ? "file" : "files"}. ${count} ${count === 1 ? "table" : "tables"} ready. Ask a question below.`);
    } else {
      setStatus("");
    }

    busy = false;
    updateFormState();
    if (loaded > 0 && dataset.tables.length > 0) ui.questionInput.focus();
  };

  const handleRemove = async (table: string): Promise<void> => {
    if (!dbReady || busy) return;
    busy = true;
    updateFormState();
    resetOutput();
    setStatus(`Removing ${table}…`);
    try {
      await removeTable(table);
      await refreshDataset();
      setStatus(
        dataset.tables.length === 0
          ? "All tables removed. Upload a CSV, Parquet, or JSON file."
          : `Removed ${table}.`,
      );
    } catch (err) {
      setStatus("");
      showError(ui.error, `Could not remove ${table}: ${errorMessage(err)}`);
    } finally {
      busy = false;
      updateFormState();
    }
  };

  const handleQuestion = async (question: string): Promise<void> => {
    if (dataset.tables.length === 0 || busy) return;
    busy = true;
    updateFormState();
    resetOutput();

    let sql: string;
    try {
      setStatus("Asking Claude…");
      sql = await askClaude(dataset, question);
    } catch (err) {
      setStatus("");
      showError(ui.error, errorMessage(err));
      busy = false;
      updateFormState();
      return;
    }

    renderSql(ui.sql, sql);
    showOutput();

    if (!isReadOnlySql(sql)) {
      setStatus("");
      showError(ui.error, "The generated SQL is not a read-only SELECT statement, so it was not run.");
      busy = false;
      updateFormState();
      return;
    }

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
    const files = Array.from(ui.fileInput.files ?? []);
    if (files.length > 0) void handleFiles(files);
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
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) void handleFiles(files);
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
      setStatus("Ready. Upload one or more CSV, Parquet, or JSON files.");
    })
    .catch((err: unknown) => {
      setStatus("");
      showError(ui.error, `DuckDB failed to start: ${errorMessage(err)}`);
    })
    .finally(updateFormState);
}

main();
