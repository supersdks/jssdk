import { sdkError } from '../core/errors.js';
import { cloneJSON, isPlainObject } from '../core/utils.js';
import { parseAttributeUpdates, parseReadyOptions, validateKey } from './client.js';

/**
 * In-app `SuperSDK.experiment` (WS-12-S2 · docs/architecture/experiment-s2-impl-spec.md §4).
 *
 * When the container declares the five experiment JSB methods, native owns experiments: it
 * fetches assignments, keeps the freeze table shared by native code and every WebView, dedupes
 * and reports `$exp_exposure` (source `h5`), and stamps `exp_vids` on events created from H5
 * `reportEvent`. This side therefore never sends assign requests, never reports exposures and
 * never attaches `exp_vids`.
 *
 * `get()` must stay synchronous, so it reads a JS mirror filled by `ready()` / `refresh()`
 * (`experimentReady` then `getAllExperiments`) and asks native asynchronously
 * (`getExperiment`) to freeze and expose. Native's answer is the shared frozen value: it
 * replaces the mirror entry and this page's frozen entry, with a diagnostic when they differ.
 *
 * WS-12-S6 (docs/architecture/experiment-s6-impl-spec.md §3): mirror items carry `type` and
 * `exposed`. Server-type experiments are not read through get(); the request vids
 * (`getRequestHeaders` / `appendVidsToUrl` / `fetch`) are computed synchronously from the mirror
 * (exposed vids + assigned server vids) while `getExperimentRequestVids` asks native to freeze
 * and expose them (source `h5`); native's string then replaces the mirror's exposed set. That
 * method is optional: an older container without it gets the mirror-only value.
 */

export const EXPERIMENT_BRIDGE_METHODS = Object.freeze([
  'experimentReady', 'getAllExperiments', 'getExperiment', 'exposeExperiment', 'setExperimentAttributes'
]);

/** Optional (WS-12-S6): delegation does not require it. */
export const EXPERIMENT_REQUEST_VIDS_METHOD = 'getExperimentRequestVids';
const EXP_VIDS_MAX = 500;

const CALL_TIMEOUT_MS = 5000;
const READY_GRACE_MS = 2000;
const BRIDGE_MAX_TIMEOUT_MS = 60000;
const BRIDGE_MIN_TIMEOUT_MS = 100;

