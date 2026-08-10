import { sdkError } from '../core/errors.js';
import { createUUID } from '../core/utils.js';

const DEVICE_ID_KEY = 'supersdk_device_id';
const LEGACY_OUTBOX_KEYS = ['supersdk_outbox', 'supersdk_analytics_outbox'];

export function createConsentManager({ storage, outbox, gate, diagnostics, cryptoLike, random }) {
  let state = 'denied';
  let epoch = 0;
  let deviceId = '';
  let abortFlush = () => {};
  let lastMutation = Promise.resolve();

  function configure(consent, explicitDeviceId = '') {
    return consent === 'granted' ? grant(explicitDeviceId) : deny();
  }

  function set(next) {
    if (next !== 'granted' && next !== 'denied') return Promise.reject(sdkError('INVALID_ARGUMENT'));
    return next === 'granted' ? grant('') : deny();
  }

  function deny() {
    state = 'denied';
    epoch += 1;
    deviceId = '';
    abortFlush();
    removeStoredIdentity();
    lastMutation = gate.run(async () => {
      await outbox.clear();
      diagnostics.emit('info', { category: 'consent', code: 'CONSENT_DENIED', pending: 0 });
    });
    return lastMutation;
  }

  function grant(explicitDeviceId) {
    state = 'granted';
    epoch += 1;
    const currentEpoch = epoch;
    lastMutation = gate.run(async () => {
      if (state !== 'granted' || epoch !== currentEpoch) return;
      const stored = readStorage(DEVICE_ID_KEY);
      deviceId = explicitDeviceId || stored || createUUID(cryptoLike, random);
      writeStorage(DEVICE_ID_KEY, deviceId);
      diagnostics.emit('info', { category: 'consent', code: 'GRANTED' });
    });
    return lastMutation;
  }

  function removeStoredIdentity() {
    removeStorage(DEVICE_ID_KEY);
    for (const key of LEGACY_OUTBOX_KEYS) removeStorage(key);
  }

  function readStorage(key) {
    try { return storage?.getItem(key) || ''; } catch (_) {
      diagnostics.emit('warn', { category: 'identity_storage', code: 'UNAVAILABLE', persistent: false });
      return '';
    }
  }

  function writeStorage(key, value) {
    try { storage?.setItem(key, value); } catch (_) {
      diagnostics.emit('warn', { category: 'identity_storage', code: 'UNAVAILABLE', persistent: false });
    }
  }

  function removeStorage(key) {
    try { storage?.removeItem(key); } catch (_) {
      diagnostics.emit('warn', { category: 'identity_storage', code: 'UNAVAILABLE', persistent: false });
    }
  }

  return Object.freeze({
    configure,
    set,
    get: () => state,
    getEpoch: () => epoch,
    getDeviceId: () => state === 'granted' ? deviceId : '',
    assert: (expectedEpoch) => state === 'granted' && epoch === expectedEpoch,
    ready: () => lastMutation,
    setAbortFlush(handler) { abortFlush = typeof handler === 'function' ? handler : () => {}; }
  });
}
