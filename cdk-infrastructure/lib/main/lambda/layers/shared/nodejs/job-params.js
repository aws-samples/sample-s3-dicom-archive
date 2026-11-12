'use strict';

/**
 * Keys a caller may not put in processing-job params.
 *
 * Execute, chained stages and the scheduler build the runner/expander payload
 * from the caller's params plus system keys (jobId, parentJobId, target). The
 * runner loads the run named by jobId and uses that run's authorized scope, so a
 * param named jobId used to let a caller run on someone else's authorization.
 * Payloads now put the system keys last; this check refuses such params up
 * front so the request fails loudly instead of being silently rewritten.
 */
const RESERVED_PARAM_KEYS = new Set([
  'jobId', 'parentJobId', 'target', 'runId', 'executionId', 'scheduleId',
  'authorizedScope', '__proto__', 'constructor', 'prototype',
]);

/** Returns the first reserved key found in params, or null. */
function reservedParamKey(params) {
  if (params === null || params === undefined) return null;
  if (typeof params !== 'object' || Array.isArray(params)) return '(params must be an object)';
  for (const k of Object.keys(params)) if (RESERVED_PARAM_KEYS.has(k)) return k;
  return null;
}

module.exports = { RESERVED_PARAM_KEYS, reservedParamKey };
