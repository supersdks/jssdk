/**
 * User feedback (CA-F260916-user-feedback) · shared parameter contract.
 *
 * Mirrors the server-side limits in `super-console-main/src/modules/feedback/model.rs`
 * (the server stays the authority; this only rejects obviously invalid input before a
 * round trip). Used by both the in-app JSB path and the web fetch path.
 */

export const FEEDBACK_LIMITS = Object.freeze({
  scene: 64,
  subScene: 64,
  title: 200,
  content: 5000,
  userId: 128,
  extraBytes: 4 * 1024
});

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function charLength(value) {
  return Array.from(value).length;
}

function utf8Bytes(value) {
  const text = JSON.stringify(value);
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
  return unescape(encodeURIComponent(text)).length;
}

function requiredText(params, key, max) {
  const raw = params[key];
  if (typeof raw !== 'string') return { detail: `${key} must be a string` };
  const value = raw.trim();
  if (!value) return { detail: `${key} is required` };
  if (charLength(value) > max) return { detail: `${key} exceeds ${max} characters` };
  return { value };
}

function optionalText(params, key, max) {
  const raw = params[key];
  if (raw === undefined || raw === null) return { value: undefined };
  if (typeof raw !== 'string') return { detail: `${key} must be a string` };
  const value = raw.trim();
  if (!value) return { value: undefined };
  if (charLength(value) > max) return { detail: `${key} exceeds ${max} characters` };
  return { value };
}

/**
 * Validate and normalize `SuperSDK.submitFeedback(params)` input.
 * Returns `{ value }` with a trimmed camelCase object, or `{ detail }` describing the first
 * violation (callers wrap it in their runtime's error type).
 */
export function validateFeedbackParams(params) {
  if (!isPlainObject(params)) return { detail: 'params must be a plain object' };
  const fields = [
    ['scene', requiredText(params, 'scene', FEEDBACK_LIMITS.scene)],
    ['subScene', optionalText(params, 'subScene', FEEDBACK_LIMITS.subScene)],
    ['title', requiredText(params, 'title', FEEDBACK_LIMITS.title)],
    ['content', requiredText(params, 'content', FEEDBACK_LIMITS.content)],
    ['userId', optionalText(params, 'userId', FEEDBACK_LIMITS.userId)]
  ];
  const value = {};
  for (const [key, result] of fields) {
    if (result.detail) return { detail: result.detail };
    if (result.value !== undefined) value[key] = result.value;
  }
  if (params.extra !== undefined && params.extra !== null) {
    if (!isPlainObject(params.extra)) return { detail: 'extra must be a plain object' };
    let extra;
    try { extra = JSON.parse(JSON.stringify(params.extra)); } catch (_) { return { detail: 'extra must be JSON-serializable' }; }
    if (Object.keys(extra).length > 0) {
      if (utf8Bytes(extra) > FEEDBACK_LIMITS.extraBytes) return { detail: `extra exceeds ${FEEDBACK_LIMITS.extraBytes} bytes` };
      value.extra = extra;
    }
  }
  return { value };
}

/**
 * Map a normalized value onto the public ingest wire body (`POST /superapi/v2/feedback`,
 * snake_case). `basic` carries the runtime-supplied identity fields (spid/env/device/...).
 */
export function buildFeedbackWireBody(value, basic) {
  const body = {
    spid: basic.spid,
    env: basic.env,
    scene: value.scene,
    title: value.title,
    content: value.content
  };
  if (value.subScene) body.sub_scene = value.subScene;
  if (value.userId) body.user_id = value.userId;
  if (value.extra) body.extra = value.extra;
  for (const [key, wireKey] of [
    ['deviceId', 'device_id'],
    ['platform', 'platform'],
    ['appVersion', 'app_version'],
    ['sdkVersion', 'sdk_version'],
    ['osVersion', 'os_version'],
    ['deviceModel', 'device_model']
  ]) {
    if (typeof basic[key] === 'string' && basic[key]) body[wireKey] = basic[key];
  }
  return body;
}

/** Read the receipt out of the ingest envelope; `null` when the body is not a success. */
export function parseFeedbackReceipt(envelope) {
  if (!isPlainObject(envelope) || envelope.code !== 'SUCCESS') return null;
  const id = envelope.data && envelope.data.feedback_id;
  if (typeof id !== 'number' || !Number.isFinite(id)) return null;
  return Object.freeze({ feedbackId: id });
}
