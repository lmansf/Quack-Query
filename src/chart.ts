/**
 * Small inline-SVG charts for two-column query results: bars for categories
 * (horizontal past 12 of them), a line when x is a date. DOM APIs only, no
 * chart library; every label goes through textContent.
 */
import type { QueryResult } from './duck';

export interface ChartPoint { x: string; y: number }

export interface ChartSpec {
  /** `line` when every x value is an ISO date/timestamp (sorted ascending); `bar` otherwise. */
  kind: 'bar' | 'line';
  xLabel: string;
  yLabel: string;
  points: ChartPoint[];
  /** Bar charts with more than 12 categories are drawn as horizontal bars. */
  horizontal: boolean;
  /** Rows dropped because y was null or unparseable. */
  dropped: number;
}

const NS = 'http://www.w3.org/2000/svg';
const CHAR_W = 6.5;
const ACCENT = 'var(--accent, #b45309)';
const MUTED = 'var(--muted, #6b7280)';
const BORDER = 'var(--border, #e5e7eb)';
const TEXT = 'var(--fg, #111827)';
const SURFACE = 'var(--card, #ffffff)';
const NUM_RE = /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const CSS = `.chart-svg{display:block;width:100%;height:auto;font-family:inherit;font-size:11px;overflow:visible}
.chart-svg text{font-variant-numeric:tabular-nums}.chart-svg .mark{transition:opacity .12s}
.chart-svg.hovering .mark:not(.hover){opacity:.6}.chart-svg:focus,.chart-svg .hit{outline:none}
.chart-svg .hit:focus-visible{stroke:${ACCENT};stroke-width:2}`;

const isNull = (v: unknown): boolean => v === null || v === undefined;

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && NUM_RE.test(v)) return Number(v);
  return null;
}

function stringify(v: unknown): string {
  if (isNull(v)) return 'NULL';
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== 'object') return String(v);
  try { return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)); } catch { return String(v); }
}

/** Column shape from its non-null cells: ISO dates, numbers, or anything else. */
function classify(cells: unknown[]): 'numeric' | 'date' | 'other' {
  const present = cells.filter((c) => !isNull(c));
  if (present.length === 0) return 'other';
  if (present.every((c) => typeof c === 'string' && DATE_RE.test(c))) return 'date';
  return present.every((c) => toNumber(c) !== null) ? 'numeric' : 'other';
}

/** Chart plan for a result, or null when it is not a two-column x/y shape. */
export function chartSpec(result: QueryResult): ChartSpec | null {
  const { columns, rows } = result;
  if (columns.length !== 2 || rows.length < 2) return null;
  const kinds = [0, 1].map((i) => classify(rows.map((r) => r[i])));
  const yi = kinds[1] === 'numeric' ? 1 : kinds[0] === 'numeric' ? 0 : -1;
  if (yi < 0) return null;
  const xi = 1 - yi;
  const isLine = kinds[xi] === 'date';
  let dropped = 0;
  const points: ChartPoint[] = [];
  for (const r of rows.slice(0, 500)) {
    const y = toNumber(r[yi]);
    if (y === null || (isLine && isNull(r[xi]))) dropped++;
    else points.push({ x: stringify(r[xi]), y });
  }
  if (points.length < 2) return null;
  if (isLine) points.sort((a, b) => (a.x < b.x ? -1 : a.x > b.x ? 1 : 0));
  const kind = isLine ? 'line' : 'bar';
  return { kind, xLabel: columns[xi], yLabel: columns[yi], points, horizontal: !isLine && points.length > 12, dropped };
}

/** Thousands separators, up to 2 decimals; k/M/B suffixes when `compact`. */
export function formatNumber(v: number, compact = true): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  const units: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
  for (const [d, s] of units) {
    if (!compact || a < d * 0.9995) continue;
    const q = a / d;
    return `${(v / d).toLocaleString('en-US', { maximumFractionDigits: q >= 100 ? 0 : q >= 10 ? 1 : 2 })}${s}`;
  }
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** 4-6 ticks on a 1/2/5 step that cover [lo, hi]. */
function niceTicks(lo: number, hi: number): { ticks: number[]; step: number } {
  if (lo === hi) [lo, hi] = [Math.min(lo, 0), Math.max(hi, 0)];
  if (lo === hi) hi = 1;
  const raw = (hi - lo) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  const step = p * (m >= 7.07 ? 10 : m >= 3.16 ? 5 : m >= 1.41 ? 2 : 1);
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let i = 0; !ticks.length || ticks[ticks.length - 1] < hi; i++) ticks.push(Number((start + i * step).toPrecision(12)));
  return { ticks, step };
}

