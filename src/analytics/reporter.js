import { sdkError } from '../core/errors.js';
import { cloneJSON, createUUID, isPlainObject, joinApiUrl, utf8Bytes } from '../core/utils.js';

const RESERVED_EVENT_KEYS = new Set([
  'host_spid', 'host_aid', 'spid', 'env', 'platform', 'platform_id', 'device_id',
  'evt_unique_id', 'source', 'os_type'
]);

export function createReporter({
  target, getConfig, fetchImpl, diagnostics, outbox, consent, gate,
  cryptoLike, storage, random = Math.random, now = Date.now
}) {
  const commonParams = new Map();
  let activeController = null;
  let flushPromise = null;
  let timer = null;
  let lifecycleBound = false;
  let lastOutcome = null;

  consent.setAbortFlush(() => {
    activeController?.abort();
    activeController = null;
  });

  async function reportEvent(eventName, params = {}) {
    const config = requireConfig(getConfig());
    if (consent.get() !== 'granted') throw sdkError('CONSENT_DENIED');
    if (typeof eventName !== 'string' || !eventName.trim() || eventName.length > 128) {
      throw sdkError('INVALID_ARGUMENT');
    }
    if (!isPlainObject(params)) params = {};
    let safeParams;
    try { safeParams = cloneJSON(params); } catch (_) { throw sdkError('INVALID_ARGUMENT'); }

    const epoch = consent.getEpoch();
    await consent.ready();
    const event = {
      eventId: createUUID(cryptoLike, random),
      eventName: eventName.trim(),
      params: safeParams,
      clientTsMs: now(),
      attempts: 0,
      createdAtMs: now(),
      nextAttemptAtMs: now()
    };
    if (utf8Bytes(event) > config.analytics.maxEventBytes) throw sdkError('PAYLOAD_TOO_LARGE');

    return gate.run(async () => {
      if (!consent.assert(epoch)) throw sdkError('CONSENT_DENIED');
      const queued = await outbox.enqueue(event);
      if (!queued) {
        diagnostics.emit('warn', { category: 'analytics_enqueue', code: 'QUEUE_FULL', pending: outbox.size() });
        throw sdkError('QUEUE_FULL');
      }
      if (!consent.assert(epoch)) throw sdkError('CONSENT_DENIED');
      diagnostics.emit('info', { category: 'analytics_enqueue', code: 'QUEUED', pending: outbox.size() });
      ensureActiveFlush();
      return Object.freeze({ eventId: event.eventId, queued: true });
    });
  }

  async function flush(options = {}) {
    if (flushPromise) return flushPromise;
    flushPromise = doFlush(options).finally(() => { flushPromise = null; });
    return flushPromise;
  }

  async function doFlush(options) {
    const config = requireConfig(getConfig());
    if (consent.get() !== 'granted') return summary(0, 0, 0, 0, outbox.size(), 'consent_denied');
    await consent.ready();
    const epoch = consent.getEpoch();
    if (!consent.assert(epoch)) return summary(0, 0, 0, 0, outbox.size(), 'consent_denied');

    let batch = await outbox.selectBatch(now());
    const expired = batch.filter((event) => now() - event.createdAtMs > config.analytics.maxAgeMs);
    if (expired.length) {
      await gate.run(() => outbox.remove(expired.map((event) => event.eventId)));
      batch = batch.filter((event) => !expired.includes(event));
      diagnostics.emit('warn', { category: 'analytics_drop', code: 'MAX_AGE', discarded: expired.length });
    }
    if (options.keepalive) batch = keepaliveSubset(batch, 60 * 1024);
    if (!batch.length) return summary(0, 0, expired.length, 0, outbox.size(), 'empty');

    let result;
    try {
      result = await sendBatch(config, batch, Boolean(options.keepalive));
    } catch (error) {
      if (!consent.assert(epoch)) return summary(batch.length, 0, 0, 0, outbox.size(), 'consent_revoked');
      result = { kind: 'retry-all', code: error?.code || 'NETWORK_ERROR' };
    }

    return gate.run(async () => {
      if (!consent.assert(epoch)) return summary(batch.length, 0, 0, 0, outbox.size(), 'consent_revoked');
      const classified = classifyResult(result, batch, config, now, random, diagnostics);
      if (classified.remove.length) await outbox.remove(classified.remove);
      if (classified.retry.length) await outbox.update(classified.retry);
      lastOutcome = {
        sent: classified.sent,
        discarded: classified.discarded,
        retrying: classified.retry.length,
        code: result.code || result.kind
      };
      diagnostics.emit(classified.retry.length ? 'warn' : 'info', {
        category: 'analytics_flush',
        code: result.code || result.kind,
        sent: classified.sent,
        discarded: classified.discarded,
        retrying: classified.retry.length,
        pending: outbox.size()
      });
      return summary(batch.length, classified.sent, classified.discarded + expired.length, classified.retry.length, outbox.size());
    });
  }

  async function sendBatch(config, batch, keepalive) {
    const payload = buildPayload(config, batch, commonParams, consent.getDeviceId());
    let lastError = sdkError('NETWORK_ERROR');
    const baseUrls = orderedBaseUrls(config.baseUrls, storage);
    for (let index = 0; index < baseUrls.length; index += 1) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      activeController = controller;
      const timeout = controller ? setTimeout(() => controller.abort(), config.analytics.flushTimeoutMs) : null;
      try {
        const response = await fetchImpl(joinApiUrl(baseUrls[index], '/v2/reportEvent'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Aid': config.spid,
            'X-Super-API-ENV': config.environment
          },
          body: JSON.stringify(payload),
          signal: controller?.signal,
          keepalive
        });
        let body = null;
        try { body = await response.json(); } catch (_) { /* classified below */ }
        if (response.status >= 200 && response.status < 300) {
          if (response.status === 207) {
            return { kind: 'partial', code: isPlainObject(body) ? (body.code || 'MULTI_STATUS') : 'PROTOCOL_MISMATCH', body };
          }
          if (isPlainObject(body) && isReportSuccessCode(body.code)) {
            recordSuccessfulBaseUrl(storage, baseUrls[index]);
            return { kind: 'success-all', code: body.code || 'SUCCESS', body };
          }
          return { kind: 'retry-all', code: 'PROTOCOL_MISMATCH' };
        }
        if (response.status === 400 || response.status === 413) {
          return body?.failures ? { kind: 'partial', code: body.code || 'INVALID_EVENT', body } : { kind: 'discard-all', code: `HTTP_${response.status}` };
        }
        if (response.status === 408) lastError = sdkError('TIMEOUT');
        else if (response.status === 429) lastError = sdkError('RATE_LIMITED');
        else if (response.status >= 500) lastError = sdkError('UNAVAILABLE');
        else return { kind: 'discard-all', code: `HTTP_${response.status}` };
      } catch (error) {
        lastError = error?.name === 'AbortError' ? sdkError('TIMEOUT', { cause: error }) : sdkError('NETWORK_ERROR', { cause: error });
      } finally {
        if (timeout) clearTimeout(timeout);
        if (activeController === controller) activeController = null;
      }
      if (index + 1 < baseUrls.length) {
        diagnostics.emit('warn', { category: 'analytics_failover', code: lastError.code, baseUrlIndex: index });
      }
    }
    throw lastError;
  }

  function addEventCommonParam(key, value) {
    if (typeof key !== 'string' || !key.trim() || key.length > 128) throw sdkError('INVALID_ARGUMENT');
    if (RESERVED_EVENT_KEYS.has(key)) {
      diagnostics.emit('warn', { category: 'analytics_common_param', code: 'RESERVED_KEY' });
      return;
    }
    commonParams.set(key, value == null ? '' : String(value));
  }

  function addEventCommonParams(values) {
    if (!isPlainObject(values)) throw sdkError('INVALID_ARGUMENT');
    for (const [key, value] of Object.entries(values)) addEventCommonParam(key, value);
  }

  function ensureActiveFlush() {
    const config = getConfig();
    if (!config || timer || typeof target?.setInterval !== 'function') return;
    timer = target.setInterval(() => { flush().catch(() => undefined); }, config.analytics.flushIntervalMs);
    if (typeof timer?.unref === 'function') timer.unref();
    if (!lifecycleBound && typeof target?.addEventListener === 'function') {
      lifecycleBound = true;
      target.addEventListener('pagehide', () => { flush({ keepalive: true }).catch(() => undefined); });
      target.addEventListener('visibilitychange', () => {
        if (target.document?.visibilityState === 'hidden') flush({ keepalive: true }).catch(() => undefined);
      });
    }
  }

  return Object.freeze({
    reportEvent,
    flush,
    addEventCommonParam,
    addEventCommonParams,
    ensureActiveFlush,
    getDeliveryState: () => Object.freeze({
      consent: consent.get(),
      pending: outbox.size(),
      persistent: outbox.isPersistent(),
      lastOutcome: lastOutcome ? { ...lastOutcome } : null
    })
  });
}

