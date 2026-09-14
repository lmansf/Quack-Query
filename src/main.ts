import "./style.css";
import { inject } from "@vercel/analytics";
import {
  initDuckDB,
  addFile,
  removeTable,
  buildDataset,
  countQuery,
  runQueryPreview,
  exportQuery,
  formatValue,
  isReadOnlySql,
  type ExportFormat,
  type QueryResult,
} from "./duck";
import { chartSpec, renderChart } from "./chart";
import { downloadBytes, exportFileName } from "./download";
import { describeModelView } from "../shared/prompt";
import { externalReference } from "../shared/sql";
import {
  ANSWER_MAX_CELL_CHARS,
  ANSWER_MAX_COLUMNS,
  ANSWER_MAX_ROWS,
  type AnswerRequest,
  type AnswerResponse,
  type ColumnProfile,
  type DatasetProfile,
  type QueryError,
  type QueryRequest,
  type QueryResponse,
  type RelationshipHint,
  type TableProfile,
} from "../shared/types";

// Initialize Vercel Web Analytics
inject();

const ACCEPT = ".csv,.tsv,.txt,.parquet,.json,.jsonl,.ndjson";
const MAX_ROWS = 500;
/** Results with more rows than this prompt for confirmation before they are previewed. */
const LARGE_RESULT_ROWS = 100_000;
/** Exports with more rows than this prompt for confirmation before the file is written. */
const LARGE_EXPORT_ROWS = 1_000_000;
const EXPORT_MIME: Record<ExportFormat, string> = {
  csv: "text/csv",
  parquet: "application/vnd.apache.parquet",
};
const HISTORY_KEY = "quack-query:history";
const HISTORY_MAX = 50;
const HISTORY_ERROR_CHARS = 80;

// ---------------------------------------------------------------------------
// Query history
// ---------------------------------------------------------------------------

interface HistoryEntry {
  id: string;
  at: number;
  question: string;
  sql: string;
  source: "model" | "edited" | "history";
  rowCount?: number;
  error?: string;
}

type HistorySource = HistoryEntry["source"];

function isHistorySource(v: unknown): v is HistorySource {
  return v === "model" || v === "edited" || v === "history";
}

function isHistoryEntry(v: unknown): v is HistoryEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.at === "number" &&
    typeof e.question === "string" &&
    typeof e.sql === "string" &&
    isHistorySource(e.source) &&
    (e.rowCount === undefined || typeof e.rowCount === "number") &&
    (e.error === undefined || typeof e.error === "string")
  );
}

/** Reads the persisted history; returns [] when storage is unavailable or the data is malformed. */
function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isHistoryEntry).slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  } catch {
    // Storage unavailable or full: history stays in memory for this session only.
  }
}

function newHistoryId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sameOutcome(a: Omit<HistoryEntry, "id" | "at">, b: HistoryEntry): boolean {
  return (
    a.question === b.question &&
    a.sql === b.sql &&
    a.source === b.source &&
    a.rowCount === b.rowCount &&
    a.error === b.error
  );
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `HH:MM` for today, otherwise `YYYY-MM-DD HH:MM` (local time). */
function formatHistoryTime(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return time;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
}

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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
  answer: HTMLDivElement;
  history: HTMLElement;
  answerToggle: HTMLInputElement;
}

