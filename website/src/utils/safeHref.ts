/**
 * Sanitize a value before it is used as an anchor `href`.
 *
 * Nav hrefs in this app come from a developer-defined, privilege-filtered route
 * table (not user input), so they are not an attacker-controlled XSS vector
 * today. This is defense-in-depth: it guarantees a `javascript:`, `data:` or
 * `vbscript:` scheme can never reach the DOM via an href even if a future
 * change starts sourcing nav entries from dynamic/remote data. Anything that is
 * not a safe relative path or http(s)/mailto/tel URL collapses to '#'.
 */
const SAFE_ABSOLUTE = /^(https?:|mailto:|tel:)/i;

export function safeHref(href?: string | null): string {
  if (!href) return '#';
  const v = String(href).trim();
  // Relative paths and in-page anchors are always safe.
  if (v.startsWith('/') || v.startsWith('#') || v.startsWith('?') || v.startsWith('.')) {
    // Reject a sneaky scheme hidden after leading chars, e.g. "/\tjavascript:".
    return /^[/#?.]/.test(v) && !/[\x00-\x1f]/.test(v) ? v : '#';
  }
  // Absolute URLs: allow only an explicit safe scheme.
  if (SAFE_ABSOLUTE.test(v)) return v;
  // Everything else (javascript:, data:, vbscript:, scheme-relative //evil, …) -> '#'.
  return '#';
}
