import assert from 'node:assert/strict';

export function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      if (body instanceof Error) throw body;
      return body;
    }
  };
}

export function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
    snapshot() { return Object.fromEntries(data); }
  };
}

export function createTarget(fetchImpl, storage = memoryStorage()) {
  const listeners = new Map();
  return {
    fetch: fetchImpl,
    localStorage: storage,
    crypto: globalThis.crypto,
    document: { visibilityState: 'visible', querySelectorAll: () => [] },
    navigator: { userAgent: '' },
    setInterval() { return { unref() {} }; },
    addEventListener(name, listener) { listeners.set(name, listener); },
    dispatch(name) { return listeners.get(name)?.(); },
    open() {}, close() {}, closed: false,
    history: { back() {} }
  };
}

export function assertSDKError(error, code, retryable) {
  assert.equal(error.name, 'SuperSDKError');
  assert.equal(error.code, code);
  assert.equal(error.retryable, retryable);
  return true;
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
