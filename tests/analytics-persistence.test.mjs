import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox } from '../src/analytics/outbox.js';
import { createSuperSDK } from '../src/runtime/createSuperSDK.js';
import { LIMITS } from '../src/core/limits.js';
import { utf8Bytes } from '../src/core/utils.js';

function fakeIndexedDB() {
  const databases = new Map();
  let opens = 0;
  const api = {
    get opens() { return opens; },
    deleteDatabase(name) {
      const request = {};
      setTimeout(() => {
        databases.delete(name);
        request.onsuccess?.();
      }, 0);
      return request;
    },
    open(name) {
      opens += 1;
      const request = {};
      setTimeout(() => {
        let data = databases.get(name);
        const upgrade = !data;
        if (!data) { data = new Map(); databases.set(name, data); }
        const database = {
          objectStoreNames: { contains: (store) => store === 'events' },
          createObjectStore() {},
          transaction(_name, mode) {
            const transaction = {};
            const objectStore = {
              getAll() { return requestFor([...data.values()], transaction); },
              put(value) { data.set(value.eventId, structuredClone(value)); return requestFor(undefined, transaction); },
              delete(id) { data.delete(id); return requestFor(undefined, transaction); },
              clear() { data.clear(); return requestFor(undefined, transaction); }
            };
            transaction.objectStore = () => objectStore;
            return transaction;
          },
          close() {}
        };
        request.result = database;
        if (upgrade) request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    }
  };
  return api;
}

function requestFor(result, transaction) {
  const request = { result };
  setTimeout(() => transaction.oncomplete?.(), 0);
  return request;
}

function diagnostics() { return { emit() {} }; }
function config(spid, environment = 'prod') {
  return { spid, environment, analytics: LIMITS.analytics };
}
function event(eventId) {
  return { eventId, eventName: 'test', params: {}, createdAtMs: 1, nextAttemptAtMs: 1, attempts: 0 };
}

test('root ESM import and instance creation do not open IndexedDB', async () => {
  const indexedDB = fakeIndexedDB();
  const original = globalThis.indexedDB;
  globalThis.indexedDB = indexedDB;
  try {
    await import(`../src/index.js?lazy-outbox=${Date.now()}`);
  } finally {
    if (original === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = original;
  }
  createSuperSDK({ target: { indexedDB } });
  assert.equal(indexedDB.opens, 0);
});

test('denied outbox does not open IndexedDB until persistence is granted', async () => {
  const indexedDB = fakeIndexedDB();
  let current = null;
  const outbox = createOutbox({
    getConfig: () => current,
    indexedDBLike: indexedDB,
    canPersist: () => false,
    diagnostics: diagnostics()
  });
  current = config('aaaa0001');
  await outbox.clear();
  assert.equal(indexedDB.opens, 0);
});

test('persisted events are isolated by spid/environment and reload hydrates same namespace', async () => {
  const indexedDB = fakeIndexedDB();
  let current = config('aaaa0001', 'prod');
  const make = () => createOutbox({
    getConfig: () => current,
    indexedDBLike: indexedDB,
    canPersist: () => true,
    diagnostics: diagnostics()
  });

  const first = make();
  await first.enqueue(event('event-a'));
  current = config('bbbb0002', 'prod');
  assert.deepEqual(await first.selectBatch(Date.now()), []);
  current = config('aaaa0001', 'prod');
  assert.deepEqual((await first.selectBatch(Date.now())).map((item) => item.eventId), ['event-a']);

  current = config('bbbb0002', 'prod');
  const other = make();
  assert.deepEqual(await other.selectBatch(Date.now()), []);
  await other.enqueue(event('event-b'));

  current = config('aaaa0001', 'prod');
  const reloaded = make();
  const selected = await reloaded.selectBatch(Date.now());
  assert.deepEqual(selected.map((item) => item.eventId), ['event-a']);
  assert.equal(selected[0].namespace, 'aaaa0001\u0000prod');
});

test('persistence metadata cannot push an accepted event beyond the minimum batch budget', async () => {
  const indexedDB = fakeIndexedDB();
  const current = config('aaaa0001');
  const outbox = createOutbox({
    getConfig: () => current,
    indexedDBLike: indexedDB,
    canPersist: () => true,
    diagnostics: diagnostics()
  });
  const candidate = event('near-limit');
  candidate.params.value = '';
  candidate.params.value = 'x'.repeat(LIMITS.analytics.maxEventBytes - utf8Bytes(candidate));
  assert.equal(utf8Bytes(candidate), LIMITS.analytics.maxEventBytes);

  await outbox.enqueue(candidate);
  assert.ok(utf8Bytes(outbox.snapshot()[0]) > LIMITS.analytics.maxEventBytes, 'storage metadata makes the persisted record larger');
  assert.deepEqual((await outbox.selectBatch(Date.now())).map((item) => item.eventId), ['near-limit']);
});
