/**
 * Password-protected A/B results page (/results). Reads GET /api/results and renders
 * the per-variant comparison, the thumbs-up difference, and recent comments.
 */
import "./style.css";
import type { ResponseSource, ResultsResponse, Variant, VariantStats } from "../shared/types";

const PASSWORD_KEY = "quack-query:results-password";
const VARIANTS: readonly Variant[] = ["A", "B"];
const DASH = "—";
/** Outcomes in a fixed order so the A and B columns line up; unknown keys follow alphabetically. */
const OUTCOME_ORDER = ["ok", "query_error", "model_error", "refused", "api_error", "mapping_error", "cancelled"];
const SOURCE_LABELS: Record<ResponseSource, string> = {
  model: "question",
  edited: "edited re-run",
  history: "history replay",
};

type Scope = ResultsResponse["scope"];

// ---------------------------------------------------------------------------
// Small helpers (DOM is built with textContent only, never HTML)
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readPassword(): string {
  try {
    return sessionStorage.getItem(PASSWORD_KEY) ?? "";
  } catch {
    return "";
  }
}

function savePassword(password: string): void {
  try {
    sessionStorage.setItem(PASSWORD_KEY, password);
  } catch {
    // Storage unavailable: the password lasts until the page closes.
  }
}

function forgetPassword(): void {
  try {
    sessionStorage.removeItem(PASSWORD_KEY);
  } catch {
    // Nothing stored.
  }
}

// ---------------------------------------------------------------------------
// Formatting (null, missing, or non-finite numbers render as a dash)
// ---------------------------------------------------------------------------

type Num = number | null | undefined;

function isNum(x: Num): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function percent(x: Num): string {
  return isNum(x) ? `${Math.round(x * 100)}%` : DASH;
}

function count(x: Num): string {
  return isNum(x) ? x.toLocaleString() : DASH;
}

function decimal(x: Num): string {
  return isNum(x) ? x.toFixed(1) : DASH;
}

