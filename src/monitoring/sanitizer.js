import { validateMonitoringEnvelope } from './generated-contract.js';

export function sanitizeEnvelope(input) {
  try {
    const topKeys = ['schema','envelopeId','sequence','emittedAtMs','category','signal','platform','context','summary'];
    const contextKeys = ['sdkVersion','containerVersion','webviewId','runtimeSessionId','runtimePageId','containerSessionId','containerPageId','navigationId','requestId'];
    const summaryKeys = ['api','state','outcome','latencyBucket','errorClass','fingerprint','locationClass','resourceClass','count','measurements'];
    const measurementKeys = ['metric','value','unit','availability'];
    if (!plainExact(input, topKeys) || !plainExact(input.context, contextKeys) || !plainExact(input.summary, summaryKeys)) return null;
    const context = copyData(input.context);
    const summary = copyData(input.summary, 'measurements');
    if (Object.hasOwn(input.summary, 'measurements')) {
      if (!Array.isArray(input.summary.measurements) || input.summary.measurements.length > 5) return null;
      summary.measurements = input.summary.measurements.map((item) => plainExact(item, measurementKeys) ? copyData(item) : null);
      if (summary.measurements.some((item) => item === null)) return null;
    }
    const value = {
      schema: input.schema, envelopeId: input.envelopeId, sequence: input.sequence,
      emittedAtMs: input.emittedAtMs, category: input.category, signal: input.signal,
      platform: input.platform, context, summary
    };
    return validateMonitoringEnvelope(value) ? deepFreeze(value) : null;
  } catch (_) { return null; }
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function plainExact(input, allowed) {
  if (!input || typeof input !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(input))) return false;
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  return keys.every((key) => descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key], 'value'));
}

function copyData(input, excluded) {
  const output = {};
  for (const key of Object.keys(input)) if (key !== excluded) output[key] = input[key];
  return output;
}
