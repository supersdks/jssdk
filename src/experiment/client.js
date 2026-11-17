import { sdkError, isSuperSDKError } from '../core/errors.js';
import { cloneJSON, isPlainObject, joinApiUrl, stableStringify } from '../core/utils.js';
import { readJsonWithSuEnc, SUENC_ERROR_CODES } from '../suenc/codec.js';
import { EXPERIMENT_CONTRACT as C } from './contract.js';

/**
 * `SuperSDK.experiment` (WS-12-S1 · docs/architecture/experiment-s1-impl-spec.md §5).
 *
 * The SDK never evaluates experiments: it asks `POST {baseUrl}/v2/experiments/assign` for the
 * device's complete assignment list and applies the client-side rules on top of it:
 * freeze-on-first-read per page session, read-is-exposure with per-session + per-calendar-day
 * dedupe, and the exposed-vid set that every analytics event carries as `exp_vids` at the
 * moment it is created.
 */

const STORAGE_PREFIX = 'supersdk_exp_v1';
const RECORD_VERSION = 1;
const READY_TIMEOUT_MS = 2000;
const VISIBLE_REFRESH_AFTER_MS = 10 * 60 * 1000;
const ATTRIBUTES_DEBOUNCE_MS = 500;
const DEFAULT_TIMEOUT_MS = 5000;
const KEY_MAX_LENGTH = 64;
const CUSTOM_ATTRIBUTE_NAME = /^[A-Za-z0-9_]+$/;
const PARTICIPATING_REASONS = new Set(['alloc', 'override', 'rollout']);

/**
 * @param {object} deps
 * @param {{ current(): Subject, resolve(): Promise<Subject> }} deps.subject
 *   Subject = { status: 'ready', spid, environment, deviceId, platform, appVersion? }
 *           | { status: 'pending' } | { status: 'none', reason: 'no_subject' | 'not_configured' }
 * @param {() => { baseUrls: string[], timeoutMs: number }} deps.getTransport
 * @param {(name: string, params: object) => Promise<unknown>} deps.report exposure sink
 * @param {() => boolean} [deps.isSuspended] true while the in-app native delegation (WS-12-S2)
 *   owns experiments: this web client then never fetches (no assign request from H5).
 */
