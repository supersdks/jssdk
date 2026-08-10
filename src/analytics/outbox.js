import { LIMITS } from '../core/limits.js';
import { utf8Bytes } from '../core/utils.js';

const DATABASE_PREFIX = 'supersdk_analytics_v2';
const STORE_NAME = 'events';

export function createMutationGate() {
  let tail = Promise.resolve();
  return Object.freeze({
    run(operation) {
      const result = tail.then(operation);
      tail = result.catch(() => undefined);
      return result;
    }
  });
}

export function createOutbox({ getConfig, indexedDBLike, diagnostics, canPersist = () => true }) {
  const events = new Map();
  let persistent = Boolean(indexedDBLike);
  let store = null;
  let activeNamespace = null;
  let ready = Promise.resolve();
  let opening = null;

  function namespace() {
    const config = getConfig?.();
    if (!config?.spid || !config?.environment) return null;
    return `${String(config.spid)}\u0000${String(config.environment)}`;
  }

  async function ensureReady({ open = true } = {}) {
    const nextNamespace = namespace();
    if (nextNamespace !== activeNamespace) {
      events.clear();
      try { store?.close?.(); } catch (_) { /* best effort */ }
      store = null;
      opening = null;
      ready = Promise.resolve();
      activeNamespace = nextNamespace;
    }
    if (!open || !persistent || !indexedDBLike || !canPersist() || !activeNamespace) return ready;
    if (store) return ready;
    if (!opening) {
      opening = hydrate(activeNamespace).finally(() => { opening = null; });
      ready = opening;
    }
    return ready;
  }

  async function hydrate(expectedNamespace) {
    try {
      const nextStore = await openStore(indexedDBLike, expectedNamespace);
      if (activeNamespace !== expectedNamespace) {
        nextStore.close?.();
        return;
      }
      store = nextStore;
      const existing = await nextStore.getAll();
      const capacity = getConfig()?.analytics.queueCapacity || LIMITS.analytics.queueCapacity;
      for (const event of existing.filter((item) => item.namespace === expectedNamespace).slice(-capacity)) {
        events.set(event.eventId, event);
      }
    } catch (_) {
      persistent = false;
      store = null;
      diagnostics.emit('warn', { category: 'outbox_storage', code: 'UNAVAILABLE', persistent: false });
    }
  }

  async function enqueue(event) {
    await ensureReady();
    // Freeze the queue budget before adding persistence-only metadata. Retry
    // counters and the storage namespace must never make an accepted event
    // become impossible to select later.
    const persistedEvent = { ...event, queueBytes: utf8Bytes(event), namespace: activeNamespace };
    const capacity = getConfig()?.analytics.queueCapacity || LIMITS.analytics.queueCapacity;
    if (!events.has(event.eventId) && events.size >= capacity) return false;
    events.set(event.eventId, persistedEvent);
    await persist('put', persistedEvent);
    return true;
  }

  async function selectBatch(now) {
    await ensureReady();
    const limits = getConfig()?.analytics || LIMITS.analytics;
    const selected = [];
    let bytes = 0;
    for (const event of [...events.values()].sort((a, b) => a.createdAtMs - b.createdAtMs)) {
      if (event.nextAttemptAtMs > now) continue;
      const eventBytes = Number.isInteger(event.queueBytes) && event.queueBytes > 0
        ? event.queueBytes
        : utf8Bytes(event);
      if (selected.length >= limits.batchSize || bytes + eventBytes > limits.maxBatchBytes) break;
      selected.push(event);
      bytes += eventBytes;
    }
    return selected;
  }

  async function remove(ids) {
    await ensureReady({ open: false });
    for (const id of ids) events.delete(id);
    if (store) {
      try { await store.remove(ids); } catch (_) { disablePersistence(); }
    }
  }

  async function update(items) {
    await ensureReady({ open: false });
    for (const event of items) events.set(event.eventId, event);
    if (store) {
      try { await store.putMany(items); } catch (_) { disablePersistence(); }
    }
  }

  async function clear() {
    await ensureReady({ open: false });
    events.clear();
    if (store) {
      try {
        await store.clear();
        store.close?.();
        store = null;
      } catch (_) { disablePersistence(); }
    } else if (indexedDBLike && activeNamespace) {
      try { await deleteStore(indexedDBLike, activeNamespace); } catch (_) { disablePersistence(); }
    }
  }

  async function persist(method, value) {
    if (!store) return;
    try { await store[method](value); } catch (_) { disablePersistence(); }
  }

  function disablePersistence() {
    persistent = false;
    store = null;
    diagnostics.emit('warn', { category: 'outbox_storage', code: 'UNAVAILABLE', persistent: false });
  }

  return Object.freeze({
    ready,
    enqueue,
    selectBatch,
    remove,
    update,
    clear,
    size: () => events.size,
    has: (id) => events.has(id),
    snapshot: () => [...events.values()].map((event) => ({ ...event })),
    isPersistent: () => persistent
  });
}

function databaseName(namespace) {
  return `${DATABASE_PREFIX}_${namespace.replace('\u0000', '_')}`;
}

function openStore(indexedDBLike, namespace) {
  return new Promise((resolve, reject) => {
    const request = indexedDBLike.open(databaseName(namespace), 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'eventId' });
    };
    request.onerror = () => reject(request.error || new Error('indexeddb open failed'));
    request.onsuccess = () => resolve(createStoreFacade(request.result));
  });
}

function deleteStore(indexedDBLike, namespace) {
  if (typeof indexedDBLike.deleteDatabase !== 'function') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = indexedDBLike.deleteDatabase(databaseName(namespace));
    request.onerror = () => reject(request.error || new Error('indexeddb delete failed'));
    request.onblocked = () => reject(new Error('indexeddb delete blocked'));
    request.onsuccess = () => resolve();
  });
}

function createStoreFacade(database) {
  function request(mode, action) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      let result;
      try { result = action(store); } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(result?.result);
      transaction.onerror = () => reject(transaction.error || result?.error || new Error('indexeddb transaction failed'));
      transaction.onabort = () => reject(transaction.error || new Error('indexeddb transaction aborted'));
    });
  }
  return Object.freeze({
    getAll: () => request('readonly', (store) => store.getAll()).then((value) => value || []),
    put: (event) => request('readwrite', (store) => store.put(event)),
    putMany: (events) => request('readwrite', (store) => { for (const event of events) store.put(event); }),
    remove: (ids) => request('readwrite', (store) => { for (const id of ids) store.delete(id); }),
    clear: () => request('readwrite', (store) => store.clear()),
    close: () => database.close?.()
  });
}
