/**
 * "How this answer was found": the visible step list of the query loop
 * (variant B). Feed it every LoopProgress event from runLoop; it shows Jev's
 * column prediction, one row per query the model ran, a "Thinking…" row while
 * the model decides, and how the final query was chosen. Built with
 * createElement + textContent only, no inline styles (CSP-safe).
 */
import "./trace.css";
import { LOOP_MAX_QUERIES, type LoopAttempt, type MappingResponse } from "../shared/types";
import type { LoopProgress } from "./loop";

export interface Trace {
  /** The `section.trace` card; hidden until the first event and after `reset()`. */
  element: HTMLElement;
  update(p: LoopProgress): void;
  /**
   * Shows "Stopped: <message>" in place of the step in progress (after a
   * MappingError or StepError), so nothing keeps looking busy.
   */
  fail(message: string): void;
  /** Removes every step and hides the card. */
  reset(): void;
}

/** Characters of an error or refusal shown inline; the full text is in the tooltip. */
const MESSAGE_PREVIEW_CHARS = 160;

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

/** One list row; `state` picks the status dot (is-pending, is-ok, is-error, is-refused, is-final, is-failed...). */
function step(state: string, ...children: (Node | string)[]): HTMLLIElement {
  return el("li", { className: `trace-step ${state}` }, ...children);
}

/** First line of a message, shortened for inline display. */
function preview(message: string): string {
  const line = message.trim().split("\n", 1)[0] ?? "";
  return line.length > MESSAGE_PREVIEW_CHARS ? `${line.slice(0, MESSAGE_PREVIEW_CHARS).trimEnd()}…` : line;
}

function percent(p: number): string {
  return Number.isFinite(p) ? `${Math.round(p * 100)}%` : "?";
}

function rows(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "row" : "rows"}`;
}

function remainingText(n: number): string {
  return `${n} of ${LOOP_MAX_QUERIES}`;
}

/** Tooltip for the mapping row: the count Jev expects, its model, calls and time. */
function mappingDetails(m: MappingResponse, ms: number): string {
  const parts: string[] = [];
  if (Number.isFinite(m.k)) {
    const expected = Number.isFinite(m.expectedCount) ? ` (expected ${m.expectedCount.toFixed(1)})` : "";
    parts.push(`Most likely column count: ${m.k}${expected}`);
  }
  if (m.model) parts.push(`Jev model: ${m.model}`);
  if (Number.isFinite(m.calls)) parts.push(`${m.calls} API ${m.calls === 1 ? "call" : "calls"}`);
  if (Number.isFinite(ms)) parts.push(`${(ms / 1000).toFixed(1)} s`);
  return parts.join(" · ");
}

function mappingStep(m: MappingResponse, ms: number): HTMLLIElement {
  const label = el("span", { className: "trace-label" });
  const cols = m.columns;
  if (cols.length === 0) {
    label.append("Jev predicted no columns");
  } else {
    label.append(`Jev predicted ${cols.length} ${cols.length === 1 ? "column" : "columns"}: `);
    cols.forEach((c, i) => {
      if (i > 0) label.append(", ");
      label.append(el("span", { className: "trace-col", text: `${c.table}.${c.column}` }), ` (${percent(c.probability)})`);
    });
  }
  const row = step("is-done", label);
  const details = mappingDetails(m, ms);
  if (details) row.title = details;
  return row;
}

function queryStep(index: number, attempt: LoopAttempt, remainingAfter: number): HTMLLIElement {
  const outcome = el("span", { className: "trace-outcome" });
  if (attempt.outcome === "ok") {
    outcome.textContent = rows(attempt.rowCount ?? 0);
    const columns = attempt.columns ?? [];
    if (columns.length > 0) {
      outcome.title = columns.map((c, i) => (attempt.types?.[i] ? `${c} ${attempt.types[i]}` : c)).join(", ");
    }
  } else {
    const message = attempt.error ?? (attempt.outcome === "error" ? "The query failed." : "Not run.");
    outcome.textContent = `${attempt.outcome}: ${preview(message)}`;
    outcome.title = message;
  }
  const head = el(
    "div",
    { className: "trace-head" },
    el("span", { className: "trace-label" }, el("strong", { text: `Query ${index}` }), " · ", outcome),
    el("span", { className: "trace-meta", text: `Queries remaining: ${remainingText(remainingAfter)}` }),
  );
  const sql = el("code", { className: "trace-sql", text: attempt.sql.replace(/\s+/g, " ").trim(), title: attempt.sql });
  return step(`is-${attempt.outcome}`, head, sql);
}

function finalStep(p: Extract<LoopProgress, { kind: "final" }>): HTMLLIElement {
  const label = el("span", { className: "trace-label" }, el("strong", { text: "Final query:" }), " ");
  if (p.refused === undefined) {
    label.append(p.reusedAttempt === null ? "new, run once more" : `same as query ${p.reusedAttempt}`);
    return step("is-final", label);
  }
  label.append(
    el("span", { className: "trace-outcome", text: `refused: ${preview(p.refused)}`, title: p.refused }),
    " (not run)",
  );
  return step("is-refused", label);
}

export function createTrace(): Trace {
  const list = el("ol", { className: "trace-steps" });
  list.setAttribute("aria-live", "polite");
  const element = el("section", { className: "trace" }, el("h2", { text: "How this answer was found" }), list);
  element.hidden = true;

  let mappingRow: HTMLLIElement | null = null;
  const queryRows = new Map<number, HTMLLIElement>();
  /** "Thinking…" while the model decides, then the final query row. */
  let tailRow: HTMLLIElement | null = null;
  let failRow: HTMLLIElement | null = null;

  /**
   * Puts the rows in order, touching only the ones that changed, so the live
   * region announces new steps rather than the whole list again.
   */
  const render = (): void => {
    const queries = [...queryRows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
    const ordered = [mappingRow, ...queries, tailRow, failRow].filter((row): row is HTMLLIElement => row !== null);
    ordered.forEach((row, i) => {
      const current = list.children[i] ?? null;
      if (current !== row) list.insertBefore(row, current);
    });
    while (list.children.length > ordered.length) list.lastElementChild?.remove();
    element.hidden = false;
  };

  const reset = (): void => {
    mappingRow = null;
    queryRows.clear();
    tailRow = null;
    failRow = null;
    list.replaceChildren();
    element.hidden = true;
  };

  const update = (p: LoopProgress): void => {
    switch (p.kind) {
      case "mapping-start":
        reset();
        mappingRow = step("is-pending", "Predicting which columns the question needs (Jev)…");
        break;
      case "mapping-done":
        mappingRow = mappingStep(p.mapping, p.ms);
        break;
      case "step-start":
        tailRow = step("is-pending", `Thinking… (queries remaining: ${remainingText(p.remaining)})`);
        break;
      case "attempt-start":
        tailRow = step("is-pending", `Running query ${p.index} in your browser…`);
        break;
      case "attempt-done":
        queryRows.set(p.index, queryStep(p.index, p.attempt, p.remainingAfter));
        tailRow = null;
        break;
      case "final":
        tailRow = finalStep(p);
        break;
    }
    render();
  };

  const fail = (message: string): void => {
    const row = step(
      "is-failed",
      el(
        "span",
        { className: "trace-label" },
        el("strong", { text: "Stopped:" }),
        " ",
        el("span", { className: "trace-outcome", text: preview(message), title: message }),
      ),
    );
    if (mappingRow?.classList.contains("is-pending")) mappingRow = row;
    else if (tailRow?.classList.contains("is-pending")) tailRow = row;
    else failRow = row;
    render();
  };

  return { element, update, fail, reset };
}
