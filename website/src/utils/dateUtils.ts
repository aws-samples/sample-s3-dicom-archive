/**
 * Ensures a timestamp string from the API (Aurora MySQL UTC) is parsed as UTC.
 * MySQL returns datetimes without timezone info (e.g. "2026-04-10 06:06:13").
 * This normalizes to ISO 8601 with Z suffix so new Date() parses as UTC.
 */
function ensureUtc(value: string): string {
  let s = value.trim();
  // Already has timezone info
  if (s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s)) return s;
  // Replace space separator with T for ISO 8601
  s = s.replace(' ', 'T');
  return s + 'Z';
}

/** Format an API timestamp as a localized date+time string in the user's timezone. */
export function formatTimestamp(value: string | undefined | null): string {
  if (!value) return '-';
  return new Date(ensureUtc(value)).toLocaleString();
}

/** Format an API timestamp as a localized date-only string in the user's timezone. */
export function formatTimestampDate(value: string | undefined | null): string {
  if (!value) return '-';
  return new Date(ensureUtc(value)).toLocaleDateString();
}

/** Format an API timestamp as a localized time-only string in the user's timezone. */
export function formatTimestampTime(value: string | undefined | null): string {
  if (!value) return '-';
  return new Date(ensureUtc(value)).toLocaleTimeString();
}

/** Parse an API timestamp as a UTC Date object. Useful for relative time calculations. */
export function parseUtcTimestamp(value: string): Date {
  return new Date(ensureUtc(value));
}
