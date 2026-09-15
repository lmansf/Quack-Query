/**
 * Dependency-free `.xlsx` / `.xlsm` reader for the browser.
 *
 * Turns every non-empty worksheet into RFC 4180 CSV text so DuckDB can ingest
 * it with `read_csv_auto`. Only web platform APIs are used: the zip container
 * is walked by hand and entries are inflated with
 * `DecompressionStream("deflate-raw")`, XML parts are parsed with `DOMParser`.
 *
 * Supported: shared / inline / formula strings, booleans, errors (blank),
 * numbers, and date/time cells (detected from the cell style's number format
 * and rendered as `YYYY-MM-DD`, `YYYY-MM-DD HH:MM:SS` or `HH:MM:SS`).
 * Ignored: merged cells, formulas (cached values are used), comments, drawings.
 */

/** One worksheet rendered as CSV. `rowCount` excludes the header row. */
export interface XlsxSheet {
  name: string;
  csv: string;
  rowCount: number;
  columnCount: number;
}

const NOT_XLSX =
  "Not an .xlsx file (expected a zip container). Legacy .xls files must be saved as .xlsx first.";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Zip container
// ---------------------------------------------------------------------------

interface ZipEntry {
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

/** Minimal zip reader: central directory lookup plus stored/deflate entries. */
class ZipArchive {
  private readonly entries = new Map<string, ZipEntry>();
  private readonly view: DataView;