/** Bars always grow from zero; a line includes zero only when it is close to the data. */
function domain(kind: ChartSpec['kind'], ys: number[]): [number, number] {
  let [lo, hi] = [Math.min(...ys), Math.max(...ys)];
  if (kind === 'bar' || (lo > 0 && lo <= hi / 2)) lo = Math.min(lo, 0);
  if (kind === 'bar' || (hi < 0 && hi >= lo / 2)) hi = Math.max(hi, 0);
  return [lo, hi];
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const widest = (strs: string[]): number => Math.max(0, ...strs.map((s) => s.length)) * CHAR_W;
const truncate = (s: string, max: number): string => (s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s);

/** Bar outline with 4px rounded corners on the data end only, square at the baseline. */
function barPath(x: number, y: number, w: number, h: number, end: 'top' | 'bottom' | 'left' | 'right'): string {
  const r = r2(Math.min(4, w / 2, h / 2));
  const [X, Y] = [r2(x + w), r2(y + h)];
  [x, y] = [r2(x), r2(y)];
  switch (end) {
    case 'top': return `M${x},${Y}V${y + r}Q${x},${y} ${x + r},${y}H${X - r}Q${X},${y} ${X},${y + r}V${Y}Z`;
    case 'bottom': return `M${x},${y}V${Y - r}Q${x},${Y} ${x + r},${Y}H${X - r}Q${X},${Y} ${X},${Y - r}V${y}Z`;
    case 'right': return `M${x},${y}H${X - r}Q${X},${y} ${X},${y + r}V${Y - r}Q${X},${Y} ${X - r},${Y}H${x}Z`;
    default: return `M${X},${y}H${x + r}Q${x},${y} ${x},${y + r}V${Y - r}Q${x},${Y} ${x + r},${Y}H${X}Z`;
  }
}

function el<K extends keyof SVGElementTagNameMap>(
  parent: Node, name: K, attrs: Record<string, string | number> = {}, content?: string,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'number' ? String(r2(v)) : v);
  if (content !== undefined) e.textContent = content;
  parent.appendChild(e);
  return e;
}

function text(parent: Node, x: number, y: number, s: string, anchor: string, fill: string, baseline = 'auto'): SVGTextElement {
  return el(parent, 'text', { x, y, fill, 'text-anchor': anchor, 'dominant-baseline': baseline }, s);
}

interface Tip { node: HTMLElement; show(p: ChartPoint, clientX: number, clientY: number): void; hide(): void }

function makeTip(root: HTMLElement, spec: ChartSpec): Tip {
  const node = document.createElement('div');
  node.className = 'chart-tooltip';
  node.hidden = true;
  Object.assign(node.style, {
    position: 'absolute', left: '0', top: '0', zIndex: '2', pointerEvents: 'none', whiteSpace: 'nowrap',
    padding: '6px 9px', borderRadius: '6px', fontSize: '12px', lineHeight: '1.4', background: SURFACE,
    color: TEXT, border: `1px solid ${BORDER}`, boxShadow: '0 2px 8px rgba(0,0,0,.08)',
  });
  const value = document.createElement('strong');
  const unit = document.createElement('span');
  unit.style.color = MUTED;
  unit.textContent = ` ${spec.yLabel}`;
  const head = document.createElement('div');
  head.append(value, unit);
  const cat = document.createElement('div');
  cat.style.color = MUTED;
  node.append(head, cat);
  const show = (p: ChartPoint, clientX: number, clientY: number): void => {
    value.textContent = formatNumber(p.y, false);
    cat.textContent = p.x;
    node.hidden = false;
    const r = root.getBoundingClientRect();
    let [x, y] = [clientX - r.left + 12, clientY - r.top + 12];
    if (x + node.offsetWidth > r.width) x = Math.max(0, clientX - r.left - 12 - node.offsetWidth);
    if (y + node.offsetHeight > r.height) y = Math.max(0, clientY - r.top - 12 - node.offsetHeight);
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
  };
  return { node, show, hide: () => { node.hidden = true; } };
}

