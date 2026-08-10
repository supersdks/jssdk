const ALLOWED_FIELDS = new Set([
  'category', 'code', 'attempt', 'pending', 'sent', 'discarded', 'retrying',
  'persistent', 'baseUrlIndex', 'latencyBucket', 'reason'
]);

export function createDiagnostics() {
  const listeners = new Set();
  let last = null;

  function emit(level, detail = {}) {
    const safe = { level: normalizeLevel(level), at: Date.now() };
    for (const [key, value] of Object.entries(detail)) {
      if (ALLOWED_FIELDS.has(key) && isSafeValue(value)) safe[key] = value;
    }
    last = Object.freeze(safe);
    for (const listener of [...listeners]) {
      try { listener(last); } catch (_) { /* diagnostics must not break the SDK */ }
    }
    return last;
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
