import { SuperSDKError } from '../core/errors.js';

export const BRIDGE_HUB_SYMBOL = Symbol.for('@supersdk/jssdk.bridgeHub.v1');

let ownerSequence = 0;

export function createBridgeOwner(target, diagnostics, options = {}) {
  if (!isTarget(target)) throw new SuperSDKError('INVALID_ARGUMENT');
  const ownerId = `sdk${(++ownerSequence).toString(36)}_${boundedRandom(options.random)}`;
  const callbacks = new Map();
  const listeners = new Map();
  let coordinator = null;
  let legacyHandlers = null;
  let backHandler = null;
  let requestSequence = 0;
  let disposed = false;

  const owner = {
    ownerId,
    ensureRegistered,
    checkAttached,
    nextRequestId() {
      assertActive();
      requestSequence += 1;
      return `${ownerId}:r${requestSequence.toString(36)}`;
    },
    registerCallback(requestId, callback) {
      assertActive();
      if (typeof requestId !== 'string' || typeof callback !== 'function' || callbacks.has(requestId)) {
        throw new SuperSDKError('INVALID_ARGUMENT');
      }
      ensureRegistered();
      callbacks.set(requestId, callback);
      return () => callbacks.delete(requestId);
    },
    addEventListener(eventId, listener) {
      assertActive();
      if (typeof listener !== 'function') throw new SuperSDKError('INVALID_ARGUMENT');
      ensureRegistered();
      let entries = listeners.get(eventId);
      if (!entries) listeners.set(eventId, entries = new Set());
      entries.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        entries.delete(listener);
        if (entries.size === 0) listeners.delete(eventId);
      };
    },
    setBackHandler(handler) {
      assertActive();
      backHandler = typeof handler === 'function' ? handler : null;
    },
    setLegacyHandlers(handlers) {
      assertActive();
      legacyHandlers = handlers || null;
    },
    dispose(reason = new SuperSDKError('DISPOSED')) {
      if (disposed) return;
      disposed = true;
      rejectCallbacks(reason);
      listeners.clear();
      notifyLegacyDetach(reason);
      const current = coordinator;
      coordinator = null;
      if (current) current.unregister(owner);
    },
    isDisposed: () => disposed,
    debugCounts: () => Object.freeze({ callbacks: callbacks.size, listeners: countListeners(listeners) }),
    _attach(nextCoordinator) { coordinator = nextCoordinator; },
    _detach(reason) {
      if (!coordinator) return;
      coordinator = null;
      rejectCallbacks(reason);
      listeners.clear();
      notifyLegacyDetach(reason);
    },
    _hasCallback(requestId) {
      return callbacks.has(requestId) || Boolean(legacyHandlers?.hasCallback?.(requestId));
    },
    _dispatchCallback(requestId, data) {
      const callback = callbacks.get(requestId);
      if (callback) {
        callback(data);
        return true;
      }
      return Boolean(legacyHandlers?.onCallback?.(requestId, data));
    },
    _dispatchEvent(eventType, eventKey, data) {
      let handled = false;
      const eventIds = eventIdsForWire(eventType, eventKey);
      for (const eventId of eventIds) {
        const entries = listeners.get(eventId);
        if (!entries?.size) continue;
        handled = true;
        const envelope = Object.freeze({ type: eventType, id: eventKey, data });
        for (const listener of [...entries]) {
          try { listener(envelope); } catch { emit(diagnostics, 'warn', { category: 'bridge_listener', event: eventId, outcome: 'listener_error' }); }
        }
      }
      if (legacyHandlers?.onEvent?.(eventType, eventKey, data)) handled = true;
      return handled;
    },
    _onBackPressed() {
      if (backHandler) {
        try { if (backHandler() === true) return true; } catch { emit(diagnostics, 'warn', { category: 'bridge_listener', event: 'back', outcome: 'listener_error' }); }
      }
      try { return legacyHandlers?.onBackPressed?.() === true; } catch {
        emit(diagnostics, 'warn', { category: 'bridge_listener', event: 'back', outcome: 'listener_error' });
        return false;
      }
    }
  };

  function ensureRegistered() {
    assertActive();
    if (coordinator && coordinator.checkIdentity()) return coordinator.bridge;
    coordinator = null;
    const next = acquireCoordinator(target, diagnostics);
    next.register(owner);
    return next.bridge;
  }

  function checkAttached() {
    if (!coordinator) return true;
    return coordinator.checkIdentity();
  }

  function rejectCallbacks(reason) {
    for (const callback of [...callbacks.values()]) {
      try { callback(undefined, reason); } catch { emit(diagnostics, 'warn', { category: 'bridge_callback', outcome: 'listener_error' }); }
    }
    callbacks.clear();
  }

  function notifyLegacyDetach(reason) {
    if (!legacyHandlers?.onDetach) return;
    try { legacyHandlers.onDetach(reason); } catch { emit(diagnostics, 'warn', { category: 'bridge_callback', outcome: 'listener_error' }); }
  }

  function assertActive() {
    if (disposed) throw new SuperSDKError('DISPOSED');
  }

  return Object.freeze(owner);
}