export function createExperimentClient({
  target, storage, fetchImpl, diagnostics, subject, getTransport, report,
  now = Date.now, setTimer, clearTimer, isSuspended = () => false
}) {
  const schedule = setTimer || ((handler, delay) => {
    const timer = setTimeout(handler, delay);
    if (typeof timer?.unref === 'function') timer.unref();
    return timer;
  });
  const cancel = clearTimer || ((timer) => clearTimeout(timer));

  /** Current subject's persisted state: { key, record }. */
  let state = null;
  /** key → frozen entry for this page session. */
  const frozen = new Map();
  /** vids exposed (event attempted) in this page session. */
  const sessionExposed = new Set();
  const namespaces = new Set([C.defaultNamespace]);
  const customAttributes = new Map();
  let inflight = null;
  let rerun = false;
  let sessionFetch = null;
  let attributesTimer = null;
  let lifecycleBound = false;
  /** Server-type keys already reported through the get() misuse diagnostic this session. */
  const serverReadWarned = new Set();
  /**
   * WS-12-S5 · keys listed in an assign response's `emergency_stopped` during this page session.
   * They read as not participating (`paused`) until the page is reloaded, even if a later
   * response assigns them again (experiment resumed): the resumed value is served from the next
   * page session on.
   */
  const stopped = new Set();

  // ---------------------------------------------------------------- subject & storage

  function sync() {
    const current = subject.current();
    if (current.status !== 'ready') {
      if (current.status === 'none' && current.reason === 'no_subject' && state) {
        // Consent revoked: forget this device's results and exposed set.
        removeRecord(state.key);
        state = null;
        sessionExposed.clear();
        diagnostics.emit('info', { category: 'experiment', code: 'CONSENT_CLEARED' });
      }
      return current;
    }
    const key = storageKey(current);
    if (!state || state.key !== key) {
      if (state) {
        // Project environment or device changed: a different subject, a different session.
        frozen.clear();
        sessionExposed.clear();
        stopped.clear();
        sessionFetch = null;
      }
      state = { key, record: loadRecord(key) };
    }
    return current;
  }

  function storageKey(current) {
    return `${STORAGE_PREFIX}:${current.spid}:${current.environment}:${current.deviceId}`;
  }

  function emptyRecord() {
    return {
      v: RECORD_VERSION,
      rulesVersion: null,
      lastSuccessAt: 0,
      staleAfterSec: C.staleAfterSec,
      fingerprint: '',
      results: {},
      exposed: [],
      day: { date: '', vids: [] }
    };
  }

  function loadRecord(key) {
    let raw = null;
    try { raw = storage?.getItem(key) ?? null; } catch (_) {
      diagnostics.emit('warn', { category: 'experiment_storage', code: 'UNAVAILABLE', persistent: false });
    }
    if (!raw) return emptyRecord();
    try {
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed) || parsed.v !== RECORD_VERSION) return emptyRecord();
      const record = emptyRecord();
      if (Number.isSafeInteger(parsed.rulesVersion) && parsed.rulesVersion >= 0) record.rulesVersion = parsed.rulesVersion;
      if (Number.isFinite(parsed.lastSuccessAt) && parsed.lastSuccessAt > 0) record.lastSuccessAt = parsed.lastSuccessAt;
      if (Number.isSafeInteger(parsed.staleAfterSec) && parsed.staleAfterSec > 0) record.staleAfterSec = parsed.staleAfterSec;
      if (typeof parsed.fingerprint === 'string') record.fingerprint = parsed.fingerprint;
      if (isPlainObject(parsed.results)) {
        for (const [ns, list] of Object.entries(parsed.results)) {
          if (!Array.isArray(list)) continue;
          record.results[ns] = list.map((item) => normalizeAssignment(item, ns)).filter(Boolean);
        }
      }
      if (Array.isArray(parsed.exposed)) {
        const seen = new Set();
        for (const entry of parsed.exposed) {
          if (!isPlainObject(entry) || !isVid(entry.vid) || seen.has(entry.vid)) continue;
          seen.add(entry.vid);
          record.exposed.push({
            vid: entry.vid,
            key: typeof entry.key === 'string' ? entry.key : '',
            run: Number.isSafeInteger(entry.run) ? entry.run : 0,
            ns: typeof entry.ns === 'string' ? entry.ns : C.defaultNamespace
          });
          if (record.exposed.length >= C.expVidsMax) break;
        }
      }
      if (isPlainObject(parsed.day) && typeof parsed.day.date === 'string' && Array.isArray(parsed.day.vids)) {
        record.day = { date: parsed.day.date, vids: parsed.day.vids.filter(isVid) };
      }
      return record;
    } catch (_) {
      diagnostics.emit('warn', { category: 'experiment_storage', code: 'CORRUPT' });
      return emptyRecord();
    }
  }

  function persist() {
    if (!state) return;
    try { storage?.setItem(state.key, JSON.stringify(state.record)); } catch (_) {
      diagnostics.emit('warn', { category: 'experiment_storage', code: 'UNAVAILABLE', persistent: false });
    }
  }

  function removeRecord(key) {
    try { storage?.removeItem(key); } catch (_) {
      diagnostics.emit('warn', { category: 'experiment_storage', code: 'UNAVAILABLE', persistent: false });
    }
  }

  function isFresh(record) {
    return record.lastSuccessAt > 0 && now() - record.lastSuccessAt <= record.staleAfterSec * 1000;
  }

  /** Searches the namespaces loaded in this session; `notLoaded` marks a key stored for another one. */
  function findAssignment(record, key) {
    let notLoaded = false;
    for (const [ns, list] of Object.entries(record.results)) {
      for (const assignment of list) {
        if (assignment.key !== key) continue;
        if (namespaces.has(ns)) return { assignment };
        notLoaded = true;
      }
    }
    return { assignment: null, notLoaded };
  }

  // ---------------------------------------------------------------- read / freeze / expose

  function evaluate(key, current) {
    const base = { key, subjectKey: current.status === 'ready' && state ? state.key : null, assignment: null, rulesVersion: null };
    if (current.status === 'none') {
      return { ...base, reason: current.reason === 'no_subject' ? 'no_subject' : 'no_result' };
    }
    if (current.status !== 'ready' || !state) return { ...base, reason: 'no_result' };
    const record = state.record;
    if (!isFresh(record)) return { ...base, reason: 'no_result' };
    const { assignment, notLoaded } = findAssignment(record, key);
    if (!assignment) return { ...base, reason: notLoaded ? 'not_loaded' : 'unknown' };
    return { ...base, assignment, rulesVersion: record.rulesVersion, reason: assignment.reason };
  }

  function present(entry, options) {
    const assignment = entry.assignment;
    if (assignment) {
      return Object.freeze({
        inExperiment: true,
        variant: assignment.variant,
        vid: assignment.vid,
        payload: cloneJSON(assignment.payload),
        reason: assignment.reason
      });
    }
    return Object.freeze({
      inExperiment: false,
      variant: '',
      vid: null,
      payload: options && options.default !== undefined ? options.default : {},
      reason: entry.reason
    });
  }

  function get(key, options) {
    validateKey(key);
    if (options !== undefined && !isPlainObject(options)) throw sdkError('INVALID_ARGUMENT');
    const current = sync();
    ensureStarted();
    if (stopped.has(key) && current.status === 'ready') return present(stoppedEntry(key), options);
    let entry = frozen.get(key);
    if (entry && frozenEntryValid(entry, current) && isServerEntry(entry)) return serverRead(key, entry, options);
    if (!entry || !frozenEntryValid(entry, current)) {
      entry = evaluate(key, current);
      // Server-type experiments are read by backends through the request header (WS-12-S6):
      // get() neither freezes nor exposes them.
      if (isServerEntry(entry)) return serverRead(key, entry, options);
      // A key whose namespace this page has not loaded is not frozen: ready({ namespaces }) loads it.
      if (entry.reason !== 'not_loaded') frozen.set(key, entry);
    }
    if (!options || options.expose !== false) exposeEntry(entry);
    return present(entry, options);
  }

  function expose(key) {
    validateKey(key);
    const entry = frozen.get(key);
    if (!entry || isServerEntry(entry) || stopped.has(key)) return;
    exposeEntry(entry);
  }

  function serverRead(key, entry, options) {
    if (!serverReadWarned.has(key)) {
      serverReadWarned.add(key);
      // 服务端实验请通过请求头（X-Super-AB-Vids）传给后端。
      diagnostics.emit('warn', { category: 'experiment', code: 'SERVER_EXPERIMENT_READ', api: 'get' });
    }
    return present({ ...entry, assignment: null, reason: 'unknown' }, options);
  }

  /**
   * WS-12-S6 · request vids with the side effect of spec §1: every assigned server-type
   * experiment in the loaded namespaces is treated as read (frozen for the session, exposed once
   * with the usual dedupe, added to the exposed set). Returns the exposed set ('' when empty).
   */
  function requestVids() {
    const current = sync();
    ensureStarted();
    if (current.status === 'ready' && state && isFresh(state.record)) {
      for (const [ns, list] of Object.entries(state.record.results)) {
        if (!namespaces.has(ns)) continue;
        for (const assignment of list) {
          if (assignment.type !== 'server' || stopped.has(assignment.key)) continue;
          let entry = frozen.get(assignment.key);
          if (!entry || !frozenEntryValid(entry, current)) {
            entry = evaluate(assignment.key, current);
            frozen.set(assignment.key, entry);
          }
          exposeEntry(entry);
        }
      }
    }
    return vidsParam();
  }

  function getAll() {
    const current = sync();
    ensureStarted();
    const out = {};
    if (current.status === 'ready' && state && isFresh(state.record)) {
      for (const [ns, list] of Object.entries(state.record.results)) {
        if (!namespaces.has(ns)) continue;
        for (const assignment of list) out[assignment.key] = withType(present({ assignment }, undefined), assignment);
      }
    }
    for (const [key, entry] of frozen) {
      if (frozenEntryValid(entry, current)) out[key] = withType(present(entry, undefined), entry.assignment);
    }
    for (const key of stopped) out[key] = withType(present(stoppedEntry(key), undefined), null);
    return out;
  }

  /**
   * A frozen entry belongs to the subject it was frozen under. After consent is revoked
   * (no subject) or re-granted with a new device id, it must not be served: the key is
   * re-evaluated for the current subject and frozen again. An entry frozen before the subject
   * was known (pending / not configured) stays frozen once that subject appears.
   */
  function frozenEntryValid(entry, current) {
    const noSubject = current.status === 'none' && current.reason === 'no_subject';
    if (noSubject) return entry.reason === 'no_subject';
    if (entry.reason === 'no_subject') return false;
    if (entry.subjectKey === null) return true;
    return current.status === 'ready' && state !== null && entry.subjectKey === state.key;
  }

  function stoppedEntry(key) {
    return { key, subjectKey: state ? state.key : null, assignment: null, rulesVersion: null, reason: 'paused' };
  }

  /**
   * WS-12-S5 · `emergency_stopped` of an accepted response: each listed key leaves the freeze
   * table, is marked stopped for the page session, and its vids leave the exposed set (so
   * exp_vids and the request vids drop them, like live_vids pruning would). One diagnostic per
   * newly stopped key; the JSSDK has no result-update listener to notify.
   */
  function applyEmergencyStops(record, list) {
    if (!Array.isArray(list)) return;
    for (const key of list) {
      if (typeof key !== 'string' || !key || key.length > KEY_MAX_LENGTH) continue;
      const entry = frozen.get(key);
      const vids = new Set(record.exposed.filter((item) => item.key === key).map((item) => item.vid));
      if (entry?.assignment && isVid(entry.assignment.vid)) vids.add(entry.assignment.vid);
      frozen.delete(key);
      const before = record.exposed.length;
      if (vids.size) record.exposed = record.exposed.filter((item) => !vids.has(item.vid));
      if (stopped.has(key)) continue;
      stopped.add(key);
      // Diagnostics carry no experiment keys (allow-listed fields only).
      diagnostics.emit('warn', {
        category: 'experiment', code: 'EMERGENCY_STOPPED',
        state: entry ? 'frozen' : 'unread', discarded: before - record.exposed.length
      });
    }
  }

  function exposeEntry(entry) {
    const assignment = entry.assignment;
    if (!assignment || assignment.reason === 'rollout' || !isVid(assignment.vid)) return;
    if (stopped.has(assignment.key)) return;
    const current = sync();
    if (current.status !== 'ready' || !state || entry.subjectKey !== state.key) return;
    if (sessionExposed.has(assignment.vid)) return;
    sessionExposed.add(assignment.vid);

    const record = state.record;
    const today = localDate(now());
    if (record.day.date !== today) record.day = { date: today, vids: [] };
    if (!record.day.vids.includes(assignment.vid)) {
      record.day.vids.push(assignment.vid);
      // `report` snapshots exp_vids synchronously, before this vid joins the set.
      sendExposure(assignment, entry.rulesVersion, state.key);
    }
    addExposed(record, assignment);
    persist();
  }

  function sendExposure(assignment, rulesVersion, subjectKey) {
    let pending;
    try {
      pending = Promise.resolve(report(C.exposureEvent, {
        vid: assignment.vid,
        exp_key: assignment.key,
        exp_run: assignment.run,
        exp_version: assignment.version,
        variant: assignment.variant,
        layer_key: assignment.layerKey,
        reason: assignment.reason,
        rules_version: rulesVersion
      }));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.catch((error) => {
      // Not queued: let a later read today retry instead of losing the day's exposure.
      if (state && state.key === subjectKey) {
        state.record.day.vids = state.record.day.vids.filter((vid) => vid !== assignment.vid);
        persist();
      }
      sessionExposed.delete(assignment.vid);
      diagnostics.emit('warn', { category: 'experiment_exposure', code: error?.code || 'REPORT_FAILED' });
    });
  }

  function addExposed(record, assignment) {
    if (record.exposed.some((entry) => entry.vid === assignment.vid)) return;
    if (record.exposed.length >= C.expVidsMax) {
      diagnostics.emit('warn', { category: 'experiment', code: 'EXP_VIDS_LIMIT', pending: record.exposed.length });
      return;
    }
    record.exposed.push({ vid: assignment.vid, key: assignment.key, run: assignment.run, ns: assignment.namespace });
  }

  /** `exp_vids` value for an event created right now ('' = omit). */
  function vidsParam() {
    const current = sync();
    if (current.status !== 'ready' || !state || !state.record.exposed.length) return '';
    return [...new Set(state.record.exposed.map((entry) => entry.vid))].sort((a, b) => a - b).join(',');
  }

  // ---------------------------------------------------------------- fetching

  function fetchNow() {
    if (inflight) {
      rerun = true;
      return inflight;
    }
    inflight = (async () => {
      let outcome;
      do {
        rerun = false;
        outcome = await doFetch();
        // A trigger that arrived mid-flight only needs another round if what we would send
        // (subject, namespaces, attributes) differs from the request that just completed.
      } while (rerun && !(outcome?.signature && outcome.signature === currentSignature()));
      return outcome;
    })().finally(() => { inflight = null; });
    const operation = inflight;
    if (!sessionFetch) {
      sessionFetch = operation;
      // A run that could not even start (not configured / subject pending) does not count as
      // this session's first fetch: the next trigger must try again and ready() must wait for it.
      operation.then((outcome) => {
        if ((outcome?.skipped === 'not_configured' || outcome?.skipped === 'pending') && sessionFetch === operation) sessionFetch = null;
      }, () => undefined);
    }
    return operation;
  }

  /** In-app the first experiment API use starts the session fetch (no getEnv JSB call otherwise). */
  function ensureStarted() {
    if (!sessionFetch && !inflight) kick();
  }

  function kick() {
    if (isSuspended()) return;
    fetchNow().catch(() => undefined);
  }

  async function doFetch() {
    let current;
    try { current = await subject.resolve(); } catch (error) {
      diagnostics.emit('warn', { category: 'experiment_assign', code: 'SUBJECT_UNAVAILABLE' });
      return { error: isSuperSDKError(error) ? error : sdkError('UNAVAILABLE', { cause: error }) };
    }
    sync();
    if (current.status !== 'ready' || !state) {
      return { skipped: current.status === 'none' ? current.reason : 'pending' };
    }
    const key = state.key;
    const record = state.record;
    const requested = [...namespaces].sort();
    const attributes = buildAttributes(current);
    const fingerprint = stableStringify({ namespaces: requested, attributes });
    const signature = `${key}|${fingerprint}`;
    const body = {
      spid: current.spid,
      env: current.environment,
      device_id: current.deviceId,
      namespaces: requested,
      side: 'client',
      attributes
    };
    if (record.rulesVersion !== null && record.fingerprint === fingerprint) body.known_version = record.rulesVersion;

    let data;
    try {
      data = await postAssign(current, body);
    } catch (error) {
      // Network / rate-limit / upstream failure: keep serving the local results.
      diagnostics.emit('warn', { category: 'experiment_assign', code: error?.code || 'NETWORK_ERROR' });
      return { error, signature };
    }
    if (!state || state.key !== key) return { skipped: 'subject_changed' };
    return { ...applyResponse(record, data, requested, fingerprint), signature };
  }

  function currentSignature() {
    const current = subject.current();
    if (current.status !== 'ready') return null;
    const requested = [...namespaces].sort();
    return `${storageKey(current)}|${stableStringify({ namespaces: requested, attributes: buildAttributes(current) })}`;
  }

  function applyResponse(record, data, requested, fingerprint) {
    if (!isPlainObject(data) || !Number.isSafeInteger(data.rules_version) || data.rules_version < 0) {
      diagnostics.emit('warn', { category: 'experiment_assign', code: 'PROTOCOL_MISMATCH' });
      return { error: sdkError('PROTOCOL_MISMATCH') };
    }
    if (record.rulesVersion !== null && data.rules_version < record.rulesVersion) {
      diagnostics.emit('info', { category: 'experiment_assign', code: 'OLDER_RULES_DROPPED' });
      return { dropped: true };
    }
    if (data.not_modified === true) {
      if (record.rulesVersion !== data.rules_version || record.fingerprint !== fingerprint) {
        diagnostics.emit('warn', { category: 'experiment_assign', code: 'PROTOCOL_MISMATCH' });
        return { error: sdkError('PROTOCOL_MISMATCH') };
      }
      record.lastSuccessAt = now();
      persist();
      return { notModified: true };
    }
    if (!Array.isArray(data.assignments)) {
      diagnostics.emit('warn', { category: 'experiment_assign', code: 'PROTOCOL_MISMATCH' });
      return { error: sdkError('PROTOCOL_MISMATCH') };
    }
    // Both types are kept (WS-12-S6): `client` for get(), `server` for the request vids.
    const assignments = data.assignments
      .map((item) => normalizeAssignment(item, C.defaultNamespace))
      .filter((item) => item && (item.type === 'client' || item.type === 'server'));
    for (const ns of requested) record.results[ns] = assignments.filter((item) => item.namespace === ns);
    record.rulesVersion = data.rules_version;
    record.fingerprint = fingerprint;
    record.lastSuccessAt = now();
    record.staleAfterSec = Number.isSafeInteger(data.stale_after_sec) && data.stale_after_sec > 0
      ? data.stale_after_sec
      : C.staleAfterSec;
    if (Array.isArray(data.live_vids)) {
      const live = new Set(data.live_vids.filter(isVid));
      const scope = new Set(requested);
      const before = record.exposed.length;
      record.exposed = record.exposed.filter((entry) => !scope.has(entry.ns) || live.has(entry.vid));
      if (record.exposed.length !== before) {
        diagnostics.emit('info', { category: 'experiment', code: 'EXP_VIDS_PRUNED', discarded: before - record.exposed.length });
      }
    }
    applyEmergencyStops(record, data.emergency_stopped);
    persist();
    return { updated: true };
  }

  async function postAssign(current, body) {
    if (typeof fetchImpl !== 'function') throw sdkError('NETWORK_ERROR');
    const transport = getTransport();
    let lastError = sdkError('NETWORK_ERROR');
    for (let index = 0; index < transport.baseUrls.length; index += 1) {
      try {
        return await postOne(current, transport, transport.baseUrls[index], body);
      } catch (error) {
        lastError = isSuperSDKError(error) ? error : sdkError('NETWORK_ERROR', { cause: error });
        // 429 is per-spid / per-ip state on the same CA: another base URL answers the same.
        if (!lastError.retryable || lastError.code === 'RATE_LIMITED') throw lastError;
        if (index + 1 < transport.baseUrls.length) {
          diagnostics.emit('warn', { category: 'experiment_failover', code: lastError.code, baseUrlIndex: index });
        }
      }
    }
    throw lastError;
  }

  async function postOne(current, transport, baseUrl, body) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), transport.timeoutMs || DEFAULT_TIMEOUT_MS) : null;
    let response;
    try {
      response = await fetchImpl(joinApiUrl(baseUrl, '/v2/experiments/assign'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Aid': current.spid,
          'X-Super-API-ENV': current.environment
        },
        body: JSON.stringify(body),
        signal: controller?.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw sdkError('TIMEOUT', { cause: error });
      throw sdkError('NETWORK_ERROR', { cause: error });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (response.status === 429) throw sdkError('RATE_LIMITED');
    if (response.status >= 500) throw sdkError('UNAVAILABLE');
    let envelope;
    try { envelope = await readJsonWithSuEnc(response); } catch (error) {
      // suenc decode failures surface as-is: never fall back to plaintext.
      if (isSuperSDKError(error) && SUENC_ERROR_CODES.has(error.code)) throw error;
      throw sdkError(response.ok ? 'PROTOCOL_MISMATCH' : 'UNAVAILABLE', { cause: error });
    }
    const code = envelope?.code;
    if (response.ok && (code === 'SUCCESS' || code === 0)) return envelope.data;
    if (code === 'TOO_MANY_REQUESTS' || code === 'RATE_LIMITED') throw sdkError('RATE_LIMITED');
    if (typeof code === 'string' && code && code !== 'SUCCESS') {
      throw sdkError('INVALID_ARGUMENT', {
        message: typeof envelope.message === 'string' && envelope.message ? envelope.message : code,
        nativeCode: code
      });
    }
    if (response.status === 400 || response.status === 413) throw sdkError('INVALID_ARGUMENT');
    throw sdkError(response.ok ? 'PROTOCOL_MISMATCH' : 'UNAVAILABLE');
  }

  function buildAttributes(current) {
    const attributes = { platform: current.platform || 'web' };
    if (current.appVersion) attributes.app_version = current.appVersion;
    if (current.language) attributes.language = current.language;
    for (const [name, value] of [...customAttributes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      attributes[`${C.customPrefix}${name}`] = value;
    }
    return attributes;
  }

  // ---------------------------------------------------------------- public async surface

  function ready(options) {
    let parsed;
    try { parsed = parseReadyOptions(options); } catch (error) { return Promise.reject(error); }
    const { timeoutMs } = parsed;
    let added = false;
    if (parsed.namespaces) {
      const next = new Set([...namespaces, ...parsed.namespaces]);
      if (next.size > C.namespacesPerRequest) return Promise.reject(sdkError('INVALID_ARGUMENT'));
      added = next.size !== namespaces.size;
      for (const ns of next) namespaces.add(ns);
    }
    const current = sync();
    if (current.status === 'none' && current.reason === 'no_subject') return Promise.resolve();
    const waitFor = added || !sessionFetch ? fetchNow() : sessionFetch;
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { if (timer !== null) cancel(timer); resolve(); };
      timer = schedule(done, timeoutMs);
      waitFor.then(done, done);
    });
  }

  async function refresh() {
    const outcome = await fetchNow();
    if (outcome?.error) throw outcome.error;
  }

  function setAttributes(map) {
    const next = new Map(customAttributes);
    for (const [name, value] of parseAttributeUpdates(map)) {
      if (value === null) next.delete(name);
      else next.set(name, value);
    }
    if (next.size > C.customAttributesMax) throw sdkError('INVALID_ARGUMENT');
    const changed = next.size !== customAttributes.size ||
      [...next].some(([name, value]) => customAttributes.get(name) !== value);
    if (!changed) return;
    customAttributes.clear();
    for (const [name, value] of next) customAttributes.set(name, value);
    if (attributesTimer !== null) cancel(attributesTimer);
    attributesTimer = schedule(() => { attributesTimer = null; kick(); }, ATTRIBUTES_DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------- lifecycle hooks (runtime-owned)

  /**
   * SDK configured / consent or environment changed: re-sync and (web) fetch right away.
   * In-app (`autoFetch: false`) the fetch waits for the first experiment API call.
   */
  function onSubjectMaybeChanged({ autoFetch = true } = {}) {
    sync();
    bindLifecycle();
    if (autoFetch) kick();
  }

  function bindLifecycle() {
    if (lifecycleBound || typeof target?.addEventListener !== 'function') return;
    lifecycleBound = true;
    target.addEventListener('visibilitychange', () => {
      if (target.document?.visibilityState !== 'visible') return;
      sync();
      if (!state || now() - state.record.lastSuccessAt > VISIBLE_REFRESH_AFTER_MS) kick();
    });
  }

  return Object.freeze({
    api: Object.freeze({ ready, get, expose, getAll, refresh, setAttributes }),
    vidsParam,
    requestVids,
    sync,
    onSubjectMaybeChanged
  });
}

/**
 * Validates a `setAttributes` map and returns `[name, value]` pairs with the `attr.` prefix
 * stripped and values stringified; `null` marks a removal. Shared by the web and in-app paths.
 */
export function parseAttributeUpdates(map) {
  if (!isPlainObject(map)) throw sdkError('INVALID_ARGUMENT');
  const updates = [];
  for (const [rawName, value] of Object.entries(map)) {
    const name = rawName.startsWith(C.customPrefix) ? rawName.slice(C.customPrefix.length) : rawName;
    if (!CUSTOM_ATTRIBUTE_NAME.test(name) || C.customPrefix.length + name.length > C.attributeKeyMaxChars) {
      throw sdkError('INVALID_ARGUMENT');
    }
    if (value === null || value === undefined) { updates.push([name, null]); continue; }
    if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) {
      throw sdkError('INVALID_ARGUMENT');
    }
    const text = String(value);
    if (text.length > C.attributeValueMaxChars) throw sdkError('INVALID_ARGUMENT');
    updates.push([name, text]);
  }
  return updates;
}