function duration(ms: Num): string {
  if (!isNum(ms)) return DASH;
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "62% (48–74%)": the rate with its Wilson 95% interval (kept on one line). */
function upRateCell(s: VariantStats): string | Node {
  if (!isNum(s.upRate)) return DASH;
  const ci = s.upRateCi;
  if (!ci || !isNum(ci[0]) || !isNum(ci[1])) return percent(s.upRate);
  const interval = `(${Math.round(ci[0] * 100)}–${Math.round(ci[1] * 100)}%)`;
  return el("span", {}, `${percent(s.upRate)} `, el("span", { className: "ab-nowrap", text: interval }));
}

/**
 * "ok 40 · query_error 3 · …", skipping zero counts. Each entry wraps as a unit; on
 * narrow screens a long key may also break after an underscore.
 */
function outcomesCell(outcomes: Record<string, number> | undefined): string | Node {
  if (!outcomes) return DASH;
  const extra = Object.keys(outcomes)
    .filter((k) => !OUTCOME_ORDER.includes(k))
    .sort();
  const keys = [...OUTCOME_ORDER, ...extra].filter((k) => isNum(outcomes[k]) && (outcomes[k] ?? 0) > 0);
  if (keys.length === 0) return DASH;
  const cell = el("span");
  keys.forEach((key, i) => {
    const item = el("span", { className: "ab-outcome" });
    const parts = key.split("_");
    parts.forEach((part, j) => {
      if (j < parts.length - 1) item.append(`${part}_`, el("wbr"));
      else item.append(part);
    });
    item.append(` ${count(outcomes[key])}${i < keys.length - 1 ? " ·" : ""}`);
    if (i > 0) cell.append(" ");
    cell.append(item);
  });
  return cell;
}

function pValueText(p: number): string {
  return p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`;
}

/** "+12.0 points" / "−3.5 points" from a difference of two rates (fractions). */
function pointsText(diff: number): string {
  const magnitude = Math.abs(diff * 100).toFixed(1);
  const sign = diff < 0 && magnitude !== "0.0" ? "−" : "+";
  return `${sign}${magnitude} points`;
}

function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface MetricRow {
  label: string;
  /** Tooltip on the label. */
  hint?: string;
  value: (s: VariantStats) => string | Node;
}

const METRICS: MetricRow[] = [
  { label: "Responses", value: (s) => count(s.responses) },
  { label: "Thumbs-up rate", hint: "👍 / (👍 + 👎), with a 95% Wilson interval", value: upRateCell },
  { label: "👍 / 👎", value: (s) => `${count(s.up)} / ${count(s.down)}` },
  { label: "Feedback rate", hint: "Share of responses that got a vote", value: (s) => percent(s.feedbackRate) },
  { label: "Success rate", hint: "Share of responses that showed results", value: (s) => percent(s.okRate) },
  {
    label: "Median latency",
    hint: "From asking (or Run / Load) to results or an error on screen",
    value: (s) => duration(s.medianLatencyMs),
  },
  { label: "Mean answer time", hint: "The written-answer step, when it ran", value: (s) => duration(s.meanAnswerMs) },
  { label: "Mean queries per question", hint: "B's query loop", value: (s) => decimal(s.meanAttempts) },
  { label: "Mean predicted columns", hint: "B's column prediction", value: (s) => decimal(s.meanPredictedK) },
  {
    label: "Predicted-column hit rate",
    hint: "Share of predicted columns the final SQL used",
    value: (s) => percent(s.meanMappingHit),
  },
  { label: "Outcomes", value: (s) => outcomesCell(s.outcomes) },
];

function comparisonTable(data: ResultsResponse): HTMLElement {
  const thead = el("thead", {}, el("tr", {}, el("th", { text: "Metric" }), ...VARIANTS.map((v) => el("th", { text: v }))));
  const tbody = el("tbody");
  for (const metric of METRICS) {
    const label = el("td", { className: "metric", text: metric.label });
    if (metric.hint) label.title = metric.hint;
    tbody.append(el("tr", {}, label, ...VARIANTS.map((v) => el("td", {}, metric.value(data.variants[v])))));
  }
  return el("div", { className: "card ab-table" }, el("table", {}, thead, tbody));
}

function differenceCard(diff: ResultsResponse["upRateDiff"]): HTMLElement {
  const label = "B − A thumbs-up rate: ";
  if (!diff || !isNum(diff.diff) || !isNum(diff.pValue)) {
    return el(
      "div",
      { className: "card ab-diff" },
      el("p", { className: "ab-diff-value", text: `${label}${DASH}` }),
      el("p", { className: "ab-verdict", text: "Not enough votes yet" }),
    );
  }
  const significant = diff.pValue < 0.05;
  return el(
    "div",
    { className: "card ab-diff" },
    el("p", { className: "ab-diff-value", text: `${label}${pointsText(diff.diff)} (${pValueText(diff.pValue)})` }),
    el("p", {
      className: significant ? "ab-verdict significant" : "ab-verdict",
      text: significant ? "Significant at p < 0.05" : "Not significant yet",
    }),
  );
}

function commentsSection(comments: ResultsResponse["comments"]): HTMLElement {
  const section = el("section", { className: "ab-comments" }, el("h2", { text: "Recent comments" }));
  if (comments.length === 0) {
    section.append(el("p", { className: "muted", text: "No comments yet." }));
    return section;
  }
  const list = el("ul", { className: "ab-comment-list" });
  for (const c of comments) {
    const meta = el(
      "div",
      { className: "ab-comment-meta" },
      el("span", { className: c.variant === "B" ? "badge variant-b" : "badge variant-a", text: String(c.variant) }),
      el("span", { text: SOURCE_LABELS[c.source] ?? String(c.source) }),
      el("span", { text: "·" }),
      el("span", { text: localTime(c.at), title: c.at }),
    );
    list.append(el("li", { className: "ab-comment" }, meta, el("p", { className: "ab-comment-text", text: c.comment })));
  }
  section.append(list);
  return section;
}

function isVariantStats(v: unknown): v is VariantStats {
  return typeof v === "object" && v !== null && typeof (v as { responses?: unknown }).responses === "number";
}

function isResultsResponse(v: unknown): v is ResultsResponse {
  if (typeof v !== "object" || v === null) return false;
  const r = v as { configured?: unknown; variants?: Record<string, unknown>; comments?: unknown };
  return (
    typeof r.configured === "boolean" &&
    typeof r.variants === "object" &&
    r.variants !== null &&
    isVariantStats(r.variants.A) &&
    isVariantStats(r.variants.B) &&
    Array.isArray(r.comments)
  );
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

type FetchOutcome =
  | { kind: "ok"; data: ResultsResponse }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string };

/** The server's `{ error }` text, else a trimmed excerpt of the body, else the status line. */
async function errorText(res: Response): Promise<string> {
  const fallback = `Request failed (${res.status}${res.statusText ? " " + res.statusText : ""})`;
  const text = await res.text().catch(() => "");
  try {
    const data = JSON.parse(text) as { error?: unknown };
    if (typeof data.error === "string" && data.error) return data.error;
  } catch {
    const excerpt = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    if (excerpt) return `${fallback}: ${excerpt}`;
  }
  return fallback;
}

async function fetchResults(password: string, scope: Scope): Promise<FetchOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/results?scope=${scope}`, {
      headers: { "x-results-password": password },
      cache: "no-store",
    });
  } catch (err) {
    return { kind: "error", message: `Could not load results: ${errorMessage(err)}` };
  }
  if (res.status === 401) return { kind: "unauthorized" };
  // 503: the results password is not configured on the server; its message says what to set.
  if (res.status === 503) return { kind: "error", message: await errorText(res) };
  if (!res.ok) return { kind: "error", message: `Could not load results: ${await errorText(res)}` };
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { kind: "error", message: "Could not load results: the server sent a response that is not JSON." };
  }
  if (!isResultsResponse(data)) {
    return { kind: "error", message: "Could not load results: the server sent an unexpected response." };
  }
  return { kind: "ok", data };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function main(): void {
  const root = document.getElementById("app");
  if (!root) throw new Error("Missing #app root element");

  const passwordInput = el("input");
  passwordInput.type = "password";
  passwordInput.id = "results-password";
  passwordInput.autocomplete = "current-password";
  passwordInput.placeholder = "Results password";
  const showButton = el("button", { text: "Show results" });
  showButton.type = "submit";
  const passwordLabel = el("label", { text: "Password" });
  passwordLabel.htmlFor = passwordInput.id;
  const form = el("form", { className: "ab-login" }, passwordLabel, el("div", { className: "ab-login-row" }, passwordInput, showButton));

  const includeAll = el("input");
  includeAll.type = "checkbox";
  const refresh = el("button", { className: "secondary", text: "Refresh" });
  refresh.type = "button";
  const toolbar = el(
    "div",
    { className: "ab-toolbar" },
    el("label", { className: "option" }, includeAll, " Include edited re-runs and history replays"),
    refresh,
  );
  const status = el("div", { className: "status" });
  const error = el("div", { className: "error" });
  error.hidden = true;
  const output = el("div", { className: "ab-output" });

  root.append(
    el(
      "header",
      {},
      el("h1", { text: "A/B results" }),
      el("p", { text: "A is the original app; B adds Jev column prediction and the query loop." }),
    ),
    el("section", { className: "ab-controls card" }, form, toolbar, status),
    error,
    output,
  );

  /** The password the last successful load used (or the remembered one, before the first load). */
  let password = readPassword();
  let loading = false;
  /** Increments per request so a slow, superseded response never overwrites a newer one. */
  let requestSeq = 0;

  const updateControls = (): void => {
    showButton.disabled = loading;
    refresh.disabled = loading || !password;
  };

  const showError = (message: string): void => {
    error.textContent = message;
    error.hidden = false;
  };

  const hideError = (): void => {
    error.textContent = "";
    error.hidden = true;
  };

  const render = (data: ResultsResponse): void => {
    const parts: HTMLElement[] = [];
    if (!data.configured) {
      parts.push(
        el("div", {
          className: "ab-notice",
          text:
            "No storage configured yet: add Upstash Redis from the Vercel Marketplace to this project and " +
            "redeploy. Until then, events are not stored and every number below is zero.",
        }),
      );
    }
    parts.push(comparisonTable(data), differenceCard(data.upRateDiff), commentsSection(data.comments));
    output.replaceChildren(...parts);
    const scopeText = data.scope === "all" ? "All responses, including edited re-runs and history replays" : "Questions answered by the model";
    status.textContent = `${scopeText} · updated ${localTime(data.generatedAt)}`;
  };

  const load = async (): Promise<void> => {
    if (!password) {
      showError("Enter the results password.");
      passwordInput.focus();
      return;
    }
    const seq = ++requestSeq;
    const scope: Scope = includeAll.checked ? "all" : "model";
    loading = true;
    updateControls();
    status.textContent = "Loading…";
    const outcome = await fetchResults(password, scope);
    if (seq !== requestSeq) return; // superseded by a newer request
    loading = false;

    if (outcome.kind === "ok") {
      savePassword(password);
      hideError();
      render(outcome.data);
    } else {
      output.replaceChildren();
      status.textContent = "";
      if (outcome.kind === "unauthorized") {
        forgetPassword();
        password = "";
        showError("Wrong password");
        passwordInput.focus();
        passwordInput.select();
      } else {
        showError(outcome.message);
      }
    }
    updateControls();
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!passwordInput.value.trim()) {
      showError("Enter the results password.");
      passwordInput.focus();
      return;
    }
    password = passwordInput.value;
    void load();
  });
  includeAll.addEventListener("change", () => {
    if (password) void load();
  });
  refresh.addEventListener("click", () => void load());

  updateControls();
  if (password) {
    passwordInput.value = password;
    void load();
  } else {
    passwordInput.focus();
  }
}

main();