export function createNativeExperimentClient({ bridge, diagnostics, setTimer, clearTimer }) {
  const schedule = setTimer || ((handler, delay) => {
    const timer = setTimeout(handler, delay);
    if (typeof timer?.unref === 'function') timer.unref();
    return timer;
  });
  const cancel = clearTimer || ((timer) => clearTimeout(timer));

  /** key → native result, from the last getAllExperiments / getExperiment answer. */
  const mirror = new Map();
  let mirrorLoaded = false;
  /** The device's exposed vid set as last known from native (mirror `exposed` flags, answers). */
  let exposedVids = new Set();
  /** Native's last getExperimentRequestVids answer, kept across mirror reloads. */
  let nativeAnswer = null;
  let requestVidsInflight = false;
  let requestVidsUnsupportedWarned = false;
  const serverReadWarned = new Set();
  /** key → { result, native: boolean, exposed: boolean } frozen for this page. */
  const frozen = new Map();

  function call(methodId, params, timeoutMs = CALL_TIMEOUT_MS) {
    const bounded = Math.min(BRIDGE_MAX_TIMEOUT_MS, Math.max(BRIDGE_MIN_TIMEOUT_MS, Math.round(timeoutMs)));
    try {
      return bridge.request(methodId, [JSON.stringify(params)], { timeoutMs: bounded });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function warn(code, extra) {
    diagnostics.emit('warn', { category: 'experiment_native', code, ...extra });
  }

  function present(result, options) {
    const { inExperiment, variant, vid, reason } = result;
    if (inExperiment) return Object.freeze({ inExperiment, variant, vid, payload: cloneJSON(result.payload), reason });
    return Object.freeze({
      inExperiment, variant, vid,
      payload: options && options.default !== undefined ? options.default : {},
      reason
    });
  }

  function lookup(key) {
    if (!mirrorLoaded) return notParticipating('no_result');
    return mirror.get(key) || notParticipating('unknown');
  }

  function get(key, options) {
    validateKey(key);
    if (options !== undefined && !isPlainObject(options)) throw sdkError('INVALID_ARGUMENT');
    const expose = !options || options.expose !== false;
    let entry = frozen.get(key);
    if (!entry && mirrorLoaded && mirror.get(key)?.type === 'server') {
      // Server-type experiments go to backends through the request vids: not frozen, not exposed.
      if (!serverReadWarned.has(key)) {
        serverReadWarned.add(key);
        warn('SERVER_EXPERIMENT_READ', { api: 'get' });
      }
      return present(notParticipating('unknown'), options);
    }
    if (!entry) {
      entry = { result: lookup(key), native: false, exposed: false };
      frozen.set(key, entry);
      // Before ready() the page has nothing to show: it keeps the default for the session, as
      // the web path does, and native is not asked (it would freeze and expose a variant this
      // page never renders).
      if (mirrorLoaded) askNative(key, entry, expose, options);
    } else if (expose && entry.native && !entry.exposed) {
      exposeNative(key, entry);
    }
    return present(entry.result, options);
  }

  function askNative(key, entry, expose, options) {
    entry.native = true;
    entry.exposed = expose;
    const params = { key, expose };
    if (options && isPlainObject(options.default)) params.default = options.default;
    call('getExperiment', params).then((data) => {
      const answer = normalizeResult(data);
      if (!answer) { warn('PROTOCOL_MISMATCH', { api: 'getExperiment' }); return; }
      if (!sameAssignment(answer, entry.result)) {
        warn('NATIVE_RESULT_MISMATCH', { api: 'getExperiment' });
        if (isEmergencyStop(entry.result, answer)) dropVid(entry.result.vid);
        entry.result = answer;
      }
      if (expose) markExposed(answer);
      mirror.set(key, answer);
    }, (error) => {
      if (expose) entry.exposed = false;
      warn(error?.code || 'BRIDGE_ERROR', { api: 'getExperiment' });
    });
  }

  function exposeNative(key, entry) {
    entry.exposed = true;
    call('exposeExperiment', { key }).then(() => markExposed(entry.result), (error) => {
      entry.exposed = false;
      warn(error?.code || 'BRIDGE_ERROR', { api: 'exposeExperiment' });
    });
  }

  function expose(key) {
    validateKey(key);
    const entry = frozen.get(key);
    if (!entry || !entry.native || entry.exposed) return;
    exposeNative(key, entry);
  }

  function getAll() {
    const out = {};
    for (const [key, result] of mirror) out[key] = withType(result);
    for (const [key, entry] of frozen) out[key] = withType(entry.result);
    return out;
  }

  function withType(result) {
    return Object.freeze({ ...present(result, undefined), type: result.type === 'server' ? 'server' : 'client' });
  }

  function markExposed(result) {
    if (!result || !result.inExperiment || result.reason === 'rollout' || result.vid === null) return;
    if (exposedVids.has(result.vid)) { result.exposed = true; return; }
    if (exposedVids.size >= EXP_VIDS_MAX) return;
    exposedVids.add(result.vid);
    result.exposed = true;
  }

  /** Platform requests: the exposed set as known now, without treating server experiments as read. */
  function currentVids() {
    return mirrorLoaded ? formatVids(exposedVids) : '';
  }

  /**
   * getRequestHeaders / appendVidsToUrl / fetch: synchronous value from the mirror (exposed vids
   * plus the assigned server-type vids, now treated as read), native asked asynchronously to
   * freeze and expose them. Before ready() the value is empty and native is not asked.
   */
  function requestVids() {
    if (!mirrorLoaded) return '';
    let added = false;
    for (const result of mirror.values()) {
      if (result.type !== 'server' || exposedVids.has(result.vid)) continue;
      const before = exposedVids.size;
      markExposed(result);
      if (exposedVids.size !== before) added = true;
    }
    const value = formatVids(exposedVids);
    if (!supportsRequestVids()) {
      if (!requestVidsUnsupportedWarned) {
        requestVidsUnsupportedWarned = true;
        diagnostics.emit('info', { category: 'experiment_native', code: 'REQUEST_VIDS_UNSUPPORTED', api: EXPERIMENT_REQUEST_VIDS_METHOD });
      }
      return value;
    }
    // One round trip per change: native is asked the first time and whenever new server vids
    // were added locally; repeated calls with an unchanged set stay local.
    if ((added || nativeAnswer === null) && !requestVidsInflight) askNativeVids(value);
    return value;
  }

  function askNativeVids(local) {
    requestVidsInflight = true;
    call(EXPERIMENT_REQUEST_VIDS_METHOD, {}).then((data) => {
      requestVidsInflight = false;
      const parsed = isPlainObject(data) && typeof data.vids === 'string' ? parseVids(data.vids) : null;
      if (!parsed) { warn('PROTOCOL_MISMATCH', { api: EXPERIMENT_REQUEST_VIDS_METHOD }); return; }
      nativeAnswer = parsed;
      if (formatVids(parsed) !== local) warn('NATIVE_RESULT_MISMATCH', { api: EXPERIMENT_REQUEST_VIDS_METHOD });
      exposedVids = new Set(parsed);
      syncExposedFlags();
    }, (error) => {
      requestVidsInflight = false;
      warn(error?.code || 'BRIDGE_ERROR', { api: EXPERIMENT_REQUEST_VIDS_METHOD });
    });
  }

  function syncExposedFlags() {
    for (const result of mirror.values()) {
      if (result.vid !== null) result.exposed = exposedVids.has(result.vid);
    }
  }

  function supportsRequestVids() {
    try { return Boolean(bridge.supports && bridge.supports(EXPERIMENT_REQUEST_VIDS_METHOD)); } catch (_) { return false; }
  }

  /**
   * WS-12-S5 · native unfreezes an emergency-stopped key and answers it as not participating
   * (`paused`). A page entry still holding the old participating value is corrected and its vid
   * leaves the exposed set; any other change to a frozen entry keeps the page's frozen value.
   */
  function isEmergencyStop(before, after) {
    return before.inExperiment && !after.inExperiment && after.reason === 'paused';
  }

  function dropVid(vid) {
    if (vid === null) return;
    exposedVids.delete(vid);
    if (nativeAnswer) nativeAnswer = nativeAnswer.filter((item) => item !== vid);
  }

  async function loadMirror(timeoutMs) {
    const data = await call('getAllExperiments', {}, timeoutMs);
    if (!isPlainObject(data) || !Array.isArray(data.experiments)) throw sdkError('PROTOCOL_MISMATCH');
    const previous = new Map(mirror);
    mirror.clear();
    const stoppedVids = new Set();
    for (const item of data.experiments) {
      const result = normalizeResult(item);
      if (result && typeof item.key === 'string' && item.key) {
        mirror.set(item.key, result);
        const was = previous.get(item.key);
        if (was && was.vid !== null && isEmergencyStop(was, result)) stoppedVids.add(was.vid);
        const entry = frozen.get(item.key);
        if (entry && isEmergencyStop(entry.result, result)) {
          warn('NATIVE_RESULT_MISMATCH', { api: 'getAllExperiments' });
          if (entry.result.vid !== null) stoppedVids.add(entry.result.vid);
          entry.result = result;
        }
      }
    }
    for (const vid of stoppedVids) dropVid(vid);
    const next = new Set(nativeAnswer || []);
    for (const result of mirror.values()) {
      if (result.exposed && result.vid !== null && next.size < EXP_VIDS_MAX) next.add(result.vid);
    }
    exposedVids = next;
    syncExposedFlags();
    mirrorLoaded = true;
  }

  function ready(options) {
    let parsed;
    try { parsed = parseReadyOptions(options); } catch (error) { return Promise.reject(error); }
    const params = { timeoutMs: parsed.timeoutMs };
    if (parsed.namespaces) params.namespaces = parsed.namespaces;
    const work = call('experimentReady', params, parsed.timeoutMs + READY_GRACE_MS)
      .then((data) => {
        if (!isPlainObject(data) || data.ready !== true) {
          diagnostics.emit('info', { category: 'experiment_native', code: 'READY_TIMEOUT' });
        }
      }, (error) => warn(error?.code || 'BRIDGE_ERROR', { api: 'experimentReady' }))
      // Even a timed-out ready mirrors what native has (possibly stored results).
      .then(() => loadMirror(READY_GRACE_MS))
      .catch((error) => warn(error?.code || 'BRIDGE_ERROR', { api: 'getAllExperiments' }));
    // Same contract as the web path: ready() never rejects on a slow or failing source.
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { if (timer !== null) cancel(timer); resolve(); };
      timer = schedule(done, parsed.timeoutMs + READY_GRACE_MS * 2);
      work.then(done, done);
    });
  }

  /** Native schedules its own fetches; refresh() re-reads native's current results. */
  async function refresh() {
    await loadMirror(CALL_TIMEOUT_MS);
  }

  function setAttributes(map) {
    const updates = parseAttributeUpdates(map);
    if (!updates.length) return;
    // Names without the `attr.` prefix; null removes the attribute. Native debounces and refetches.
    const attributes = Object.fromEntries(updates);
    call('setExperimentAttributes', { attributes }).catch((error) => {
      warn(error?.code || 'BRIDGE_ERROR', { api: 'setExperimentAttributes' });
    });
  }

  return Object.freeze({
    api: Object.freeze({ ready, get, expose, getAll, refresh, setAttributes }),
    requestVids,
    currentVids
  });
}