/** Validates `ready()` options; returns `{ timeoutMs, namespaces: string[] | undefined }` or throws. */
export function parseReadyOptions(options) {
  if (options !== undefined && !isPlainObject(options)) throw sdkError('INVALID_ARGUMENT');
  const timeoutMs = options?.timeoutMs ?? READY_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) throw sdkError('INVALID_ARGUMENT');
  let list;
  if (options?.namespaces !== undefined) {
    if (!Array.isArray(options.namespaces)) throw sdkError('INVALID_ARGUMENT');
    for (const ns of options.namespaces) {
      if (typeof ns !== 'string' || !C.namespacePattern.test(ns)) throw sdkError('INVALID_ARGUMENT');
    }
    list = [...new Set(options.namespaces)];
    if (list.length > C.namespacesPerRequest) throw sdkError('INVALID_ARGUMENT');
  }
  return { timeoutMs, namespaces: list };
}

export function validateKey(key) {
  if (typeof key !== 'string' || !key || key.length > KEY_MAX_LENGTH) throw sdkError('INVALID_ARGUMENT');
}

function isServerEntry(entry) {
  return Boolean(entry && entry.assignment && entry.assignment.type === 'server');
}

/** getAll() items carry the experiment type (WS-12-S6); not-participating entries are `client` reads. */
function withType(result, assignment) {
  return Object.freeze({ ...result, type: assignment && assignment.type === 'server' ? 'server' : 'client' });
}

function isVid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeAssignment(item, fallbackNamespace) {
  if (!isPlainObject(item) || typeof item.key !== 'string' || !item.key) return null;
  const reason = typeof item.reason === 'string' ? item.reason : '';
  if (!PARTICIPATING_REASONS.has(reason)) return null;
  const vid = isVid(item.vid) ? item.vid : null;
  if (vid === null && reason !== 'rollout') return null;
  return {
    key: item.key,
    vid,
    run: Number.isSafeInteger(item.run) ? item.run : 0,
    version: Number.isSafeInteger(item.version) ? item.version : 0,
    type: typeof item.type === 'string' ? item.type : 'client',
    namespace: typeof item.namespace === 'string' && item.namespace ? item.namespace : fallbackNamespace,
    variant: typeof item.variant === 'string' ? item.variant : '',
    payload: isPlainObject(item.payload) ? item.payload : {},
    layerKey: typeof item.layer_key === 'string' ? item.layer_key : (typeof item.layerKey === 'string' ? item.layerKey : ''),
    reason
  };
}

function localDate(ms) {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
