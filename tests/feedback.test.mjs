import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuperSDK, SDK_VERSION } from '../src/index.js';
import { SUENC_PROTOCOL, SUENC_GOLDEN_VECTORS } from '../src/suenc/generated-contract.js';
import { buildFeedbackWireBody, FEEDBACK_LIMITS, parseFeedbackReceipt, validateFeedbackParams } from '../src/feedback/params.js';
import { assertSDKError, createTarget, response } from './helpers.mjs';

// CA-F260916-user-feedback · SuperSDK.submitFeedback on the web runtime (no appbridge):
// POST {baseUrl}/v2/feedback, identity headers, failover only on transient failures,
// suenc-aware envelope reading, shared parameter contract.

const OK = { code: 'SUCCESS', message: '', data: { feedback_id: 42 }, extra: {} };
const PARAMS = { scene: 'settings', subScene: 'about', title: ' Crash on open ', content: 'it crashes', userId: 'u_1', extra: { page: 'home' } };

function sdkWith(fetchImpl, init = {}) {
  const sdk = createSuperSDK({ target: createTarget(fetchImpl) });
  sdk.init({ spid: 'ab12cd34', environment: 'staging', ...init });
  return sdk;
}

test('feedback_web_posts_the_snake_case_wire_body_with_identity_headers_and_resolves_the_receipt', async function feedback_web_posts_the_snake_case_wire_body_with_identity_headers_and_resolves_the_receipt() {
  const calls = [];
  const sdk = sdkWith(async (url, options) => { calls.push({ url, options }); return response(200, OK); }, { baseUrls: ['https://api.example.com/superapi'] });
  const receipt = await sdk.submitFeedback(PARAMS);
  assert.deepEqual(receipt, { feedbackId: 42 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.com/superapi/v2/feedback');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['X-Aid'], 'ab12cd34');
  assert.equal(calls[0].options.headers['X-Super-API-ENV'], 'staging');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body, {
    spid: 'ab12cd34',
    env: 'staging',
    scene: 'settings',
    sub_scene: 'about',
    title: 'Crash on open',
    content: 'it crashes',
    user_id: 'u_1',
    extra: { page: 'home' },
    platform: 'web',
    sdk_version: SDK_VERSION
  });
  assert.equal(Object.hasOwn(body, 'device_id'), false, 'no device id without analytics consent');
});

test('feedback_web_rejects_invalid_params_locally_without_a_network_call', async function feedback_web_rejects_invalid_params_locally_without_a_network_call() {
  let calls = 0;
  const sdk = sdkWith(async () => { calls += 1; return response(200, OK); });
  const bad = [
    undefined,
    null,
    'string',
    [],
    {},
    { ...PARAMS, scene: '' },
    { ...PARAMS, scene: 'x'.repeat(FEEDBACK_LIMITS.scene + 1) },
    { ...PARAMS, title: '   ' },
    { ...PARAMS, title: '反'.repeat(FEEDBACK_LIMITS.title + 1) },
    { ...PARAMS, content: 'x'.repeat(FEEDBACK_LIMITS.content + 1) },
    { ...PARAMS, userId: 12 },
    { ...PARAMS, extra: ['not', 'object'] },
    { ...PARAMS, extra: { blob: 'x'.repeat(FEEDBACK_LIMITS.extraBytes) } }
  ];
  for (const params of bad) {
    await assert.rejects(sdk.submitFeedback(params), (error) => assertSDKError(error, 'INVALID_ARGUMENT', false));
  }
  assert.equal(calls, 0);
  // 200 CJK chars sit exactly on the character limit (limits are characters, not bytes)
  assert.deepEqual(await sdk.submitFeedback({ ...PARAMS, title: '反'.repeat(FEEDBACK_LIMITS.title) }), { feedbackId: 42 });
  assert.equal(calls, 1);
});

test('feedback_web_requires_init_and_never_falls_back_to_plaintext_on_suenc_downgrade', async function feedback_web_requires_init_and_never_falls_back_to_plaintext_on_suenc_downgrade() {
  const uninitialized = createSuperSDK({ target: createTarget(async () => response(200, OK)) });
  await assert.rejects(uninitialized.submitFeedback(PARAMS), (error) => assertSDKError(error, 'NOT_INITIALIZED', false));

  const codec = SUENC_GOLDEN_VECTORS.codec;
  const encoded = encodeWithContract(JSON.stringify(OK), SUENC_PROTOCOL.codecs[codec].alphabet);
  const decoded = sdkWith(async () => response(200, encoded, { 'X-Su-Enc': codec }));
  assert.deepEqual(await decoded.submitFeedback(PARAMS), { feedbackId: 42 });

  const corrupt = sdkWith(async () => response(200, '!!!not-a-valid-body!!!', { 'X-Su-Enc': codec }));
  await assert.rejects(corrupt.submitFeedback(PARAMS), (error) => assertSDKError(error, 'SUENC_DECODE_FAILED', false));
});

test('feedback_web_fails_over_only_on_transient_failures_and_surfaces_business_rejections', async function feedback_web_fails_over_only_on_transient_failures_and_surfaces_business_rejections() {
  const baseUrls = ['https://a.example.com/superapi', 'https://b.example.com/superapi'];

  // 503 on the first base URL → second answers
  let urls = [];
  let queue = [response(503, {}), response(200, OK)];
  let sdk = sdkWith(async (url) => { urls.push(url); return queue.shift(); }, { baseUrls });
  assert.deepEqual(await sdk.submitFeedback(PARAMS), { feedbackId: 42 });
  assert.deepEqual(urls, ['https://a.example.com/superapi/v2/feedback', 'https://b.example.com/superapi/v2/feedback']);

  // network error everywhere → last error, both tried
  urls = [];
  sdk = sdkWith(async (url) => { urls.push(url); throw new TypeError('offline'); }, { baseUrls });
  await assert.rejects(sdk.submitFeedback(PARAMS), (error) => assertSDKError(error, 'NETWORK_ERROR', true));
  assert.equal(urls.length, 2);

  // 429 is per-spid/ip state on the same CA → no failover
  urls = [];
  sdk = sdkWith(async (url) => { urls.push(url); return response(429, {}); }, { baseUrls });
  await assert.rejects(sdk.submitFeedback(PARAMS), (error) => assertSDKError(error, 'RATE_LIMITED', true));
  assert.equal(urls.length, 1);

  // 200-envelope business rejection → INVALID_ARGUMENT carrying the server code, no failover
  urls = [];
  sdk = sdkWith(async (url) => { urls.push(url); return response(200, { code: 'NOT_FOUND', message: 'not found', data: {}, extra: {} }); }, { baseUrls });
  await assert.rejects(sdk.submitFeedback(PARAMS), (error) => {
    assertSDKError(error, 'INVALID_ARGUMENT', false);
    assert.equal(error.nativeCode, 'NOT_FOUND');
    assert.equal(error.message, 'not found');
    return true;
  });
  assert.equal(urls.length, 1);

  // 2xx without a receipt is a protocol mismatch — NOT retried elsewhere: the first CA may
  // already have stored the row, and a submit is not idempotent.
  urls = [];
  sdk = sdkWith(async (url) => { urls.push(url); return response(200, { code: 'SUCCESS', data: {} }); }, { baseUrls });
  await assert.rejects(sdk.submitFeedback(PARAMS), (error) => assertSDKError(error, 'PROTOCOL_MISMATCH', false));
  assert.equal(urls.length, 1);
});

test('feedback_params_contract_is_pure_and_mirrors_the_server_limits', function feedback_params_contract_is_pure_and_mirrors_the_server_limits() {
  assert.deepEqual(FEEDBACK_LIMITS, { scene: 64, subScene: 64, title: 200, content: 5000, userId: 128, extraBytes: 4096 });
  assert.deepEqual(validateFeedbackParams({ scene: ' s ', title: 't', content: 'c', subScene: '  ', userId: null, extra: {} }), {
    value: { scene: 's', title: 't', content: 'c' }
  });
  assert.equal(validateFeedbackParams({ scene: 's', title: 't' }).detail, 'content must be a string');
  assert.equal(validateFeedbackParams({ scene: 's', title: 't', content: 'c', extra: { d: new Date(0) } }).value.extra.d, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(
    buildFeedbackWireBody({ scene: 's', title: 't', content: 'c' }, { spid: 'ab12cd34', env: 'prod', deviceId: '', platform: 'web', appVersion: undefined }),
    { spid: 'ab12cd34', env: 'prod', scene: 's', title: 't', content: 'c', platform: 'web' }
  );
  assert.deepEqual(parseFeedbackReceipt({ code: 'SUCCESS', data: { feedback_id: 7 } }), { feedbackId: 7 });
  assert.equal(parseFeedbackReceipt({ code: 'SUCCESS', data: { feedback_id: '7' } }), null);
  assert.equal(parseFeedbackReceipt({ code: 'INVALID_REQUEST' }), null);
});

function encodeWithContract(text, alphabet) {
  const bytes = Buffer.from(text, 'utf8');
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index];
    const b1 = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const b2 = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const remaining = bytes.length - index;
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += remaining > 1 ? alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += remaining > 2 ? alphabet[b2 & 0x3f] : '=';
  }
  return out;
}
