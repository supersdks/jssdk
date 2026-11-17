const MAX_COUNT = 2147483647;

export function createMonitoringAggregator({ maxKeys, maxFingerprints }) {
  const values = new Map();
  const fingerprints = new Set();

  function add(tuple) {
    let safe = { ...tuple };
    let overflowed = false;
    if (safe.fingerprint && !fingerprints.has(safe.fingerprint)) {
      if (fingerprints.size >= maxFingerprints) { delete safe.fingerprint; overflowed = true; }
      else fingerprints.add(safe.fingerprint);
    }
    let key = stableKey(safe);
    let item = values.get(key);
    if (!item) {
      if (values.size >= Math.max(0, maxKeys - 1)) {
        safe = overflowTuple(safe);
        key = `__other:${safe.category}:${safe.signal}`;
        item = values.get(key);
        overflowed = true;
      }
      if (!item && values.size >= maxKeys) return 'rejected';
    }
    if (!item) {
      item = { tuple: safe, count: 0, dirty: 0 };
      values.set(key, item);
    }
    item.count = Math.min(MAX_COUNT, item.count + 1);
    item.dirty = Math.min(MAX_COUNT, item.dirty + 1);
    return overflowed ? 'other' : 'admitted';
  }

  function dirty(category) {
    return [...values.entries()].filter(([, item]) => item.dirty && (!category || item.tuple.category === category)).sort(([a], [b]) => a.localeCompare(b));
  }

  function consume(key) { const item = values.get(key); if (item) item.dirty = 0; }
  function clearCategory(category) { for (const [key, item] of values) if (item.tuple.category === category) values.delete(key); if (category === 'errors') fingerprints.clear(); }
  function resetPage() { fingerprints.clear(); }
  function snapshot() { return [...values.values()].map((item) => Object.freeze({ ...item.tuple, count: item.count })); }
  function clear() { values.clear(); fingerprints.clear(); }
  return Object.freeze({ add, dirty, consume, clearCategory, resetPage, snapshot, clear });
}

function stableKey(tuple) { return JSON.stringify(Object.keys(tuple).filter((key) => key !== 'count').sort().map((key) => [key, tuple[key]])); }
function overflowTuple(tuple) {
  if (tuple.signal === 'js_exception') return { category: 'errors', signal: tuple.signal, errorClass: 'unknown', locationClass: 'unknown' };
  if (tuple.signal === 'resource_error') return { category: 'errors', signal: tuple.signal, resourceClass: 'other', locationClass: 'unknown' };
  if (tuple.signal === 'unhandled_rejection') return { category: 'errors', signal: tuple.signal, errorClass: 'unknown' };
  if (tuple.signal === 'jsb_operation') return { category: tuple.category, signal: tuple.signal, api: 'other', outcome: tuple.category === 'errors' ? 'failure' : 'success', latencyBucket: 'unknown', ...(tuple.category === 'errors' ? { errorClass: 'unknown' } : {}) };
  return { ...tuple };
}
