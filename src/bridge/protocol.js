import {
  BRIDGE_CONTRACT_SHA256,
  BRIDGE_GOLDEN_VECTOR_DATA,
  BRIDGE_PROTOCOL_DATA
} from './generated-contract.js';
import { SuperSDKError } from '../core/errors.js';

export const BRIDGE_PROTOCOL = deepFreeze(BRIDGE_PROTOCOL_DATA);
export const BRIDGE_GOLDEN_VECTORS = deepFreeze(BRIDGE_GOLDEN_VECTOR_DATA);
export { BRIDGE_CONTRACT_SHA256 };

const METHODS = new Map(BRIDGE_PROTOCOL.methods.map((method) => [method.id, method]));
const EVENTS = new Map(BRIDGE_PROTOCOL.events.map((event) => [event.id, event]));
const NATIVE_CODES = new Map();
for (const entry of BRIDGE_PROTOCOL.nativeCodeRegistry) {
  for (const alias of entry.aliases) NATIVE_CODES.set(alias, entry);
}

export function getMethodDefinition(id) {
  return typeof id === 'string' ? METHODS.get(id) || null : null;
}

export function getEventDefinition(id) {
  return typeof id === 'string' ? EVENTS.get(id) || null : null;
}

export function getCallerArguments(method) {
  if (!method?.callbackBinding || method.callbackBinding.type !== 'argument') return method?.args || [];
  return method.args.filter((_, index) => index !== method.callbackBinding.index);
}

export function buildWireArguments(method, callerArgs, requestId) {
  if (!method || !Array.isArray(callerArgs)) throw new SuperSDKError('INVALID_ARGUMENT');
  const callerDefinitions = getCallerArguments(method);
  if (callerArgs.length > callerDefinitions.length) throw new SuperSDKError('INVALID_ARGUMENT');
  const required = callerDefinitions.filter((argument) => argument.required).length;
  if (callerArgs.length < required) throw new SuperSDKError('INVALID_ARGUMENT');

  const validated = callerDefinitions.map((argument, index) => {
    const value = callerArgs[index];
    if (value === undefined && !argument.required) return value;
    validateWireValue(argument.type, value);
    return value;
  });

  const binding = method.callbackBinding;
  if (!binding) return validated;
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 80) {
    throw new SuperSDKError('INVALID_ARGUMENT');
  }
  if (binding.type === 'argument') {
    const nativeArgs = [];
    let callerIndex = 0;
    for (let index = 0; index < method.args.length; index += 1) {
      nativeArgs.push(index === binding.index ? requestId : validated[callerIndex++]);
    }
    return nativeArgs;
  }
  if (binding.type === 'jsonField') {
    const nativeArgs = [...validated];
    const source = nativeArgs[binding.argIndex];
    let parsed;
    try { parsed = JSON.parse(source); } catch (cause) {
      throw new SuperSDKError('INVALID_ARGUMENT', { cause });
    }
    if (!isPlainObject(parsed) || Object.prototype.hasOwnProperty.call(parsed, binding.field)) {
      throw new SuperSDKError('INVALID_ARGUMENT');
    }
    parsed[binding.field] = requestId;
    nativeArgs[binding.argIndex] = stableJson(parsed);
    return nativeArgs;
  }
  throw new SuperSDKError('PROTOCOL_MISMATCH');
}

export function decodeResultEnvelope(envelope) {
  if (!isPlainObject(envelope) || typeof envelope.code !== 'string' || envelope.code.trim() === '') {
    throw new SuperSDKError('PROTOCOL_MISMATCH');
  }
  const nativeCode = envelope.code.trim();
  if (nativeCode === 'SUCCESS') return envelope.data;
  const registered = NATIVE_CODES.get(nativeCode);
  if (!registered) {
    throw new SuperSDKError('BRIDGE_ERROR', {
      nativeCode: 'UNKNOWN',
      retryable: false,
      message: typeof envelope.message === 'string' && envelope.message ? envelope.message : undefined
    });
  }
  throw new SuperSDKError(registered.code, {
    nativeCode,
    retryable: registered.retryable,
    message: typeof envelope.message === 'string' && envelope.message ? envelope.message : undefined
  });
}

export function mapNativeErrorCode(nativeCode) {
  if (typeof nativeCode !== 'string' || nativeCode.trim() === '') {
    return Object.freeze({ code: 'PROTOCOL_MISMATCH', retryable: false });
  }
  const normalized = nativeCode.trim();
  const entry = NATIVE_CODES.get(normalized);
  return entry
    ? Object.freeze({ code: entry.code, nativeCode: normalized, retryable: entry.retryable })
    : Object.freeze({ code: 'BRIDGE_ERROR', nativeCode: 'UNKNOWN', retryable: false });
}

function validateWireValue(type, value) {
  if (type === 'json') {
    if (typeof value !== 'string') throw new SuperSDKError('INVALID_ARGUMENT');
    try { JSON.parse(value); } catch (cause) { throw new SuperSDKError('INVALID_ARGUMENT', { cause }); }
    return;
  }
  if (typeof value !== type || (type === 'number' && !Number.isFinite(value))) {
    throw new SuperSDKError('INVALID_ARGUMENT');
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]';
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
