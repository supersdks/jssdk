import { SuperSDKError } from '../core/errors.js';
import { createLegacyManifest, validateBridgeManifest } from './manifest.js';
import {
  BRIDGE_PROTOCOL,
  buildWireArguments,
  decodeResultEnvelope,
  getEventDefinition,
  getMethodDefinition
} from './protocol.js';

const REQUEST_TIMEOUT = Object.freeze({ defaultValue: 5000, minimum: 100, maximum: 60000 });
const STREAM_TIMEOUT = Object.freeze({ defaultValue: 300000, minimum: 1000, maximum: 1800000 });

export function createBridgeTransport({
  target,
  owner,
  diagnostics,
  now = () => Date.now(),
  setTimer = (handler, delay) => setTimeout(handler, delay),
  clearTimer = (timer) => clearTimeout(timer),
  disposeLegacy
}) {
  let generation = 0;
  let identity = null;
  let initialized = false;
  let manifest = null;
  let state = snapshot('absent', null, null, null, false);
  let inFlight = null;
  let disposed = false;

  function ready(options = {}) {
    assertNotDisposed();
    validateReadyOptions(options);
    owner.ensureRegistered();
    refresh(false);
    const force = options.force === true;
    const currentIdentity = identity;
    if (inFlight && inFlight.identity === currentIdentity && (!force || inFlight.force)) return inFlight.promise;
    if (!force && initialized) return Promise.resolve(state);
    if (force) {
      generation += 1;
      probe(currentIdentity);
    }
    const operation = { identity: currentIdentity, force, promise: null };
    operation.promise = Promise.resolve().then(() => state).finally(() => {
      if (inFlight === operation) inFlight = null;
    });
    inFlight = operation;
    return operation.promise;
  }

  function getBridgeState() {
    if (disposed) return state;
    if (!owner.checkAttached()) {
      generation += 1;
      try { identity = readIdentity(target); } catch (cause) {
        identity = null;
        emit('warn', { category: 'bridge_manifest', state: 'degraded', outcome: 'identity_read', errorClass: errorClass(cause) });
      }
      initialized = true;
      manifest = null;
      state = snapshot('degraded', null, null, 'CALLBACK_HUB_REPLACED', false);
      return state;
    }
    refresh(false);
    return state;
  }

  function supports(id) {
    if (disposed || typeof id !== 'string' || id === 'getBridgeManifest') return false;
    getBridgeState();
    if (state.status !== 'legacy' && state.status !== 'negotiated') return false;
    return Boolean(manifest?.methods.some((method) => method.id === id) || manifest?.events.some((event) => event.id === id));
  }

  function request(methodId, args = [], options = {}) {
    let prepared;
    try {
      prepared = prepareMethod(methodId, 'request', args, options, REQUEST_TIMEOUT);
    } catch (error) {
      return Promise.reject(error);
    }
    const { method, timeoutMs, signal } = prepared;
    const requestId = owner.nextRequestId();
    let pending;
    const completion = new Promise((resolve, reject) => {
      pending = createPending({ method, requestId, timeoutMs, signal, resolve, reject, stream: false });
    });
    try {
      const nativeArgs = buildWireArguments(method, args, requestId);
      if (!pending.settled) dispatch(method, nativeArgs);
    } catch (cause) {
      pending.reject(asDispatchError(cause));
    }
    return completion;
  }

  async function command(methodId, args = [], options = {}) {
    const { method, signal } = prepareMethod(methodId, 'command', args, options, REQUEST_TIMEOUT);
    if (signal?.aborted) throw new SuperSDKError('CANCELLED');
    const nativeArgs = buildWireArguments(method, args);
    try { dispatch(method, nativeArgs); } catch (cause) { throw asDispatchError(cause); }
    await Promise.resolve();
  }

  function openStream(methodId, args = [], options = {}) {
    const { method, timeoutMs, signal } = prepareMethod(methodId, 'stream', args, options, STREAM_TIMEOUT);
    const requestId = owner.nextRequestId();
    const progressListeners = new Set();
    let pending;
    const completion = new Promise((resolve, reject) => {
      pending = createPending({ method, requestId, timeoutMs, signal, resolve, reject, stream: true, progressListeners });
    });
    try {
      if (!pending.settled) dispatch(method, buildWireArguments(method, args, requestId));
    } catch (cause) {
      pending.reject(asDispatchError(cause));
    }
    let cancelled = false;
    return Object.freeze({
      completion,
      onProgress(listener) {
        if (typeof listener !== 'function') throw new SuperSDKError('INVALID_ARGUMENT');
        if (pending.settled) return () => undefined;
        progressListeners.add(listener);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          progressListeners.delete(listener);
        };
      },
      cancel() {
        if (cancelled || pending.settled) return;
        cancelled = true;
        bestEffortCancel(method, requestId);
        pending.reject(new SuperSDKError('CANCELLED'));
      }
    });
  }

  function subscribe(eventId, listener) {
    assertNotDisposed();
    if (!getEventDefinition(eventId) || typeof listener !== 'function') throw invalidArgument(eventId);
    prepareOperational(eventId);
    if (!supports(eventId)) throw unsupported(eventId);
    return owner.addEventListener(eventId, listener);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    const previous = state;
    state = Object.freeze({ ...previous, disposed: true });
    owner.dispose(new SuperSDKError('DISPOSED'));
    if (typeof disposeLegacy === 'function') disposeLegacy();
  }

  function debugCounts() {
    return owner.debugCounts();
  }

  function assertNotDisposed() {
    if (disposed) throw new SuperSDKError('DISPOSED');
  }

  function prepareMethod(methodId, kind, args, options, timeoutRules) {
    assertNotDisposed();
    const method = getMethodDefinition(methodId);
    if (!method || method.id === 'getBridgeManifest' || method.kind !== kind || !Array.isArray(args) || !isPlainObject(options)) {
      throw invalidArgument(methodId);
    }
    const timeoutMs = validateTimeout(options.timeoutMs, timeoutRules);
    const signal = validateSignal(options.signal);
    if (signal?.aborted) throw new SuperSDKError('CANCELLED');
    prepareOperational(methodId);
    if (!supports(methodId)) throw unsupported(methodId);
    return { method, timeoutMs, signal };
  }

  function prepareOperational(api) {
    assertNotDisposed();
    owner.ensureRegistered();
    refresh(false);
    if (state.status === 'absent') throw operationError('BRIDGE_ABSENT', api, state.reasonCode);
    if (state.status === 'incompatible') throw operationError('BRIDGE_INCOMPATIBLE', api, state.reasonCode);
    if (state.status === 'degraded') throw operationError('BRIDGE_DEGRADED', api, state.reasonCode);
  }

  function createPending({ method, requestId, timeoutMs, signal, resolve, reject, stream, progressListeners }) {
    let settled = false;
    let timer = null;
    let removeCallback = null;
    let abortHandler = null;
    const startedAt = now();
    const pending = {
      get settled() { return settled; },
      reject(error) { settle(false, error); }
    };

    const callback = (payload, detachedError) => {
      if (settled) {
        emit('warn', { category: 'bridge_callback', requestId, api: method.id, outcome: 'late' });
        return;
      }
      if (detachedError) {
        settle(false, detachedError);
        return;
      }
      if (!stream) {
        try { settle(true, decodeResultEnvelope(payload)); } catch (error) { settle(false, error); }
        return;
      }
      handleStreamPayload(payload);
    };
    removeCallback = owner.registerCallback(requestId, callback);
    timer = setTimer(() => settle(false, new SuperSDKError('TIMEOUT')), timeoutMs);
    if (signal) {
      abortHandler = () => {
        if (stream) bestEffortCancel(method, requestId);
        settle(false, new SuperSDKError('CANCELLED'));
      };
      signal.addEventListener('abort', abortHandler, { once: true });
      if (signal.aborted) abortHandler();
    }

    function handleStreamPayload(payload) {
      let data;
      try { data = decodeResultEnvelope(payload); } catch (error) { settle(false, error); return; }
      if (!isPlainObject(data) || !['START', 'PROGRESS', 'SUCCESS', 'FAIL'].includes(data.status)) {
        settle(false, new SuperSDKError('PROTOCOL_MISMATCH'));
        return;
      }
      if (data.status === 'START' || data.status === 'PROGRESS') {
        for (const listener of [...progressListeners]) {
          try { listener(data); } catch { emit('warn', { category: 'bridge_listener', requestId, api: method.id, outcome: 'listener_error' }); }
        }
        return;
      }
      if (data.status === 'SUCCESS') settle(true, data);
      else settle(false, new SuperSDKError('BRIDGE_ERROR', { nativeCode: 'UNKNOWN' }));
    }

    function settle(success, value) {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimer(timer);
      removeCallback?.();
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      progressListeners?.clear();
      emit(success ? 'info' : 'warn', {
        category: 'bridge_operation', requestId, api: method.id,
        outcome: success ? 'success' : 'failure', latencyBucket: latencyBucket(now() - startedAt),
        code: success ? undefined : value?.code, errorClass: success ? undefined : errorClass(value)
      });
      if (success) resolve(value);
      else reject(value instanceof SuperSDKError ? value : new SuperSDKError('BRIDGE_ERROR', { cause: value }));
    }
    return pending;
  }

  function bestEffortCancel(method, requestId) {
    const cancel = method.cancelBinding;
    if (!cancel) return;
    const appbridge = safeRead(target, 'appbridge');
    const native = safeRead(appbridge, cancel.nativeName);
    if (typeof native !== 'function') return;
    try { native.call(appbridge, requestId); } catch (cause) {
      emit('warn', { category: 'bridge_operation', requestId, api: method.id, outcome: 'cancel_dispatch_error', errorClass: errorClass(cause) });
    }
  }

  function dispatch(method, args) {
    const appbridge = safeRead(target, 'appbridge');
    const native = safeRead(appbridge, method.nativeName);
    if (typeof native !== 'function') throw new SuperSDKError('BRIDGE_ERROR');
    native.apply(appbridge, args);
  }

  function refresh(force) {
    let nextIdentity;
    try { nextIdentity = readIdentity(target); } catch (cause) {
      if (initialized) generation += 1;
      initialized = true;
      identity = null;
      manifest = null;
      state = snapshot('degraded', null, null, 'IDENTITY_READ', false);
      emit('warn', { category: 'bridge_manifest', state: 'degraded', outcome: 'identity_read', errorClass: errorClass(cause) });
      return;
    }
    if (!initialized) {
      identity = nextIdentity;
      initialized = true;
      probe(nextIdentity);
      return;
    }
    if (force || !sameIdentity(identity, nextIdentity)) {
      generation += 1;
      identity = nextIdentity;
      probe(nextIdentity);
    }
  }

  function probe(nextIdentity) {
    const appbridge = nextIdentity.appbridge;
    manifest = null;
    if (!appbridge || (typeof appbridge !== 'object' && typeof appbridge !== 'function')) {
      state = snapshot('absent', null, null, null, false);
      return;
    }
    let bootstrap;
    try { bootstrap = appbridge.getBridgeManifest; } catch (cause) {
      state = snapshot('degraded', null, null, 'BOOTSTRAP_READ', false);
      emit('warn', { category: 'bridge_manifest', state: 'degraded', outcome: 'bootstrap_read', errorClass: errorClass(cause) });
      return;
    }
    if (typeof bootstrap !== 'function') {
      try {
        manifest = createLegacyManifest(appbridge);
        state = manifest ? snapshot('legacy', null, null, null, false) : snapshot('degraded', null, null, 'NO_FROZEN_SIGNATURE', false);
      } catch (cause) {
        manifest = null;
        state = snapshot('degraded', null, null, 'LEGACY_SIGNATURE_READ', false);
        emit('warn', { category: 'bridge_manifest', state: 'degraded', outcome: 'legacy_signature_read', errorClass: errorClass(cause) });
      }
      return;
    }
    try {
      const parsed = validateBridgeManifest(bootstrap.call(appbridge));
      manifest = parsed;
      if (parsed.protocolVersion.major !== BRIDGE_PROTOCOL.protocolVersion.major) {
        state = snapshot('incompatible', parsed.protocolVersion, parsed.container, 'UNSUPPORTED_MAJOR', false);
      } else {
        state = snapshot('negotiated', parsed.protocolVersion, parsed.container, null, false);
      }
    } catch (cause) {
      manifest = null;
      state = snapshot('degraded', null, null, cause?.reasonCode || 'BOOTSTRAP_FAILED', false);
      emit('warn', { category: 'bridge_manifest', state: 'degraded', outcome: 'invalid', errorClass: errorClass(cause) });
    }
  }

  function snapshot(status, protocolVersion, container, reasonCode, isDisposed) {
    return Object.freeze({ status, generation, protocolVersion, container, reasonCode, disposed: isDisposed });
  }

  function emit(level, detail) {
    diagnostics?.emit(level, detail);
  }

  return Object.freeze({ ready, getBridgeState, supports, request, command, openStream, subscribe, dispose, __debugCounts: debugCounts });
}

