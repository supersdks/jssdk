const DEFINITIONS = Object.freeze({
  INVALID_ARGUMENT: ['Invalid argument', false],
  NOT_INITIALIZED: ['SuperSDK has not been initialized', false],
  CONSENT_DENIED: ['Analytics consent is denied', false],
  QUEUE_FULL: ['Analytics queue is full', false],
  PAYLOAD_TOO_LARGE: ['Payload exceeds the supported size', false],
  RATE_LIMITED: ['Request was rate limited', true],
  UNAVAILABLE: ['Service is temporarily unavailable', true],
  TIMEOUT: ['Request timed out', true],
  NETWORK_ERROR: ['Network request failed', true],
  PROTOCOL_MISMATCH: ['Upstream response did not match the contract', false],
  UNSUPPORTED: ['This capability is not supported in the current runtime', false],
  BRIDGE_ABSENT: ['The native bridge is absent', false],
  BRIDGE_INCOMPATIBLE: ['The native bridge protocol is incompatible', false],
  BRIDGE_DEGRADED: ['The native bridge is degraded', false],
  BRIDGE_ERROR: ['The native bridge operation failed', false],
  CANCELLED: ['The operation was cancelled', false],
  DISPOSED: ['The bridge owner has been disposed', false],
  MONITORING_START_FAILED: ['Monitoring failed to start', false],
  MONITORING_TRANSPORT_NOT_CONFIGURED: ['Monitoring transport is not configured', false],
  UNSUPPORTED_SUENC_CODEC: ['The response encoding codec is not supported', false],
  SUENC_DECODE_FAILED: ['The suenc response body could not be decoded', false],
  SUENC_INVALID_UTF8: ['The decoded suenc response body is not valid UTF-8', false],
  SUENC_DOWNGRADE: ['The response was not encoded although suenc was requested', true],
  SUENC_RESPONSE_TOO_LARGE: ['The response exceeds the encodable size limit', false],
  SUENC_PROTOCOL_ERROR: ['The suenc response violates the protocol', false]
});

export class SuperSDKError extends Error {
  constructor(code, options = {}) {
    const definition = DEFINITIONS[code] || [String(code || 'SuperSDK error'), false];
    super(options.message || definition[0]);
    this.name = 'SuperSDKError';
    this.code = code;
    this.retryable = options.retryable ?? definition[1];
    if (typeof options.nativeCode === 'string') this.nativeCode = bounded(options.nativeCode);
    if (typeof options.reasonCode === 'string') this.reasonCode = bounded(options.reasonCode);
    if (options.details && typeof options.details === 'object') this.details = sanitizeDetails(options.details);
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        enumerable: false,
        value: sanitizeCause(options.cause)
      });
    }
  }
}

export function sdkError(code, options) {
  return new SuperSDKError(code, options);
}

export function isSuperSDKError(value) {
  return value instanceof SuperSDKError;
}

function sanitizeCause(cause) {
  if (cause instanceof SuperSDKError) return { name: cause.name, code: cause.code };
  if (cause && typeof cause === 'object') {
    return { name: String(cause.name || 'Error').slice(0, 64) };
  }
  return undefined;
}

function sanitizeDetails(details) {
  const safe = {};
  for (const [key, value] of Object.entries(details).slice(0, 16)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key)) continue;
    if (typeof value === 'string') safe[key] = bounded(value);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || value === null) safe[key] = value;
  }
  return Object.freeze(safe);
}

function bounded(value) {
  return String(value).slice(0, 80);
}