  constructor(private readonly buffer: ArrayBuffer) {
    const bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error(NOT_XLSX);

    // End Of Central Directory record; may be followed by a comment of up to 64 KiB.
    let eocd = -1;
    for (let i = bytes.length - 22, stop = Math.max(0, i - 0xffff); i >= stop; i--) {
      if (this.view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("Corrupt .xlsx file: zip end-of-central-directory record not found.");
    const count = this.view.getUint16(eocd + 10, true);
    const cdOffset = this.view.getUint32(eocd + 16, true);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("ZIP64 .xlsx files are not supported.");

    const decoder = new TextDecoder();
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > bytes.length || this.view.getUint32(p, true) !== 0x02014b50) {
        throw new Error("Corrupt .xlsx file: bad zip central directory entry.");
      }
      const method = this.view.getUint16(p + 10, true);
      const compressedSize = this.view.getUint32(p + 20, true);
      const uncompressedSize = this.view.getUint32(p + 24, true);
      const nameLen = this.view.getUint16(p + 28, true);
      const extraLen = this.view.getUint16(p + 30, true);
      const commentLen = this.view.getUint16(p + 32, true);
      const localHeaderOffset = this.view.getUint32(p + 42, true);
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new Error("ZIP64 .xlsx files are not supported.");
      }
      const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      this.entries.set(name, { method, compressedSize, localHeaderOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Returns the decoded UTF-8 text of an entry, or `undefined` if absent. */
  async text(name: string): Promise<string | undefined> {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    const h = entry.localHeaderOffset;
    if (h + 30 > this.buffer.byteLength || this.view.getUint32(h, true) !== 0x04034b50) {
      throw new Error(`Corrupt .xlsx file: bad local header for ${name}.`);
    }
    const start = h + 30 + this.view.getUint16(h + 26, true) + this.view.getUint16(h + 28, true);
    const end = start + entry.compressedSize;
    if (end > this.buffer.byteLength) throw new Error(`Corrupt .xlsx file: truncated entry ${name}.`);
    const raw = this.buffer.slice(start, end);
    let data: ArrayBuffer;
    if (entry.method === 0) {
      data = raw;
    } else if (entry.method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      data = await new Response(stream).arrayBuffer();
    } else {
      throw new Error(`Unsupported zip compression method ${entry.method} for ${name}.`);
    }
    return new TextDecoder().decode(data);
  }
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function parseXml(text: string, part: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error(`Corrupt .xlsx file: could not parse ${part}.`);
  }
  return doc;
}

/** Namespace-agnostic element lookup (some producers prefix every tag). */
function byName(root: Document | Element, localName: string): HTMLCollectionOf<Element> {
  return root.getElementsByTagNameNS("*", localName);
}

/** Concatenates all `<t>` descendants (rich text runs), skipping phonetic hints. */
function textOf(el: Element): string {
  const parts: string[] = [];
  for (const t of byName(el, "t")) {
    if (t.parentElement?.localName === "rPh") continue;
    parts.push(t.textContent ?? "");
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Styles: which cell formats are dates / times
// ---------------------------------------------------------------------------

type DateKind = "none" | "date" | "datetime" | "time";

function builtinKind(numFmtId: number): DateKind {
  if (numFmtId === 22) return "datetime";
  if (numFmtId >= 14 && numFmtId <= 17) return "date";
  if ((numFmtId >= 18 && numFmtId <= 21) || (numFmtId >= 45 && numFmtId <= 47)) return "time";
  return "none";
}

/** Classifies a custom number format code by the date/time tokens it contains. */
function classifyFormatCode(code: string): DateKind {
  const bare = code
    .replace(/"[^"]*"/g, "") // literal text
    .replace(/\[[^\]]*\]/g, "") // colours, locales, conditions, elapsed [h]
    .replace(/\\./g, "") // escaped characters
    .replace(/[_*]./g, "") // padding / fill characters
    .toLowerCase();
  const hasTime = /[hs]/.test(bare);
  const hasDate = /[yd]/.test(bare) || (/m/.test(bare) && !hasTime);
  if (hasDate && hasTime) return "datetime";
  if (hasDate) return "date";
  if (hasTime) return "time";
  return "none";
}

/** Returns the DateKind for each `<cellXfs>` style index. */
function parseStyles(doc: Document): DateKind[] {
  const custom = new Map<number, DateKind>();
  for (const fmt of byName(doc, "numFmt")) {
    const id = Number(fmt.getAttribute("numFmtId"));
    if (Number.isFinite(id)) custom.set(id, classifyFormatCode(fmt.getAttribute("formatCode") ?? ""));
  }
  const kinds: DateKind[] = [];
  const cellXfs = byName(doc, "cellXfs")[0];
  if (!cellXfs) return kinds;
  for (const xf of cellXfs.children) {
    if (xf.localName !== "xf") continue;
    const id = Number(xf.getAttribute("numFmtId") ?? "0");
    kinds.push(custom.get(id) ?? builtinKind(id));
  }
  return kinds;
}

// ---------------------------------------------------------------------------
// Cell values
// ---------------------------------------------------------------------------

interface WorkbookContext {
  strings: string[];
  styles: DateKind[];
  date1904: boolean;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Converts an Excel serial number to an ISO-like date / datetime / time string. */
function formatSerial(serial: number, kind: DateKind, date1904: boolean): string {
  let days = Math.floor(serial);
  let secs = Math.round((serial - days) * 86_400);
  if (secs >= 86_400) {
    days += 1;
    secs = 0;
  }
  const hms = `${pad2(Math.floor(secs / 3600))}:${pad2(Math.floor(secs / 60) % 60)}:${pad2(secs % 60)}`;
  if (kind === "time") return hms;
  // Excel's 1900 calendar has a phantom Feb 29 1900; serials before it are off by one.
  if (!date1904 && days < 60) days += 1;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + days * DAY_MS);
  const ymd = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  return kind === "date" && secs === 0 ? ymd : `${ymd} ${hms}`;
}

/** Renders a `<c>` element as the text that should appear in the CSV. */
function cellValue(c: Element, wb: WorkbookContext): string {
  const type = c.getAttribute("t") ?? "n";
  if (type === "inlineStr") return textOf(c);
  let v = "";
  for (const child of c.children) {
    if (child.localName === "v") {
      v = child.textContent ?? "";
      break;
    }
  }
  switch (type) {
    case "s":
      return wb.strings[Number(v)] ?? "";
    case "str":
    case "d":
      return v;
    case "b":
      return v.trim() === "1" || v.trim().toLowerCase() === "true" ? "true" : "false";
    case "e":
      return "";
    default: {
      if (v === "") return "";
      const n = Number(v);
      if (!Number.isFinite(n)) return v;
      const styleIndex = Number(c.getAttribute("s") ?? "-1");
      const kind = wb.styles[styleIndex] ?? "none";
      return kind === "none" ? String(n) : formatSerial(n, kind, wb.date1904);
    }
  }
}

/** `"B3"` → 1, `"AA1"` → 26. */
function columnIndex(ref: string): number {
  let idx = 0;
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i);
    if (code < 65 || code > 90) break;
    idx = idx * 26 + (code - 64);
  }
  return idx - 1;
}

/** 0 → `"A"`, 26 → `"AA"`. */
function columnLetters(index: number): string {
  let s = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Sheet grid
// ---------------------------------------------------------------------------

/** Fills blank header cells with `column_<letter>` and de-duplicates names. */
function fixHeader(header: string[]): void {
  const seen = new Set<string>();
  for (let i = 0; i < header.length; i++) {
    let name = header[i] === "" ? `column_${columnLetters(i)}` : header[i];
    if (seen.has(name.toLowerCase())) {
      let n = 2;
      while (seen.has(`${name}_${n}`.toLowerCase())) n++;
      name = `${name}_${n}`;
    }
    seen.add(name.toLowerCase());
    header[i] = name;
  }
}

/** Builds a dense, rectangular grid from the sparse cells of a sheet part. */
function parseSheet(doc: Document, wb: WorkbookContext): string[][] {
  const sparseRows = new Map<number, string[]>();
  let minRow = Number.POSITIVE_INFINITY;
  let maxRow = -1;
  let maxCol = -1;
  let rowCursor = 0;
  for (const row of byName(doc, "row")) {
    const r = row.getAttribute("r");
    const rowIdx = r ? Number(r) - 1 : rowCursor;
    rowCursor = rowIdx + 1;
    let colCursor = 0;
    let cells: string[] | undefined;
    for (const c of row.children) {
      if (c.localName !== "c") continue;
      const ref = c.getAttribute("r");
      const col = ref ? columnIndex(ref) : colCursor;
      colCursor = col + 1;
      const value = cellValue(c, wb);
      if (value === "" || col < 0) continue;
      (cells ??= [])[col] = value;
      if (col > maxCol) maxCol = col;
    }
    if (cells) {
      sparseRows.set(rowIdx, cells);
      if (rowIdx < minRow) minRow = rowIdx;
      if (rowIdx > maxRow) maxRow = rowIdx;
    }
  }
  if (maxRow < 0) return [];
  const width = maxCol + 1;
  const grid: string[][] = [];
  for (let r = minRow; r <= maxRow; r++) {
    const sparse = sparseRows.get(r);
    const dense = new Array<string>(width);
    for (let col = 0; col < width; col++) dense[col] = sparse?.[col] ?? "";
    grid.push(dense);
  }
  fixHeader(grid[0]);
  return grid;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Serialises rows as RFC 4180 CSV: fields containing `,` `"` `\r` or `\n` are
 * quoted with embedded quotes doubled; records end with `\n`; `rows[0]` is the header.
 */
export function toCsv(rows: string[][]): string {
  const lines = new Array<string>(rows.length);
  for (let i = 0; i < rows.length; i++) lines[i] = rows[i].map(csvField).join(",");
  return lines.join("\n") + "\n";
}

/**
 * Parses an .xlsx/.xlsm file. Sheets with no cells are omitted. Throws a clear
 * Error for non-xlsx input (e.g. legacy .xls, .xlsb, or a corrupt zip).
 */
export async function xlsxToSheets(file: Blob): Promise<XlsxSheet[]> {
  const zip = new ZipArchive(await file.arrayBuffer());
  const workbookXml = await zip.text("xl/workbook.xml");
  if (workbookXml === undefined) {
    if (zip.has("xl/workbook.bin")) {
      throw new Error("Binary .xlsb workbooks are not supported. Save the file as .xlsx first.");
    }
    throw new Error("Not an .xlsx workbook: the archive has no xl/workbook.xml part.");
  }
  const workbook = parseXml(workbookXml, "xl/workbook.xml");
  const date1904 = /^(1|true)$/i.test(byName(workbook, "workbookPr")[0]?.getAttribute("date1904") ?? "");

  // r:id → part path, from the workbook relationships.
  const targets = new Map<string, string>();
  const relsXml = await zip.text("xl/_rels/workbook.xml.rels");
  if (relsXml !== undefined) {
    for (const rel of byName(parseXml(relsXml, "workbook.xml.rels"), "Relationship")) {
      const id = rel.getAttribute("Id");
      const target = rel.getAttribute("Target");
      if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    }
  }

  const strings: string[] = [];
  const sstXml = await zip.text("xl/sharedStrings.xml");
  if (sstXml !== undefined) {
    for (const si of byName(parseXml(sstXml, "xl/sharedStrings.xml"), "si")) strings.push(textOf(si));
  }
  const stylesXml = await zip.text("xl/styles.xml");
  const styles = stylesXml === undefined ? [] : parseStyles(parseXml(stylesXml, "xl/styles.xml"));
  const wb: WorkbookContext = { strings, styles, date1904 };

  const sheets: XlsxSheet[] = [];
  for (const sheet of byName(workbook, "sheet")) {
    const name = sheet.getAttribute("name") ?? `Sheet${sheets.length + 1}`;
    const rid = sheet.getAttribute("r:id") ?? sheet.getAttributeNS(REL_NS, "id");
    const part =
      (rid !== null ? targets.get(rid) : undefined) ?? `xl/worksheets/sheet${sheet.getAttribute("sheetId") ?? ""}.xml`;
    const xml = await zip.text(part);
    if (xml === undefined) continue;
    const rows = parseSheet(parseXml(xml, part), wb);
    if (rows.length === 0) continue;
    sheets.push({ name, csv: toCsv(rows), rowCount: rows.length - 1, columnCount: rows[0].length });
  }
  return sheets;
}