function buildPayload(config, batch, commonParams, deviceId) {
  return {
    basic_data: {
      host_spid: config.spid,
      env: config.environment,
      os_type: 'web',
      platform_id: 'web_sdk',
      device_id: deviceId,
      source: 'web_sdk_untrusted'
    },
    events: batch.map((event) => {
      const eventParam = {};
      for (const [key, value] of commonParams) if (!RESERVED_EVENT_KEYS.has(key)) eventParam[key] = value;
      for (const [key, value] of Object.entries(event.params)) if (!RESERVED_EVENT_KEYS.has(key)) eventParam[key] = value;
      eventParam.evt_unique_id = event.eventId;
      return { event_name: event.eventName, event_param: eventParam, client_ts_ms: event.clientTsMs };
    })
  };
}

function classifyResult(result, batch, config, now, random, diagnostics) {
  if (result.kind === 'success-all') return { remove: batch.map((event) => event.eventId), retry: [], sent: batch.length, discarded: 0 };
  if (result.kind === 'discard-all') return { remove: batch.map((event) => event.eventId), retry: [], sent: 0, discarded: batch.length };
  if (result.kind === 'retry-all') return classifyRetry(batch, config, now, random);

  const partial = validatePartialResult(result.body, batch);
  if (!partial) {
    protocolMismatch(diagnostics);
    return classifyRetry(batch, config, now, random);
  }

  const remove = [];
  const retrySource = [];
  let sent = 0;
  let discarded = 0;

  for (const match of partial.successes) {
    remove.push(match.event.eventId);
    sent += 1;
  }
  for (const { failure, match } of partial.failures) {
    if (isPermanentFailure(failure.error_code)) {
      remove.push(match.event.eventId);
      discarded += 1;
    } else retrySource.push(match.event);
  }
  for (let index = 0; index < batch.length; index += 1) {
    if (!partial.consumed.has(index)) retrySource.push(batch[index]);
  }
  const retried = classifyRetry(retrySource, config, now, random);
  return {
    remove: remove.concat(retried.remove),
    retry: retried.retry,
    sent,
    discarded: discarded + retried.discarded
  };
}

