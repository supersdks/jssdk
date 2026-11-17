import { BRIDGE_PROTOCOL, getMethodDefinition } from './protocol.js';

export function createBridgeMock(options = {}) {
  const calls = [];
  const scripts = new Map();
  const manifest = options.manifest || defaultManifest();
  const target = options.target || {};
  const schedule = options.schedule || ((task) => queueMicrotask(task));
  const appbridge = {
    getBridgeManifest() {
      if (options.bootstrapError) throw options.bootstrapError;
      return typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
    },
    onJSBridgeReady() {
      calls.push(Object.freeze({ methodId: 'onJSBridgeReady', nativeName: 'onJSBridgeReady', args: [] }));
    }
  };

  for (const method of BRIDGE_PROTOCOL.methods) {
    if (method.nativeName === 'onJSBridgeReady') continue;
    appbridge[method.nativeName] = (...args) => {
      calls.push(Object.freeze({ methodId: method.id, nativeName: method.nativeName, args: [...args] }));
      const queue = scripts.get(method.id);
      const scripted = queue?.shift();
      if (scripted?.throw) throw scripted.throw;
      const requestId = findRequestId(method, args);
      if (requestId && scripted) {
        const results = Array.isArray(scripted.results) ? scripted.results : [scripted.result ?? scripted];
        for (const result of results) schedule(() => emitCallback(requestId, result));
      }
    };
  }
  target.appbridge = appbridge;

  function queueResult(methodId, scripted) {
    if (!getMethodDefinition(methodId)) throw new TypeError(`unknown bridge method: ${methodId}`);
    let queue = scripts.get(methodId);
    if (!queue) scripts.set(methodId, queue = []);
    queue.push(scripted);
    return api;
  }

  function emitCallback(requestId, result) {
    const bridge = target.JSBridge;
    if (!bridge || typeof bridge.subscribeHandler !== 'function') throw new Error('JSBridge is not installed');
    bridge.subscribeHandler('ASYNC_CALLBACK', requestId, result);
  }

  function emitEvent(eventType, eventKey, data) {
    const bridge = target.JSBridge;
    if (!bridge || typeof bridge.subscribeHandler !== 'function') throw new Error('JSBridge is not installed');
    bridge.subscribeHandler(eventType, eventKey, data);
  }

  const api = Object.freeze({ target, appbridge, calls, queueResult, emitCallback, emitEvent });
  return api;
}

function defaultManifest() {
  return {
    schema: BRIDGE_PROTOCOL.manifestSchema,
    protocolVersion: BRIDGE_PROTOCOL.protocolVersion,
    container: { platform: 'android', sdkVersion: 'mock' },
    methods: BRIDGE_PROTOCOL.methods.map(({ id, kind, args, result }) => ({ id, kind, args, result })),
    events: BRIDGE_PROTOCOL.events.map(({ id, payload }) => ({ id, payload }))
  };
}

function findRequestId(method, args) {
  const binding = method.callbackBinding;
  if (!binding) return null;
  if (binding.type === 'argument') return args[binding.index];
  if (binding.type === 'jsonField') {
    try { return JSON.parse(args[binding.argIndex])[binding.field] || null; } catch (cause) {
      throw new TypeError('scripted bridge received malformed JSON wire', { cause });
    }
  }
  return null;
}
