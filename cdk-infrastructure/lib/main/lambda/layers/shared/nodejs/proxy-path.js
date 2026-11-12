// Shared path-parsing helpers for Lambda proxy integrations.
//
// The API Gateway routes for each logical group are collapsed into a single
// `{proxy+}` greedy resource plus an `ANY` method on the group base (see
// `lib/main/api-proxy-helper.ts`). Under `{proxy+}`, API Gateway no longer
// supplies named path parameters such as `{id}` or `{ruleId}` — instead the
// remainder of the path arrives in `event.pathParameters.proxy`. These helpers
// reconstruct the named segments handlers relied on, derived from the canonical
// `event.path` (with `pathParameters.proxy` / `requestContext.http.path` as
// fallbacks), so handler routing logic does not have to change shape.
//
// All API routes are served under `/api/...`; the leading `api` segment is
// stripped so callers get group-relative segments.

const RULE_COLLECTIONS = new Set(['rules', 'assignment-rules']);

/**
 * Return the path segments after the leading `/api` prefix.
 * e.g. `/api/users/123/reset-password` -> `['users', '123', 'reset-password']`
 * @param {object} event API Gateway proxy event
 * @returns {string[]}
 */
function getPathSegments(event) {
  if (!event || typeof event !== 'object') return [];

  const rawPath =
    event.path ||
    event.rawPath ||
    (event.requestContext && event.requestContext.http && event.requestContext.http.path) ||
    '';

  // Fallback: reconstruct from the resource template + proxy parameter when the
  // full path is not available (rare; REST proxy integration normally sets path).
  if (!rawPath && event.pathParameters && event.pathParameters.proxy) {
    const resource = String(event.resource || '');
    const base = resource
      .split('?')[0]
      .split('/')
      .filter(Boolean)
      .filter((s) => s !== 'api' && !s.startsWith('{'));
    const proxyParts = String(event.pathParameters.proxy)
      .split('?')[0]
      .split('/')
      .filter(Boolean);
    return [...base, ...proxyParts];
  }

  const segments = String(rawPath).split('?')[0].split('/').filter(Boolean);
  if (segments[0] === 'api') segments.shift();
  return segments;
}

/**
 * Parse a proxy event into the named segments handlers expect.
 * Layout: `/api/<group>/<id>/<sub>/<subId>`
 * @param {object} event API Gateway proxy event
 * @returns {{group: string|null, id: string|null, sub: string|null, subId: string|null, ruleId: string|null, segments: string[]}}
 */
function parseProxyPath(event) {
  const segments = getPathSegments(event);
  const [group, id, sub, subId] = segments;
  const ruleId = sub && RULE_COLLECTIONS.has(sub) ? subId || null : null;
  return {
    group: group || null,
    id: id || null,
    sub: sub || null,
    subId: subId || null,
    ruleId,
    segments,
  };
}

/**
 * Produce a `pathParameters`-shaped object that restores the named parameters
 * (`id`, `ruleId`, plus `sub`/`subId`) handlers relied on before the route was
 * collapsed to `{proxy+}`. Existing keys (such as `proxy`) are preserved.
 *
 * Intended use: assign once at the top of a handler so the rest of the handler's
 * `event.pathParameters?.id` / `.ruleId` reads keep working unchanged, e.g.
 *   event.pathParameters = normalizePathParameters(event);
 *
 * @param {object} event API Gateway proxy event
 * @returns {object}
 */
function normalizePathParameters(event) {
  const { id, ruleId, sub, subId } = parseProxyPath(event);
  const existing = (event && event.pathParameters) || {};
  return { ...existing, id, ruleId, sub, subId };
}

module.exports = { getPathSegments, parseProxyPath, normalizePathParameters };