/** Per-bar hover and keyboard focus: highlight the mark, show the tooltip. */
function bindBar(svg: SVGSVGElement, hit: SVGRectElement, mark: SVGPathElement, p: ChartPoint, tip: Tip): void {
  const on = (cx: number, cy: number): void => { svg.classList.add('hovering'); mark.classList.add('hover'); tip.show(p, cx, cy); };
  const off = (): void => { svg.classList.remove('hovering'); mark.classList.remove('hover'); tip.hide(); };
  hit.addEventListener('pointermove', (e) => on(e.clientX, e.clientY));
  hit.addEventListener('pointerleave', off);
  hit.addEventListener('focus', () => { const r = mark.getBoundingClientRect(); on(r.left + r.width / 2, r.top); });
  hit.addEventListener('blur', off);
}

/** A `div.chart` holding the SVG and its tooltip layer; redrawn at the container's pixel width. */
export function renderChart(spec: ChartSpec): HTMLElement {
  const root = document.createElement('div');
  root.className = 'chart';
  root.style.position = 'relative';
  const tip = makeTip(root, spec);
  root.appendChild(tip.node);
  let svg: SVGSVGElement | null = null;
  const kind = spec.kind === 'bar' ? 'Bar' : 'Line';
  const build = (width: number): void => {
    tip.hide();
    const next = el(root, 'svg', {
      class: 'chart-svg', width: '100%', role: 'img',
      'aria-label': `${kind} chart of ${spec.yLabel} by ${spec.xLabel}, ${spec.points.length} points`,
    });
    el(next, 'style', {}, CSS);
    if (spec.horizontal) drawHorizontal(spec, next, tip, width);
    else drawVertical(spec, next, tip, width);
    if (svg) svg.replaceWith(next);
    else root.prepend(next);
    svg = next;
  };
  build(640);
  if (typeof ResizeObserver !== 'undefined') {
    let last = 640;
    new ResizeObserver((entries) => {
      const w = Math.max(320, Math.round(entries[0]?.contentRect.width ?? 0));
      if (entries[0]?.contentRect.width && w !== last) { last = w; build(w); }
    }).observe(root);
  }
  return root;
}