function validateReadyOptions(options) {
  if (!isPlainObject(options) || (options.force !== undefined && typeof options.force !== 'boolean')) throw new SuperSDKError('INVALID_ARGUMENT');
}

function validateTimeout(value, rules) {
  if (value === undefined) return rules.defaultValue;
  if (!Number.isInteger(value) || value < rules.minimum || value > rules.maximum) throw new SuperSDKError('INVALID_ARGUMENT');
  return value;
}

function validateSignal(signal) {
  if (signal === undefined) return null;
  if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') {
    throw new SuperSDKError('INVALID_ARGUMENT');
  }
  return signal;
}

function invalidArgument(api) {
  return new SuperSDKError('INVALID_ARGUMENT', { api });
}

function unsupported(api) {
  return new SuperSDKError('UNSUPPORTED', { api });
}

function operationError(code, api, reasonCode) {
  return new SuperSDKError(code, { api, reasonCode });
}

function asDispatchError(cause) {
  return cause instanceof SuperSDKError && cause.code === 'BRIDGE_ERROR'
    ? cause
    : new SuperSDKError('BRIDGE_ERROR', { cause });
}

function readIdentity(target) {
  return Object.freeze({ appbridge: target?.appbridge, jsBridge: target?.JSBridge });
}

function sameIdentity(left, right) {
  return left?.appbridge === right?.appbridge && left?.jsBridge === right?.jsBridge;
}

function safeRead(target, key) {
  return target?.[key];
}

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]';
}

function latencyBucket(value) {
  if (!Number.isFinite(value) || value < 0) return 'unknown';
  if (value < 10) return 'lt10ms';
  if (value < 100) return 'lt100ms';
  if (value < 1000) return 'lt1s';
  if (value < 10000) return 'lt10s';
  return 'gte10s';
}

function errorClass(value) {
  return value && typeof value.name === 'string' ? value.name.slice(0, 80) : 'Error';
}