function notParticipating(reason, type = 'client') {
  return { inExperiment: false, variant: '', vid: null, payload: {}, reason, type, exposed: false };
}

function formatVids(set) {
  return [...set].sort((a, b) => a - b).join(',');
}

/** Native's `vids` string: '' or positive integers, comma-separated. null = malformed. */
function parseVids(text) {
  if (text === '') return [];
  const out = [];
  for (const part of text.split(',')) {
    if (!/^[1-9][0-9]{0,15}$/.test(part)) return null;
    const vid = Number(part);
    if (!Number.isSafeInteger(vid)) return null;
    out.push(vid);
  }
  return out.slice(0, EXP_VIDS_MAX);
}

function normalizeResult(data) {
  if (!isPlainObject(data) || typeof data.inExperiment !== 'boolean') return null;
  const reason = typeof data.reason === 'string' && data.reason ? data.reason : (data.inExperiment ? 'alloc' : 'no_result');
  // Older containers (S2) send neither field: `client`, not exposed.
  const type = data.type === 'server' ? 'server' : 'client';
  if (!data.inExperiment) return notParticipating(reason, type);
  return {
    inExperiment: true,
    variant: typeof data.variant === 'string' ? data.variant : '',
    vid: Number.isSafeInteger(data.vid) && data.vid > 0 ? data.vid : null,
    payload: isPlainObject(data.payload) ? data.payload : {},
    reason,
    type,
    exposed: data.exposed === true
  };
}

function sameAssignment(left, right) {
  return left.inExperiment === right.inExperiment && left.variant === right.variant &&
    left.vid === right.vid && left.reason === right.reason;
}
