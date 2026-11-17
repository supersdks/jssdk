import { BRIDGE_PROTOCOL, getEventDefinition, getMethodDefinition } from './protocol.js';

const ID_PATTERN = /^[a-z][a-zA-Z0-9_.-]{0,63}$/;
const VALID_PLATFORMS = new Set(['android', 'ios']);

export class BridgeManifestError extends Error {
  constructor(reasonCode) {
    super(reasonCode);
    this.name = 'BridgeManifestError';
    this.reasonCode = reasonCode;
  }
}

export function validateBridgeManifest(input) {
  if (typeof input !== 'string') fail('MANIFEST_TYPE');
  if (!input || utf8Length(input) > BRIDGE_PROTOCOL.limits.manifestBytes) fail('MANIFEST_SIZE');
  let parsed;
  try { parsed = JSON.parse(input); } catch { fail('MANIFEST_JSON'); }
  if (!isPlainObject(parsed) || parsed.schema !== BRIDGE_PROTOCOL.manifestSchema) fail('MANIFEST_SCHEMA');
  validateVersion(parsed.protocolVersion);
  validateContainer(parsed.container);
  if (!Array.isArray(parsed.methods) || parsed.methods.length > BRIDGE_PROTOCOL.limits.methods) fail('METHODS_LIMIT');
  if (!Array.isArray(parsed.events) || parsed.events.length > BRIDGE_PROTOCOL.limits.events) fail('EVENTS_LIMIT');

  const methods = [];
  const methodIds = new Set();
  for (const candidate of parsed.methods) {
    if (!isPlainObject(candidate) || !ID_PATTERN.test(candidate.id || '')) fail('METHOD_ID');
    if (candidate.id === 'getBridgeManifest') fail('RESERVED_METHOD');
    if (methodIds.has(candidate.id)) fail('DUPLICATE_METHOD');
    methodIds.add(candidate.id);
    const expected = getMethodDefinition(candidate.id);
    if (!expected) continue;
    if (candidate.kind !== expected.kind || candidate.result !== expected.result || !sameArguments(candidate.args, expected.args)) {
      fail('METHOD_SIGNATURE');
    }
    methods.push(expected);
  }

  const events = [];
  const eventIds = new Set();
  for (const candidate of parsed.events) {
    if (!isPlainObject(candidate) || !ID_PATTERN.test(candidate.id || '')) fail('EVENT_ID');
    if (eventIds.has(candidate.id)) fail('DUPLICATE_EVENT');
    eventIds.add(candidate.id);
    const expected = getEventDefinition(candidate.id);
    if (!expected) continue;
    if (candidate.payload !== expected.payload) fail('EVENT_SIGNATURE');
    events.push(expected);
  }

  return deepFreeze({
    schema: parsed.schema,
    protocolVersion: { major: parsed.protocolVersion.major, minor: parsed.protocolVersion.minor },
    container: { platform: parsed.container.platform, sdkVersion: parsed.container.sdkVersion },
    methods,
    events
  });
}

export function createLegacyManifest(appbridge) {
  const methods = BRIDGE_PROTOCOL.methods.filter((method) =>
    method.legacy?.available && typeof safeRead(appbridge, method.legacy.nativeName) === 'function'
  );
  if (methods.length === 0) return null;
  return deepFreeze({
    schema: BRIDGE_PROTOCOL.manifestSchema,
    protocolVersion: null,
    container: null,
    methods,
    events: BRIDGE_PROTOCOL.events
  });
}

function sameArguments(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((argument, index) => {
    const match = expected[index];
    return isPlainObject(argument) && argument.name === match.name && argument.type === match.type && argument.required === match.required;
  });
}

function validateVersion(value) {
  if (!isPlainObject(value) || !isNonNegativeInteger(value.major) || !isNonNegativeInteger(value.minor)) fail('PROTOCOL_VERSION');
}

function validateContainer(value) {
  if (!isPlainObject(value) || !VALID_PLATFORMS.has(value.platform) || typeof value.sdkVersion !== 'string' || !value.sdkVersion || value.sdkVersion.length > 80) {
    fail('CONTAINER');
  }
}

function safeRead(target, key) {
  return target?.[key];
}

function utf8Length(value) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
  return unescape(encodeURIComponent(value)).length;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]';
}

function fail(reasonCode) {
  throw new BridgeManifestError(reasonCode);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
