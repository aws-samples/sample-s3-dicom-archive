/**
 * Sanitize a value before it is used as an anchor `href`. Defense-in-depth:
 * nav hrefs come from the app's own route table, not user input, but this
 * guarantees a `javascript:`, `data:` or `vbscript:` scheme can never reach the
 * DOM via href. Anything not a safe relative path or http(s)/mailto/tel URL
 * collapses to '#'.
 */
const SAFE_ABSOLUTE = /^(https?:|mailto:|tel:)/i;

export function safeHref(href?: string | null): string {
  if (!href) return '#';
  const v = String(href).trim();
  if (v.startsWith('/') || v.startsWith('#') || v.startsWith('?') || v.startsWith('.')) {
    return /^[/#?.]/.test(v) && !/[\x00-\x1f]/.test(v) ? v : '#';
  }
  if (SAFE_ABSOLUTE.test(v)) return v;
  return '#';
}