/** Vertical bars (<= 12 categories) or a line over dates. */
function drawVertical(spec: ChartSpec, svg: SVGSVGElement, tip: Tip, W: number): void {
  const { points } = spec;
  const n = points.length;
  const isBar = spec.kind === 'bar';
  const [lo, hi] = domain(spec.kind, points.map((p) => p.y));
  const { ticks, step } = niceTicks(lo, hi);
  const [d0, d1] = [ticks[0], ticks[ticks.length - 1]];
  const tickText = ticks.map((t) => formatNumber(t, step >= 1000));
  const labels = points.map((p) => p.x);
  const labelW = Math.min(widest(labels), 120);
  const [top, right] = [28, 16];
  let left = Math.min(W * 0.4, widest(tickText) + 12);
  let band = (W - left - right) / n;
  // Category labels that do not fit their band are rotated 45deg; the margins grow to hold them.
  const rotate = isBar && labelW > band - 6;
  if (rotate) {
    left = Math.min(W * 0.4, Math.max(left, labelW * 0.71 - band / 2 + 4));
    band = (W - left - right) / n;
  }
  const pad = isBar && lo < 0 ? 12 : 0; // room for a direct label under a negative bar
  const bottom = (rotate ? 34 + labelW * 0.72 : 44) + pad;
  const H = 280 + (rotate ? bottom - 44 : pad);
  const [pw, ph] = [W - left - right, H - top - bottom];
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const sy = (v: number): number => top + ((d1 - v) / (d1 - d0)) * ph;
  const cx = (i: number): number => left + band * (i + 0.5);

  ticks.forEach((t, i) => {
    const y = sy(t);
    el(svg, 'line', { x1: left, x2: left + pw, y1: y, y2: y, stroke: t === 0 ? MUTED : BORDER });
    text(svg, left - 8, y, tickText[i], 'end', MUTED, 'central');
  });
  text(svg, 0, 12, spec.yLabel, 'start', MUTED);
  text(svg, left + pw / 2, H - 6, spec.xLabel, 'middle', MUTED);

  // X labels: every category for bars. For lines, keep the first and last dates and spread as
  // many evenly between them as fit without touching, snapped to the nearest point.
  const maxChars = Math.floor((rotate ? 120 : isBar ? band - 6 : 200) / CHAR_W);
  const box = (i: number): [number, number, string] => {
    const [x, w] = [cx(i), truncate(labels[i], maxChars).length * CHAR_W];
    if (x - w / 2 < 2) return [x, x + w, 'start'];
    return x + w / 2 > W - 2 ? [x - w, x, 'end'] : [x - w / 2, x + w / 2, 'middle'];
  };
  const shown: number[] = isBar ? labels.map((_, i) => i) : [0];
  const push = (i: number): void => {
    while (shown.length && box(i)[0] < box(shown[shown.length - 1])[1] + 8) {
      if (i === n - 1) shown.pop();
      else return;
    }
    shown.push(i);
  };
  if (!isBar) {
    const w = Math.min(widest(labels), maxChars * CHAR_W);
    const [e0, s1] = [box(0)[1], box(n - 1)[0]];
    const m = Math.max(0, Math.floor((s1 - e0 - 10) / (w + 10)));
    const slack = s1 - e0 - 10 - m * (w + 10);
    for (let j = 1; j <= m; j++) {
      const c = e0 + 10 + (j - 1) * (w + 10) + (j * slack) / (m + 1) + w / 2;
      push(Math.max(1, Math.min(n - 2, Math.round((c - left) / band - 0.5))));
    }
    push(n - 1);
  }
  const ax = top + ph;
  for (const i of shown) {
    const [x, label, anchor] = [cx(i), truncate(labels[i], maxChars), box(i)[2]];
    el(svg, 'line', { x1: x, x2: x, y1: ax, y2: ax + 4, stroke: BORDER });
    if (rotate) text(svg, x, ax + 12 + pad, label, 'end', MUTED).setAttribute('transform', `rotate(-45 ${r2(x)} ${ax + 12 + pad})`);
    else text(svg, x, ax + 16 + pad, label, anchor, MUTED);
  }

  const marks = el(svg, 'g');
  if (isBar) {
    const hits = el(svg, 'g');
    const y0 = sy(0);
    const bw = Math.max(1, Math.min(24, band * 0.7, band - 2));
    let [iMax, iMin] = [0, 0];
    points.forEach((p, i) => {
      if (p.y > points[iMax].y) iMax = i;
      if (p.y < points[iMin].y) iMin = i;
      const [x, y] = [cx(i) - bw / 2, sy(p.y)];
      const d = p.y >= 0 ? barPath(x, y, bw, y0 - y, 'top') : barPath(x, y0, bw, y - y0, 'bottom');
      const mark = el(marks, 'path', { d, fill: ACCENT, class: 'mark' });
      const hit = el(hits, 'rect', { x: left + band * i, y: top, width: band, height: ph, fill: 'transparent', class: 'hit', tabindex: 0 });
      el(hit, 'title', {}, `${p.x}: ${formatNumber(p.y, false)} ${spec.yLabel}`);
      bindBar(svg, hit, mark, p, tip);
    });
    // Selective direct labels: the extreme(s) only; the axis and tooltip carry the rest.
    const label = (i: number, dy: number): void => {
      text(svg, cx(i), sy(points[i].y) + dy, formatNumber(points[i].y, false), 'middle', TEXT).setAttribute('font-weight', '500');
    };
    if (points[iMax].y > 0) label(iMax, -5);
    if (points[iMin].y < 0) label(iMin, 13);
    return;
  }

  const px = points.map((p, i) => [cx(i), sy(p.y)] as const);
  el(marks, 'path', {
    d: px.map(([x, y], i) => `${i ? 'L' : 'M'}${r2(x)},${r2(y)}`).join(''),
    fill: 'none', stroke: ACCENT, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  });
  if (n <= 60) for (const [x, y] of px) el(marks, 'circle', { cx: x, cy: y, r: 4, fill: ACCENT, stroke: SURFACE, 'stroke-width': 2 });
  // Crosshair snaps to the nearest x; arrow keys walk the points when the chart is focused.
  const cross = el(svg, 'line', { y1: top, y2: ax, stroke: MUTED, visibility: 'hidden' });
  const dot = el(svg, 'circle', { r: 5, fill: ACCENT, stroke: SURFACE, 'stroke-width': 2, visibility: 'hidden' });
  let cur = -1;
  const show = (i: number, e?: PointerEvent): void => {
    cur = Math.max(0, Math.min(n - 1, i));
    const [x, y] = px[cur];
    for (const [g, attrs] of [[cross, { x1: x, x2: x }], [dot, { cx: x, cy: y }]] as const) {
      for (const [a, v] of Object.entries({ ...attrs, visibility: 'visible' })) g.setAttribute(a, typeof v === 'number' ? String(r2(v)) : v);
    }
    const r = svg.getBoundingClientRect();
    tip.show(points[cur], e ? e.clientX : r.left + (x * r.width) / W, e ? e.clientY : r.top + (y * r.height) / H);
  };
  const hide = (): void => { cur = -1; for (const g of [cross, dot]) g.setAttribute('visibility', 'hidden'); tip.hide(); };
  svg.setAttribute('tabindex', '0');
  svg.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    show(Math.round((((e.clientX - r.left) / r.width) * W - left) / band - 0.5), e);
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(n - 1));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    const d = ({ ArrowLeft: -1, ArrowRight: 1 } as Record<string, number>)[e.key] ?? 0;
    if (d) { e.preventDefault(); show(cur + d); }
  });
}

