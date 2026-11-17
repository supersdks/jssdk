const ALLOWED_FIELDS = new Set([
  'category', 'code', 'attempt', 'pending', 'sent', 'discarded', 'retrying',
  'persistent', 'baseUrlIndex', 'latencyBucket', 'reason', 'sessionId', 'pageId',
  'requestId', 'api', 'event', 'state', 'outcome', 'protocol', 'container', 'errorClass'
]);

export function createDiagnostics(options = {}) {
  const listeners = new Set();
  let last = null;
  if (typeof options.sink === 'function') listeners.add(options.sink);

  function emit(level, detail = {}) {
    const safe = { level: normalizeLevel(level), at: Date.now() };
    for (const [key, value] of Object.entries(detail)) {
      if (ALLOWED_FIELDS.has(key) && isSafeValue(value)) safe[key] = value;
    }
    last = Object.freeze(safe);
    const failed = new Set();
    for (const listener of [...listeners]) {
      try { listener(last); } catch { failed.add(listener); }
    }
    if (failed.size) reportSinkError(failed);
    return last;
  }

  function reportSinkError(failed) {
    const safe = Object.freeze({ level: 'warn', at: Date.now(), category: 'diagnostic', outcome: 'sink_error' });
    last = safe;
    for (const listener of [...listeners]) {
      if (failed.has(listener)) continue;
      try { listener(safe); } catch { /* terminal non-recursive diagnostics boundary */ }
    }
  }

  return Object.freeze({
    emit,
    getLast: () => last,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('diagnostic listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });
}

function normalizeLevel(level) {
  return level === 'error' || level === 'warn' ? level : 'info';
}

function isSafeValue(value) {
  return value == null || typeof value === 'boolean' || typeof value === 'number' ||
    (typeof value === 'string' && value.length <= 80);
}
