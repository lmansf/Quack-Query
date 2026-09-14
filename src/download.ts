/**
 * Browser download helpers: hand a byte array to the user as a file, and build
 * a tidy, timestamped file name for it.
 */

/**
 * Triggers a browser download of `bytes` under `fileName`. Creates a Blob and
 * an object URL, clicks a temporary `<a download>` and revokes the URL shortly
 * afterwards (revoking synchronously can cancel the download in some browsers).
 */
export function downloadBytes(fileName: string, bytes: Uint8Array, mimeType: string): void {
  // Copy into a plain ArrayBuffer-backed view: Blob rejects SharedArrayBuffer-
  // backed views at the type level, and Wasm memory may be one.
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local-time stamp `YYYYMMDD-HHMM`. */
function timestamp(d = new Date()): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

/**
 * Builds a download file name from a free-form base (a question, "query", ...):
 * lower-cased, reduced to `[a-z0-9_-]` with runs collapsed to a single `-`,
 * trimmed to 40 characters (falling back to "query" when nothing is left),
 * then suffixed with `-YYYYMMDD-HHMM` in local time and the format extension.
 *
 * `exportFileName('Top sellers, by month?', 'csv')` -> `top-sellers-by-month-20260914-1530.csv`
 */
export function exportFileName(base: string, format: 'csv' | 'parquet'): string {
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  if (!slug) slug = 'query';
  return `${slug}-${timestamp()}.${format}`;
}