function classifyRetry(events, config, now, random) {
  const retry = [];
  const remove = [];
  let discarded = 0;
  for (const event of events) {
    const attempts = event.attempts + 1;
    if (attempts > config.analytics.maxRetries || now() - event.createdAtMs > config.analytics.maxAgeMs) {
      remove.push(event.eventId);
      discarded += 1;
      continue;
    }
    const raw = Math.min(config.analytics.maxBackoffMs, config.analytics.baseBackoffMs * (2 ** (attempts - 1)));
    retry.push({ ...event, attempts, nextAttemptAtMs: now() + Math.floor(raw * (0.75 + random() * 0.5)) });
  }
  return { remove, retry, sent: 0, discarded };
}

function validatePartialResult(body, batch) {
  if (!isPlainObject(body) || !Array.isArray(body.successes) || !Array.isArray(body.failures)) return null;
  const byId = new Map(batch.map((event, index) => [event.eventId, { event, index }]));
  const consumed = new Set();
  const successes = [];
  const failures = [];

  for (const success of body.successes) {
    const match = resolvePartialMatch(success, batch, byId, { requireId: true });
    if (!match || consumed.has(match.index)) return null;
    consumed.add(match.index);
    successes.push(match);
  }
  for (const failure of body.failures) {
    const match = resolvePartialMatch(failure, batch, byId, { requireId: false });
    if (!match || consumed.has(match.index)) return null;
    consumed.add(match.index);
    failures.push({ failure, match });
  }
  return { successes, failures, consumed };
}

function resolvePartialMatch(entry, batch, byId, { requireId }) {
  if (!isPlainObject(entry)) return null;
  const hasIdField = Object.hasOwn(entry, 'evt_unique_id');
  const id = entry.evt_unique_id;
  const hasId = typeof id === 'string' && id.length > 0;
  if (requireId && !hasId) return null;
  if (hasIdField && !hasId && id !== '') return null;

  const hasIndex = Object.hasOwn(entry, 'index');
  if (hasIndex && (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= batch.length)) return null;
  if (!hasId && !hasIndex) return null;

  const idMatch = hasId ? byId.get(id) : null;
  const indexMatch = hasIndex ? { event: batch[entry.index], index: entry.index } : null;
  if (hasId && !idMatch) return null;
  if (idMatch && indexMatch && idMatch.index !== indexMatch.index) return null;
  return idMatch || indexMatch;
}

function isPermanentFailure(code) {
  return /INVALID|VALIDATION|TOO_LARGE|BAD_REQUEST|UNSUPPORTED|MISSING/.test(String(code || '').toUpperCase());
}

function isReportSuccessCode(code) {
  return code === 'OK' || code === 'SUCCESS' || code === 0;
}

function protocolMismatch(diagnostics) {
  diagnostics.emit('warn', { category: 'analytics_protocol', code: 'PROTOCOL_MISMATCH' });
}

function keepaliveSubset(batch, maximumBytes) {
  const result = [];
  let total = 0;
  for (const event of batch) {
    const size = utf8Bytes(event);
    if (total + size > maximumBytes) break;
    total += size;
    result.push(event);
  }
  return result;
}

function array(value) { return Array.isArray(value) ? value : []; }
function requireConfig(config) { if (!config) throw sdkError('NOT_INITIALIZED'); return config; }
function summary(attempted, sent, discarded, retrying, pending, reason) {
  return Object.freeze({ attempted, sent, discarded, retrying, pending, ...(reason ? { reason } : {}) });
}

function orderedBaseUrls(baseUrls, storage) {
  let last = '';
  try { last = storage?.getItem('supersdk_last_success_base_url') || ''; } catch (_) { /* memory order */ }
  const normalized = String(last).replace(/\/+$/, '');
  return baseUrls.includes(normalized)
    ? [normalized, ...baseUrls.filter((value) => value !== normalized)]
    : [...baseUrls];
}

function recordSuccessfulBaseUrl(storage, baseUrl) {
  try { storage?.setItem('supersdk_last_success_base_url', String(baseUrl).replace(/\/+$/, '')); } catch (_) { /* memory order */ }
}
