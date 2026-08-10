import { LIMITS } from './limits.js';
import { sdkError } from './errors.js';
import { isPlainObject } from './utils.js';

const DEFAULT_API_BASE_URL = 'https://api.supersdk.com/superapi';
const SPID_PATTERN = /^[a-z0-9]{8}$/;
const ENV_PATTERN = /^[a-z0-9]{1,10}$/;

export function normalizeConfig(input, previous = null) {
  if (!isPlainObject(input)) throw legacyConfigError(TypeError, 'config', 'must be a plain object');
  if (Object.prototype.hasOwnProperty.call(input, 'aid')) throw legacyConfigError(TypeError, 'aid', 'is unsupported; use spid');

  const merged = { ...(previous || {}), ...input };
  const spid = input.spid ?? previous?.spid;
  if (spid === undefined) throw legacyConfigError(TypeError, 'spid', 'is required');
  if (typeof spid !== 'string' || !SPID_PATTERN.test(spid)) throw legacyConfigError(RangeError, 'spid', 'must match ^[a-z0-9]{8}$');

  const environment = input.environment ?? input.env ?? previous?.environment ?? 'prod';
  if (typeof environment !== 'string' || !ENV_PATTERN.test(environment)) throw legacyConfigError(RangeError, 'environment', 'must match ^[a-z0-9]{1,10}$');

  const analyticsConsent = input.analyticsConsent ?? previous?.analyticsConsent ?? 'denied';
  if (analyticsConsent !== 'denied' && analyticsConsent !== 'granted') throw sdkError('INVALID_ARGUMENT');

  const baseUrls = normalizeBaseUrls(input, previous);
  const settings = normalizeSettings(input.settings, previous?.settings);
  const analytics = normalizeAnalytics(input.analytics, previous?.analytics);
  const deviceId = input.deviceId ?? previous?.deviceId ?? '';
  if (typeof deviceId !== 'string' || deviceId.length > 256) throw sdkError('INVALID_ARGUMENT');

  return Object.freeze({
    ...merged,
    spid,
    environment,
    analyticsConsent,
    baseUrls: Object.freeze(baseUrls),
    deviceId,
    appName: typeof merged.appName === 'string' ? merged.appName : '',
    appIcon: typeof merged.appIcon === 'string' ? merged.appIcon : '',
    settings: Object.freeze(settings),
    analytics: Object.freeze(analytics)
  });
}

function normalizeBaseUrls(input, previous) {
  let source;
  let legacy = false;
  if (Object.prototype.hasOwnProperty.call(input, 'baseUrls')) source = input.baseUrls;
  else if (Object.prototype.hasOwnProperty.call(input, 'baseApi')) source = input.baseApi;
  else if (Object.prototype.hasOwnProperty.call(input, 'baseAPI')) source = input.baseAPI;
  else if (Object.prototype.hasOwnProperty.call(input, 'baseUrl')) { source = input.baseUrl; legacy = true; }
  else source = previous?.baseUrls || [DEFAULT_API_BASE_URL];

  const values = Array.isArray(source) ? source : [source];
  const result = [];
  for (const raw of values) {
    if (typeof raw !== 'string') throw sdkError('INVALID_ARGUMENT');
    let normalized = raw.trim().replace(/\/+$/, '');
    if (legacy && normalized && !normalized.endsWith('/superapi')) normalized += '/superapi';
    let parsed;
    try { parsed = new URL(normalized); } catch (_) { throw sdkError('INVALID_ARGUMENT'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw sdkError('INVALID_ARGUMENT');
    if (!result.includes(normalized)) result.push(normalized);
  }
  if (!result.length) throw sdkError('INVALID_ARGUMENT');
  return result;
}

function normalizeSettings(input, previous) {
  if (input !== undefined && !isPlainObject(input)) throw sdkError('INVALID_ARGUMENT');
  const source = { ...(previous || {}), ...(input || {}) };
  return {
    cacheTtlMs: positiveInt(source.cacheTtlMs, LIMITS.settings.cacheTtlMs, LIMITS.settings.cacheTtlMsMax),
    maxCacheEntries: positiveInt(source.maxCacheEntries, LIMITS.settings.maxCacheEntries, LIMITS.settings.maxCacheEntriesHard),
    maxValueBytes: positiveInt(source.maxValueBytes, LIMITS.settings.maxValueBytes, LIMITS.settings.maxValueBytesHard),
    maxParamsBytes: positiveInt(source.maxParamsBytes, LIMITS.settings.maxParamsBytes, LIMITS.settings.maxParamsBytesHard),
    timeoutMs: positiveInt(source.timeoutMs, LIMITS.settings.timeoutMs, LIMITS.settings.timeoutMsMax)
  };
}

function normalizeAnalytics(input, previous) {
  if (input !== undefined && !isPlainObject(input)) throw sdkError('INVALID_ARGUMENT');
  const source = { ...(previous || {}), ...(input || {}) };
  const maxBatchBytes = positiveInt(source.maxBatchBytes, LIMITS.analytics.maxBatchBytes, LIMITS.analytics.maxBatchBytesHard);
  if (maxBatchBytes < LIMITS.analytics.maxEventBytes) throw sdkError('INVALID_ARGUMENT');
  return {
    queueCapacity: positiveInt(source.queueCapacity, LIMITS.analytics.queueCapacity, LIMITS.analytics.queueCapacityHard),
    maxEventBytes: LIMITS.analytics.maxEventBytes,
    batchSize: positiveInt(source.batchSize, LIMITS.analytics.batchSize, LIMITS.analytics.batchSizeHard),
    maxBatchBytes,
    maxAgeMs: positiveInt(source.maxAgeMs, LIMITS.analytics.maxAgeMs, LIMITS.analytics.maxAgeMsHard),
    maxRetries: positiveInt(source.maxRetries, LIMITS.analytics.maxRetries, LIMITS.analytics.maxRetriesHard),
    baseBackoffMs: LIMITS.analytics.baseBackoffMs,
    maxBackoffMs: positiveInt(source.maxBackoffMs, LIMITS.analytics.maxBackoffMs, LIMITS.analytics.maxBackoffMs),
    flushTimeoutMs: positiveInt(source.flushTimeoutMs, LIMITS.analytics.flushTimeoutMs, LIMITS.analytics.flushTimeoutMsMax),
    flushIntervalMs: positiveInt(source.flushIntervalMs, LIMITS.analytics.flushIntervalMs, LIMITS.analytics.flushIntervalMsMax)
  };
}

function positiveInt(value, fallback, maximum) {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate <= 0 || candidate > maximum) throw sdkError('INVALID_ARGUMENT');
  return candidate;
}

function legacyConfigError(ErrorType, field, rule) {
  const error = new ErrorType(`initFallback ${field} ${rule}`);
  error.code = 'INVALID_ARGUMENT';
  error.retryable = false;
  return error;
}