export function getBridgeHubDebugState(target) {
  const coordinator = safeRead(target, BRIDGE_HUB_SYMBOL);
  if (!coordinator || coordinator.detached) return Object.freeze({ installed: false, owners: 0, callbacks: 0, listeners: 0 });
  let callbacks = 0;
  let listeners = 0;
  for (const owner of coordinator.owners) {
    const counts = owner.debugCounts();
    callbacks += counts.callbacks;
    listeners += counts.listeners;
  }
  return Object.freeze({ installed: true, owners: coordinator.owners.length, callbacks, listeners });
}

function acquireCoordinator(target, diagnostics) {
  const existing = safeRead(target, BRIDGE_HUB_SYMBOL, diagnostics);
  if (existing && !existing.detached && existing.checkIdentity()) return existing;
  if (existing) clearCoordinatorSymbol(target, existing, diagnostics);
  return installCoordinator(target, diagnostics);
}

function installCoordinator(target, diagnostics) {
  const foreign = safeRead(target, 'JSBridge', diagnostics);
  const appbridge = safeRead(target, 'appbridge', diagnostics);
  const owners = [];
  const coordinator = {
    target,
    foreign,
    appbridge,
    owners,
    detached: false,
    bridge: null,
    register(owner) {
      if (!this.checkIdentity()) throw degradedError();
      if (!owners.includes(owner)) {
        owners.push(owner);
        owner._attach(this);
      }
    },
    unregister(owner) {
      const index = owners.indexOf(owner);
      if (index >= 0) owners.splice(index, 1);
      if (owners.length > 0) return;
      if (!this.detached && safeRead(target, 'JSBridge', diagnostics) === this.bridge) {
        try { safeWrite(target, 'JSBridge', foreign); } catch (cause) {
          emit(diagnostics, 'error', { category: 'bridge_hub', outcome: 'restore_error', errorClass: errorClass(cause) });
        }
      }
      clearCoordinatorSymbol(target, this, diagnostics);
      this.detached = true;
    },
    checkIdentity() {
      if (this.detached) return false;
      if (safeRead(target, 'JSBridge', diagnostics) === this.bridge) return true;
      this.detach();
      return false;
    },
    detach() {
      if (this.detached) return;
      this.detached = true;
      clearCoordinatorSymbol(target, this, diagnostics);
      const reason = degradedError();
      const currentOwners = owners.splice(0);
      for (const owner of currentOwners) owner._detach(reason);
      emit(diagnostics, 'warn', { category: 'bridge_hub', code: 'BRIDGE_DEGRADED', reason: 'CALLBACK_HUB_REPLACED', outcome: 'detached' });
    }
  };
  const bridge = Object.freeze({
    subscribeHandler(eventType, eventKey, data) {
      if (!coordinator.checkIdentity()) return delegateSubscribe(foreign, eventType, eventKey, data, diagnostics);
      let handled = false;
      if (eventType === 'ASYNC_CALLBACK') {
        for (const owner of [...owners]) {
          if (!owner._hasCallback(eventKey)) continue;
          try { handled = owner._dispatchCallback(eventKey, data) || handled; } catch (cause) {
            handled = true;
            emit(diagnostics, 'warn', { category: 'bridge_callback', outcome: 'listener_error', errorClass: errorClass(cause) });
          }
          break;
        }
      } else {
        for (const owner of [...owners]) handled = owner._dispatchEvent(eventType, eventKey, data) || handled;
      }
      if (!handled) {
        if (eventType === 'ASYNC_CALLBACK') emit(diagnostics, 'warn', { category: 'bridge_callback', requestId: boundedId(eventKey), outcome: 'orphan' });
        delegateSubscribe(foreign, eventType, eventKey, data, diagnostics);
      }
    },
    onBackPressed() {
      if (!coordinator.checkIdentity()) return delegateBack(foreign, diagnostics);
      for (let index = owners.length - 1; index >= 0; index -= 1) {
        if (owners[index]._onBackPressed()) return true;
      }
      return delegateBack(foreign, diagnostics);
    }
  });
  coordinator.bridge = bridge;
  try {
    safeWrite(target, BRIDGE_HUB_SYMBOL, coordinator);
    safeWrite(target, 'JSBridge', bridge);
  } catch (cause) {
    clearCoordinatorSymbol(target, coordinator, diagnostics);
    emit(diagnostics, 'error', { category: 'bridge_hub', outcome: 'install_error', errorClass: errorClass(cause) });
    throw new SuperSDKError('BRIDGE_DEGRADED', { reasonCode: 'CALLBACK_HUB_INSTALL_FAILED', cause });
  }
  if (safeRead(target, 'JSBridge', diagnostics) !== bridge) {
    clearCoordinatorSymbol(target, coordinator, diagnostics);
    emit(diagnostics, 'error', { category: 'bridge_hub', outcome: 'install_rejected' });
    throw new SuperSDKError('BRIDGE_DEGRADED', { reasonCode: 'CALLBACK_HUB_INSTALL_FAILED' });
  }
  const ready = safeRead(appbridge, 'onJSBridgeReady', diagnostics);
  if (typeof ready === 'function') {
    try { ready.call(appbridge); } catch (cause) {
      emit(diagnostics, 'warn', { category: 'bridge_hub', api: 'onJSBridgeReady', outcome: 'dispatch_error', errorClass: errorClass(cause) });
    }
  }
  return coordinator;
}

