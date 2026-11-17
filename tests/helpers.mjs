import assert from 'node:assert/strict';

// headers 与 text 是 suenc 解码路径所需；两者都可选，既有 response(status, body) 调用行为不变。
export function response(status, body, headers = {}) {
  const lowered = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (lowered.has(String(name).toLowerCase()) ? lowered.get(String(name).toLowerCase()) : null) },
    async json() {
      if (body instanceof Error) throw body;
      return body;
    },
    async text() {
      if (body instanceof Error) throw body;
      return typeof body === 'string' ? body : JSON.stringify(body);
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

export function monitoringTarget(extra = {}) {
  const listeners = new Map();
  const timers = [];
  const target = {
    document: { visibilityState: 'visible' }, navigator: { userAgent: '' }, history: { back() {} },
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    dispatch(name, event = {}) { for (const listener of [...(listeners.get(name) || [])]) listener(event); },
    setTimeout(handler, delay) { const timer = { handler, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    runTimer(delay) { const timer = timers.find((item) => !item.cleared && item.delay === delay); if (!timer) return false; timer.cleared = true; timer.handler(); return true; },
    timerCount(delay) { return timers.filter((item) => !item.cleared && (delay === undefined || item.delay === delay)).length; },
    listenerCount(name) { return listeners.get(name)?.size || 0; },
    ...extra
  };
  return target;
}