function renderShell(root: HTMLElement): Shell {
  const header = el(
    "header",
    {},
    el("h1", { text: "Quack Query" }),
    el("p", { text: "Ask questions about your files. The files stay in your browser; the model only sees a schema summary and small result samples." }),
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

  const answerToggle = el("input");
  answerToggle.type = "checkbox";
  answerToggle.checked = readAnswerPreference();
  answerToggle.addEventListener("change", () => saveAnswerPreference(answerToggle.checked));
  const answerOption = el(
    "label",
    { className: "option" },
    answerToggle,
    " Write a plain-language answer (sends the first 50 result rows to the model)",
  );

  const status = el("div", { className: "status" });
  const error = el("div", { className: "error" });
  error.hidden = true;

  const sql = el("div", { className: "output-sql" });
  const results = el("div", { className: "output-results" });
  const answer = el("div", { className: "answer card" });
  answer.hidden = true;
  const output = el("section", { className: "output" }, sql, results, answer);
  output.hidden = true;

  const history = el("section", { className: "history" });
  history.hidden = true;

  const footer = el(
    "footer",
    {},
    el("p", {
      text:
        "Files are processed locally with DuckDB Wasm. The model only receives the schema profiles " +
        "(column names, types, counts, ranges, low-cardinality values, and relationship hints) and, " +
        "for the written answer, the first 50 rows of each query result.",
    }),
  );

  root.replaceChildren(
    header,
    el("section", {}, dropzone),
    tables,
    relationships,
    el("section", {}, form, answerOption, status),
    error,
    output,
    history,
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
    answer,
    history,
    answerToggle,
  };
}

const ANSWER_PREF_KEY = "quack-query:answer-step";

/** Whether the answer step is enabled (default on); remembered per browser. */
function readAnswerPreference(): boolean {
  try {
    return localStorage.getItem(ANSWER_PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

function saveAnswerPreference(enabled: boolean): void {
  try {
    localStorage.setItem(ANSWER_PREF_KEY, enabled ? "on" : "off");
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

// ---------------------------------------------------------------------------
// Rendering pieces
// ---------------------------------------------------------------------------

function renderTables(
  container: HTMLElement,
  dataset: DatasetProfile,
  onRemove: (table: string) => void,
): void {
  clear(container);
  if (dataset.tables.length === 0) {
    container.hidden = true;
    return;
  }
  container.append(el("h2", { text: "Tables" }));
  for (const profile of dataset.tables) container.append(tableCard(profile, onRemove));
  container.append(modelViewPanel(dataset));
  container.hidden = false;
}

/** Collapsible panel showing the exact system prompt the model receives for this dataset. */
function modelViewPanel(dataset: DatasetProfile): HTMLDetailsElement {
  const text = describeModelView(dataset);
  const pre = el("pre", { text });
  const copy = el("button", { className: "secondary", text: "Copy prompt" });
  copy.type = "button";
  copy.addEventListener("click", () => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        copy.textContent = "Copied";
        setTimeout(() => {
          copy.textContent = "Copy prompt";
        }, 1500);
      })
      .catch(() => {
        copy.textContent = "Copy failed";
      });
  });
  return el(
    "details",
    { className: "model-view" },
    el("summary", { text: "What the model sees" }),
    el("p", {
      className: "muted",
      text: "This is the exact system prompt sent with every question. Row data is never included.",
    }),
    pre,
    el("div", { className: "model-view-actions" }, copy),
  );
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
  const valuesText = col.values ? col.values.join(", ") : col.valuesWithheld ? "withheld (looks personal)" : "";
  const valuesCell = el("td", { className: col.valuesWithheld ? "values muted" : "values", text: valuesText });
  if (col.values && valuesText) valuesCell.title = valuesText;
  if (col.valuesWithheld) valuesCell.title = "This column looks like personal data, so its values are not sent to the model.";

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

interface SqlEditor {
  textarea: HTMLTextAreaElement;
  run: HTMLButtonElement;
  copy: HTMLButtonElement;
}

/** Sizes the textarea to its content: `rows` from the line count (works while hidden), then scrollHeight. */
function autoGrow(textarea: HTMLTextAreaElement): void {
  const lines = textarea.value.split("\n").length;
  textarea.rows = Math.max(3, lines);
  textarea.style.height = "auto";
  if (textarea.scrollHeight > 0) textarea.style.height = `${textarea.scrollHeight}px`;
}

/** Renders the editable SQL block (textarea + Copy SQL / Run buttons) and returns its controls. */
function renderSql(container: HTMLElement, sql: string, onRun: (sql: string) => void): SqlEditor {
  const textarea = el("textarea", { className: "sql" });
  textarea.value = sql;
  textarea.spellcheck = false;
  textarea.setAttribute("aria-label", "SQL query");
  textarea.addEventListener("input", () => autoGrow(textarea));
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!run.disabled) onRun(textarea.value);
    }
  });

  const copy = el("button", { className: "secondary", text: "Copy SQL" });
  copy.type = "button";
  copy.addEventListener("click", () => {
    void navigator.clipboard
      .writeText(textarea.value)
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

  const run = el("button", { className: "run", text: "Run" });
  run.type = "button";
  run.addEventListener("click", () => onRun(textarea.value));

  container.replaceChildren(
    el("div", { className: "sql-block" }, el("div", { className: "sql-actions" }, copy, run), textarea),
  );
  autoGrow(textarea);
  return { textarea, run, copy };
}

interface HistoryHandlers {
  onLoad: (entry: HistoryEntry) => void;
  onRemove: (entry: HistoryEntry) => void;
  onClear: () => void;
}

function historyRow(entry: HistoryEntry, canLoad: boolean, handlers: HistoryHandlers): HTMLLIElement {
  const meta = el("div", { className: "meta" }, el("span", { text: formatHistoryTime(entry.at) }));
  if (entry.error !== undefined) {
    meta.append(" · ", el("span", { className: "outcome error-text", text: `error: ${entry.error.slice(0, HISTORY_ERROR_CHARS)}` }));
  } else if (entry.rowCount !== undefined) {
    meta.append(" · ", el("span", { className: "outcome", text: `${entry.rowCount.toLocaleString()} ${entry.rowCount === 1 ? "row" : "rows"}` }));
  }
  if (entry.source === "edited") meta.append(" ", el("span", { className: "tag", text: "edited" }));

  const load = el("button", { className: "secondary", text: "Load" });
  load.type = "button";
  load.disabled = !canLoad;
  load.addEventListener("click", () => handlers.onLoad(entry));

  const remove = el("button", { className: "secondary", text: "Remove" });
  remove.type = "button";
  remove.addEventListener("click", () => handlers.onRemove(entry));

  return el(
    "li",
    { className: "history-row" },
    el(
      "div",
      { className: "history-main" },
      el("div", { className: "q", text: entry.question }),
      el("code", { text: entry.sql.replace(/\s+/g, " ").trim(), title: entry.sql }),
      meta,
    ),
    el("div", { className: "history-actions" }, load, remove),
  );
}

function renderHistory(
  container: HTMLElement,
  entries: HistoryEntry[],
  canLoad: boolean,
  handlers: HistoryHandlers,
): void {
  clear(container);
  if (entries.length === 0) {
    container.hidden = true;
    return;
  }
  const clearButton = el("button", { className: "secondary", text: "Clear history" });
  clearButton.type = "button";
  clearButton.addEventListener("click", handlers.onClear);
  container.append(el("div", { className: "history-header" }, el("h2", { text: "History" }), clearButton));

  const list = el("ul", { className: "history-list" });
  for (const entry of entries) list.append(historyRow(entry, canLoad, handlers));
  container.append(list);
  container.hidden = false;
}

function resultsTable(result: QueryResult): HTMLDivElement {
  const table = el("table");
  const thead = el("thead");
  thead.append(el("tr", {}, ...result.columns.map((c) => el("th", { text: c }))));
  const tbody = el("tbody");
  for (const row of result.rows) {
    tbody.append(el("tr", {}, ...row.map((v) => el("td", { text: formatValue(v) }))));
  }
  table.append(thead, tbody);
  return el("div", { className: "table-wrap" }, table);
}

function resultsCaption(result: QueryResult): string {
  return result.truncated
    ? `${result.rowCount.toLocaleString()} rows (showing first ${result.rows.length.toLocaleString()})`
    : `${result.rowCount.toLocaleString()} ${result.rowCount === 1 ? "row" : "rows"}`;
}

interface ResultsActions {
  onExport: (format: ExportFormat) => void;
}

/**
 * Results card: caption, a Table/Chart toggle (when the result is chartable),
 * export buttons, and the table or chart body.
 */
function renderResults(container: HTMLElement, result: QueryResult, actions: ResultsActions): void {
  const body = el("div", { className: "results-body" });
  const buttons = el("div", { className: "results-actions" });

  const spec = chartSpec(result);
  if (spec) {
    const tableButton = el("button", { className: "secondary active", text: "Table" });
    tableButton.type = "button";
    const chartButton = el("button", { className: "secondary", text: "Chart" });
    chartButton.type = "button";
    const show = (chart: boolean): void => {
      body.replaceChildren(chart ? renderChart(spec) : resultsTable(result));
      chartButton.classList.toggle("active", chart);
      tableButton.classList.toggle("active", !chart);
    };
    tableButton.addEventListener("click", () => show(false));
    chartButton.addEventListener("click", () => show(true));
    buttons.append(tableButton, chartButton);
  }
  for (const format of ["csv", "parquet"] as const) {
    const button = el("button", { className: "secondary", text: `Export ${format === "csv" ? "CSV" : "Parquet"}` });
    button.type = "button";
    button.title = "Exports the full result of this query, not just the rows shown";
    button.addEventListener("click", () => actions.onExport(format));
    buttons.append(button);
  }

  body.append(resultsTable(result));
  container.replaceChildren(
    el(
      "div",
      { className: "card" },
      el("div", { className: "results-header" }, el("span", { className: "caption", text: resultsCaption(result) }), buttons),
      body,
    ),
  );
}

/** Fills the answer card with a label plus either the answer text or a muted note. */
function renderAnswer(container: HTMLDivElement, text: string, muted = false): void {
  const body = el(muted ? "p" : "div", { className: muted ? "muted" : "answer-text", text });
  container.replaceChildren(el("h2", { text: "Answer" }), body);
  container.hidden = false;
}

function hideAnswer(container: HTMLDivElement): void {
  clear(container);
  container.hidden = true;
}

/** Trims a query result down to the prefix the answer endpoint accepts. */
function buildAnswerRequest(question: string, sql: string, result: QueryResult): AnswerRequest {
  const columns = result.columns.slice(0, ANSWER_MAX_COLUMNS);
  const rows = result.rows
    .slice(0, ANSWER_MAX_ROWS)
    .map((row) => row.slice(0, columns.length).map((v) => formatValue(v).slice(0, ANSWER_MAX_CELL_CHARS)));
  return { question, sql, columns, rows, rowCount: result.rowCount };
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

/** Builds a user-facing message from a non-2xx API response (`{ error }` JSON or a platform error page). */
async function errorFromResponse(res: Response): Promise<Error> {
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
  return new Error(message);
}

async function postJson(path: string, body: unknown): Promise<Response> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFromResponse(res);
  return res;
}

async function askClaude(dataset: DatasetProfile, question: string): Promise<string> {
  const body: QueryRequest = { dataset, question };
  const res = await postJson("/api/query", body);

  const data = (await res.json()) as Partial<QueryResponse>;
  if (typeof data.sql !== "string" || !data.sql.trim()) {
    throw new Error("The server returned no SQL.");
  }
  return data.sql.trim();
}

async function askForAnswer(body: AnswerRequest): Promise<string> {
  const res = await postJson("/api/answer", body);

  const data = (await res.json()) as Partial<AnswerResponse>;
  if (typeof data.answer !== "string" || !data.answer.trim()) {
    throw new Error("The server returned no answer.");
  }
  return data.answer.trim();
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
  let lastQuestion = "";
  /** SQL and row count of the result currently on screen, for exports. */
  let lastRun: { sql: string; rowCount: number } | null = null;
  let editor: SqlEditor | null = null;
  let history: HistoryEntry[] = loadHistory();

  const setStatus = (text: string): void => {
    ui.status.textContent = text;
  };

  const historyHandlers: HistoryHandlers = {
    onLoad: (entry) => void handleHistoryLoad(entry),
    onRemove: (entry) => {
      history = history.filter((e) => e.id !== entry.id);
      saveHistory(history);
      refreshHistory();
    },
    onClear: () => {
      history = [];
      saveHistory(history);
      refreshHistory();
    },
  };

  const refreshHistory = (): void => {
    renderHistory(ui.history, history, dbReady && !busy, historyHandlers);
  };

  const recordHistory = (entry: Omit<HistoryEntry, "id" | "at">): void => {
    const newest = history[0];
    if (newest && sameOutcome(entry, newest)) return;
    history = [{ id: newHistoryId(), at: Date.now(), ...entry }, ...history].slice(0, HISTORY_MAX);
    saveHistory(history);
    refreshHistory();
  };

  const updateFormState = (): void => {
    const enabled = dbReady && dataset.tables.length > 0 && !busy;
    ui.questionInput.disabled = !enabled;
    ui.askButton.disabled = !enabled;
    if (editor) editor.run.disabled = busy || !dbReady;
    refreshHistory();
  };

  const resetOutput = (): void => {
    hideError(ui.error);
    clear(ui.sql);
    editor = null;
    clear(ui.results);
    hideAnswer(ui.answer);
    ui.output.hidden = true;
  };

  const showOutput = (): void => {
    ui.output.hidden = false;
    if (editor) autoGrow(editor.textarea);
  };

  /** Puts SQL into the editor (creating it if needed) and shows the output section. */
  const showSql = (sql: string): void => {
    editor = renderSql(ui.sql, sql, (text) => void handleRun(text));
    editor.run.disabled = busy || !dbReady;
    showOutput();
  };

  /** The question the answer step is written against: the last one asked, else what's typed now. */
  const currentQuestion = (): string => lastQuestion || ui.questionInput.value.trim() || "What does this query return?";

  const renderDataset = (): void => {
    renderTables(ui.tables, dataset, (table) => void handleRemove(table));
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

  /** Answer step: never throws; failures land as a muted note inside the answer card. */
  const writeAnswer = async (question: string, sql: string, result: QueryResult): Promise<void> => {
    setStatus("Writing answer…");
    renderAnswer(ui.answer, "Thinking…", true);
    try {
      const answer = await askForAnswer(buildAnswerRequest(question, sql, result));
      renderAnswer(ui.answer, answer);
    } catch (err) {
      renderAnswer(ui.answer, `Couldn't write an answer: ${errorMessage(err)}`, true);
    }
  };

  /**
   * Runs SQL that is already in the editor: renders results, applies the model-error
   * convention, writes the answer, and records the outcome in history. Shared by the
   * Ask flow, the editor's Run button, and history replay.
   */
  const executeSql = async (question: string, sql: string, source: HistorySource): Promise<void> => {
    if (busy) return;
    busy = true;
    updateFormState();
    hideError(ui.error);
    clear(ui.results);
    hideAnswer(ui.answer);
    lastRun = null;
    showOutput();

    // Loaded tables are the only data source; anything reaching outside the tab is refused.
    const external = externalReference(sql);
    if (external !== null) {
      const message = `This query references ${external}, which is not allowed. Queries may only read the loaded tables.`;
      setStatus("");
      showError(ui.error, message);
      recordHistory({ question, sql, source, error: message });
      busy = false;
      updateFormState();
      return;
    }

    try {
      // Count first so the user can back out of an enormous result before any rows are fetched.
      setStatus("Counting rows…");
      let count: number | undefined;
      try {
        count = await countQuery(sql);
      } catch {
        count = undefined; // not a subquery-able statement; the preview falls back to a plain run
      }
      if (count !== undefined && count > LARGE_RESULT_ROWS) {
        const proceed = window.confirm(
          `This query returns ${count.toLocaleString()} rows. Only the first ${MAX_ROWS.toLocaleString()} ` +
            `will be displayed and the written answer sees the first ${ANSWER_MAX_ROWS}. ` +
            `You can export the full result afterwards. Continue?`,
        );
        if (!proceed) {
          setStatus(`Cancelled. The query would return ${count.toLocaleString()} rows.`);
          recordHistory({ question, sql, source, rowCount: count });
          return;
        }
      }

      setStatus("Running query…");
      const result = await runQueryPreview(sql, MAX_ROWS, count);
      const modelError = modelErrorFrom(result);
      if (modelError !== null) {
        setStatus("");
        showError(ui.error, modelError);
        recordHistory({ question, sql, source, error: modelError });
      } else {
        lastRun = { sql, rowCount: result.rowCount };
        renderResults(ui.results, result, { onExport: (format) => void handleExport(format) });
        recordHistory({ question, sql, source, rowCount: result.rowCount });
        if (ui.answerToggle.checked) await writeAnswer(question, sql, result);
        setStatus("Done.");
      }
    } catch (err) {
      const message = `Query failed: ${errorMessage(err)}`;
      setStatus("");
      showError(ui.error, message);
      recordHistory({ question, sql, source, error: message });
    } finally {
      busy = false;
      updateFormState();
    }
  };

  /** Exports the full result of the query on screen (not just the preview rows) as a download. */
  const handleExport = async (format: ExportFormat): Promise<void> => {
    if (!lastRun || busy || !dbReady) return;
    const { sql, rowCount } = lastRun;
    if (rowCount > LARGE_EXPORT_ROWS) {
      const proceed = window.confirm(
        `This export contains ${rowCount.toLocaleString()} rows and is written in your browser's memory first. Continue?`,
      );
      if (!proceed) return;
    }
    busy = true;
    updateFormState();
    const label = format === "csv" ? "CSV" : "Parquet";
    setStatus(`Exporting ${label}…`);
    try {
      const bytes = await exportQuery(sql, format);
      downloadBytes(exportFileName(currentQuestion(), format), bytes, EXPORT_MIME[format]);
      setStatus(`Exported ${rowCount.toLocaleString()} rows as ${label} (${formatBytes(bytes.byteLength)}).`);
    } catch (err) {
      setStatus("");
      let message = `Export failed: ${errorMessage(err)}`;
      if (format === "parquet") {
        message +=
          "\nParquet support relies on DuckDB's parquet extension, which the browser fetches from " +
          "extensions.duckdb.org the first time it is needed. Check that this site can reach it, then retry.";
      }
      showError(ui.error, message);
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
    lastQuestion = question;

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

    // Always show the SQL, even when it can't be run, so the user can correct it in the editor.
    showSql(sql);

    if (!isReadOnlySql(sql)) {
      setStatus("");
      showError(ui.error, "The generated SQL is not a read-only SELECT statement, so it was not run.");
      busy = false;
      updateFormState();
      return;
    }

    busy = false;
    await executeSql(question, sql, "model");
  };

  /** Run button / Ctrl+Enter: executes whatever is in the editor, keeping the text as typed. */
  const handleRun = async (text: string): Promise<void> => {
    if (busy || !dbReady) return;
    const sql = text.trim();
    if (!sql) return;
    if (!isReadOnlySql(sql)) {
      setStatus("");
      showError(ui.error, "Only read-only SELECT statements can be run.");
      return;
    }
    await executeSql(currentQuestion(), sql, "edited");
  };

  /** History "Load": restores question + SQL and replays the query without calling the model. */
  const handleHistoryLoad = async (entry: HistoryEntry): Promise<void> => {
    if (busy || !dbReady) return;
    ui.questionInput.value = entry.question;
    lastQuestion = entry.question;
    hideError(ui.error);
    clear(ui.results);
    hideAnswer(ui.answer);
    showSql(entry.sql);
    if (dataset.tables.length === 0) {
      setStatus("Load a file, then press Run.");
      return;
    }
    await executeSql(entry.question, entry.sql, "history");
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

  refreshHistory();
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