/** Horizontal bars for many categories: one 22px row each, labels on the left. */
function drawHorizontal(spec: ChartSpec, svg: SVGSVGElement, tip: Tip, W: number): void {
  const { points } = spec;
  const n = points.length;
  const [lo, hi] = domain('bar', points.map((p) => p.y));
  const { ticks, step } = niceTicks(lo, hi);
  const [d0, d1] = [ticks[0], ticks[ticks.length - 1]];
  const [rowH, top, bottom, right] = [22, 28, 44, 24];
  const left = Math.min(W * 0.4, widest(points.map((p) => p.x)) + 12);
  const H = Math.max(160, n * rowH + top + bottom);
  const [pw, ph] = [W - left - right, n * rowH];
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const sx = (v: number): number => left + ((v - d0) / (d1 - d0)) * pw;
  const cy = (i: number): number => top + rowH * (i + 0.5);

  for (const t of ticks) {
    const x = sx(t);
    el(svg, 'line', { x1: x, x2: x, y1: top, y2: top + ph, stroke: t === 0 ? MUTED : BORDER });
    text(svg, x, top + ph + 16, formatNumber(t, step >= 1000), 'middle', MUTED);
  }
  text(svg, 0, 12, spec.xLabel, 'start', MUTED);
  text(svg, left + pw / 2, H - 6, spec.yLabel, 'middle', MUTED);

  const maxChars = Math.floor((left - 12) / CHAR_W);
  const bw = Math.min(24, rowH * 0.7);
  const x0 = sx(0);
  const marks = el(svg, 'g');
  const hits = el(svg, 'g');
  points.forEach((p, i) => {
    text(svg, left - 8, cy(i), truncate(p.x, maxChars), 'end', MUTED, 'central');
    const [x, y] = [sx(p.y), cy(i) - bw / 2];
    const d = p.y >= 0 ? barPath(x0, y, x - x0, bw, 'right') : barPath(x, y, x0 - x, bw, 'left');
    const mark = el(marks, 'path', { d, fill: ACCENT, class: 'mark' });
    const hit = el(hits, 'rect', { x: left, y: top + rowH * i, width: pw, height: rowH, fill: 'transparent', class: 'hit', tabindex: 0 });
    el(hit, 'title', {}, `${p.x}: ${formatNumber(p.y, false)} ${spec.yLabel}`);
    bindBar(svg, hit, mark, p, tip);
  });
}