function eventIdsForWire(eventType, eventKey) {
  if (eventType === 'BROADCAST') return ['broadcast'];
  if (eventType === 'WEBVIEW_MESSAGE') return ['webviewMessage'];
  if (eventType === 'SYSTEM' && (eventKey === 'onEnterForeground' || eventKey === 'onEnterBackground')) return [`system.${eventKey}`];
  return [];
}

function delegateSubscribe(foreign, eventType, eventKey, data, diagnostics) {
  const handler = safeRead(foreign, 'subscribeHandler', diagnostics);
  if (typeof handler !== 'function') return;
  try { handler.call(foreign, eventType, eventKey, data); } catch (cause) {
    emit(diagnostics, 'warn', { category: 'bridge_foreign', event: eventType, outcome: 'listener_error', errorClass: errorClass(cause) });
  }
}

function delegateBack(foreign, diagnostics) {
  const handler = safeRead(foreign, 'onBackPressed', diagnostics);
  if (typeof handler !== 'function') return false;
  try { return handler.call(foreign) === true; } catch (cause) {
    emit(diagnostics, 'warn', { category: 'bridge_foreign', event: 'back', outcome: 'listener_error', errorClass: errorClass(cause) });
    return false;
  }
}

function clearCoordinatorSymbol(target, coordinator, diagnostics) {
  try {
    if (target[BRIDGE_HUB_SYMBOL] === coordinator && delete target[BRIDGE_HUB_SYMBOL] === false) {
      emit(diagnostics, 'error', { category: 'bridge_hub', outcome: 'symbol_cleanup_rejected' });
    }
  } catch (cause) {
    emit(diagnostics, 'error', { category: 'bridge_hub', outcome: 'symbol_cleanup_error', errorClass: errorClass(cause) });
  }
}

function degradedError() {
  return new SuperSDKError('BRIDGE_DEGRADED', { reasonCode: 'CALLBACK_HUB_REPLACED' });
}

function emit(diagnostics, level, detail) {
  try { diagnostics?.emit(level, detail); } catch { /* diagnostics boundary */ }
}

function errorClass(value) {
  return value && typeof value === 'object' && typeof value.name === 'string' ? value.name.slice(0, 80) : 'Error';
}

function boundedRandom(random) {
  const value = typeof random === 'function' ? random() : Math.random();
  return Math.floor(Math.abs(Number(value) || 0) * 0x100000000).toString(36).slice(0, 10);
}

function boundedId(value) {
  return typeof value === 'string' ? value.slice(0, 80) : 'invalid';
}

function countListeners(listeners) {
  let count = 0;
  for (const entries of listeners.values()) count += entries.size;
  return count;
}

function safeRead(target, key, diagnostics) {
  try { return target?.[key]; } catch (cause) {
    if (!diagnostics) throw new SuperSDKError('BRIDGE_DEGRADED', { reasonCode: 'PROPERTY_READ_FAILED', cause });
    emit(diagnostics, 'warn', { category: 'bridge_hub', outcome: 'property_read_error', errorClass: errorClass(cause) });
    return undefined;
  }
}

function safeWrite(target, key, value) {
  target[key] = value;
}

function isTarget(value) {
  return Boolean(value) && (typeof value === 'object' || typeof value === 'function');
}
