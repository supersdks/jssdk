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
  PROTOCOL_MISMATCH: ['Upstream response did not match the contract', true],
  UNSUPPORTED: ['This capability is not supported in the current runtime', false]
});

export class SuperSDKError extends Error {
  constructor(code, options = {}) {
    const definition = DEFINITIONS[code] || [String(code || 'SuperSDK error'), false];
    super(options.message || definition[0]);
    this.name = 'SuperSDKError';
    this.code = code;
    this.retryable = options.retryable ?? definition[1];
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
