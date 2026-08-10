import { sdkError, isSuperSDKError } from '../core/errors.js';
import { isPlainObject, joinApiUrl, stableHash, stableStringify, utf8Bytes } from '../core/utils.js';

const RESERVED_PARAMS = new Set(['spid', 'env', 'aid', 'configName']);

export function createSettingsClient({ getConfig, fetchImpl, diagnostics, cryptoLike, now = Date.now }) {
  const cache = new Map();
  const inflight = new Map();
  let cacheGeneration = 0;

  async function getHostSettings(configName, params) {
    const request = normalizeRequest(configName, params);
    const config = requireConfig(getConfig());
    // A caller that began before clear() may finish normally, but must never
    // repopulate or otherwise participate in the newer cache generation.
    const requestGeneration = cacheGeneration;
    if (utf8Bytes(stableStringify(request.params)) > config.settings.maxParamsBytes) {
      throw sdkError('INVALID_ARGUMENT');
    }

    const key = await stableHash({
      spid: config.spid,
      environment: config.environment,
      configName: request.configName,
      params: request.params
    }, cryptoLike);
    const current = requestGeneration === cacheGeneration ? cache.get(key) : undefined;
    if (current && current.expiresAt > now()) {
      touch(cache, key, current);
      return current.value;
    }
    if (requestGeneration === cacheGeneration && inflight.has(key)) return inflight.get(key);

    let operation;
    operation = requestSettings(config, request, key, current, requestGeneration)
      .finally(() => {
        // A stale operation must not delete a newer generation's in-flight
        // request for the same cache key.
        if (inflight.get(key) === operation) inflight.delete(key);
      });
    if (requestGeneration === cacheGeneration) inflight.set(key, operation);
    return operation;
  }

  async function getHostSettingsByKey(key, configName, params) {
    if (typeof key !== 'string' || !key.trim() || key.length > 256) throw sdkError('INVALID_ARGUMENT');
    const value = await getHostSettings(configName, params);
    if (!isPlainObject(value) || !Object.prototype.hasOwnProperty.call(value, key)) return null;
    return value[key];
  }

  async function requestSettings(config, request, key, lastGood, requestGeneration) {
    let lastError;
    for (let index = 0; index < config.baseUrls.length; index += 1) {
      try {
        const value = await fetchOne(config, request, config.baseUrls[index]);
        if (value === NOT_FOUND) return {};
        if (utf8Bytes(value) <= config.settings.maxValueBytes) {
          if (requestGeneration === cacheGeneration) {
            setCache(cache, key, {
              value,
              expiresAt: now() + config.settings.cacheTtlMs,
              lastGoodAt: now()
            }, config.settings.maxCacheEntries);
          }
        } else {
          diagnostics.emit('warn', { category: 'settings_cache', code: 'PAYLOAD_TOO_LARGE' });
        }
        return value;
      } catch (error) {
        lastError = normalizeSettingsError(error);
        if (!lastError.retryable) throw lastError;
        if (index + 1 < config.baseUrls.length) {
          diagnostics.emit('warn', { category: 'settings_failover', code: lastError.code, baseUrlIndex: index });
          continue;
        }
      }
    }
    if (lastGood) {
      if (requestGeneration === cacheGeneration) touch(cache, key, lastGood);
      diagnostics.emit('warn', { category: 'settings_lkg', code: lastError?.code || 'UNAVAILABLE' });
      return lastGood.value;
    }
    throw lastError || sdkError('UNAVAILABLE');
  }

  async function fetchOne(config, request, baseUrl) {
    if (typeof fetchImpl !== 'function') throw sdkError('NETWORK_ERROR');
    const url = new URL(joinApiUrl(baseUrl, '/v2/settings'));
    url.searchParams.set('spid', config.spid);
    url.searchParams.set('env', config.environment);
    if (request.configName) url.searchParams.set('configName', request.configName);
    for (const [key, value] of Object.entries(request.params)) {
      if (RESERVED_PARAMS.has(key) || key.startsWith('__')) continue;
      url.searchParams.set(key, stringifyParam(value));
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), config.settings.timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
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
    try { envelope = await response.json(); } catch (error) {
      throw sdkError(response.ok ? 'PROTOCOL_MISMATCH' : 'UNAVAILABLE', { cause: error });
    }
    const code = envelope?.code;
    if (response.ok && (code === 'SUCCESS' || code === 0)) return envelope.data;
    if (code === 'NOT_FOUND') return NOT_FOUND;
    if (code === 'BAD_REQUEST' || code === 'SPID_REQUIRED' || response.status === 400) {
      throw sdkError('INVALID_ARGUMENT');
    }
    if (code === 'UPSTREAM_ERROR' || response.status >= 500) throw sdkError('UNAVAILABLE');
    throw sdkError(response.ok ? 'PROTOCOL_MISMATCH' : 'UNAVAILABLE');
  }

  return Object.freeze({
    getHostSettings,
    getHostSettingsByKey,
    clear: () => {
      cacheGeneration += 1;
      cache.clear();
      inflight.clear();
    },
    _cacheSize: () => cache.size
  });
}

const NOT_FOUND = Symbol('not-found');

function normalizeRequest(configName, params) {
  if (configName !== undefined && configName !== null && typeof configName !== 'string') {
    throw sdkError('INVALID_ARGUMENT');
  }
  const normalizedName = typeof configName === 'string' ? configName.trim() : '';
  if (normalizedName.length > 128) throw sdkError('INVALID_ARGUMENT');
  const normalizedParams = params === undefined ? {} : params;
  if (!isPlainObject(normalizedParams)) throw sdkError('INVALID_ARGUMENT');
  const safeParams = {};
  for (const [key, value] of Object.entries(normalizedParams)) {
    if (!RESERVED_PARAMS.has(key) && !key.startsWith('__')) safeParams[key] = value;
  }
  return { configName: normalizedName, params: safeParams };
}

function stringifyParam(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return stableStringify(value);
}

function normalizeSettingsError(error) {
  return isSuperSDKError(error) ? error : sdkError('NETWORK_ERROR', { cause: error });
}

function requireConfig(config) {
  if (!config) throw sdkError('NOT_INITIALIZED');
  return config;
}

function setCache(cache, key, entry, maximum) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, entry);
  while (cache.size > maximum) cache.delete(cache.keys().next().value);
}

function touch(cache, key, value) {
  cache.delete(key);
  cache.set(key, value);
}
