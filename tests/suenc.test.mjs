import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSuperSDK } from '../src/index.js';
import { decodeSuEnc, getSuEncCapabilities } from '../src/suenc/codec.js';
import { SUENC_PROTOCOL, SUENC_GOLDEN_VECTORS } from '../src/suenc/generated-contract.js';
import { assertSDKError, createTarget, response } from './helpers.mjs';

const CODEC = SUENC_GOLDEN_VECTORS.codec;

test('suenc_generated_contract_matches_the_protocol_source_of_truth', async function suenc_generated_contract_matches_the_protocol_source_of_truth() {
  const root = resolve(import.meta.dirname, '..');
  const source = JSON.parse(await readFile(resolve(root, 'protocol/suenc-v1.json'), 'utf8'));
  const golden = JSON.parse(await readFile(resolve(root, 'protocol/suenc-v1-golden.json'), 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify(SUENC_PROTOCOL)), source);
  assert.deepEqual(JSON.parse(JSON.stringify(SUENC_GOLDEN_VECTORS)), golden);
  // alphabet 必须是标准 Base64 64 字符的合法全排列（发布后永不可改）
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const alphabet = source.codecs[CODEC].alphabet;
  assert.equal(alphabet.length, 64);
  assert.equal(new Set(alphabet).size, 64);
  assert.equal([...alphabet].sort().join(''), [...standard].sort().join(''));
  assert.notEqual(alphabet, standard);
});

test('suenc_golden_encode_vectors_decode_back_to_the_exact_plaintext', function suenc_golden_encode_vectors_decode_back_to_the_exact_plaintext() {
  for (const vector of SUENC_GOLDEN_VECTORS.encode) {
    assert.equal(decodeSuEnc(vector.encoded, CODEC), vector.plaintext, `vector ${vector.name}`);
    // plaintextHex 是跨语言比对的字节级锚点
    assert.equal(Buffer.from(vector.plaintext, 'utf8').toString('hex'), vector.plaintextHex, `vector ${vector.name}`);
  }
  // 三种字节余数与空串都必须被覆盖
  const remainders = new Set(SUENC_GOLDEN_VECTORS.encode.map((vector) => Buffer.from(vector.plaintext, 'utf8').length % 3));
  assert.deepEqual([...remainders].sort(), [0, 1, 2]);
  assert.ok(SUENC_GOLDEN_VECTORS.encode.some((vector) => vector.plaintext === ''));
});

test('suenc_decode_tolerates_ascii_whitespace_per_contract', function suenc_decode_tolerates_ascii_whitespace_per_contract() {
  for (const vector of SUENC_GOLDEN_VECTORS.whitespaceTolerant) {
    assert.equal(decodeSuEnc(vector.encoded, CODEC), vector.plaintext, `vector ${vector.name}`);
  }
});

test('suenc_golden_decode_error_vectors_raise_the_exact_error_code', function suenc_golden_decode_error_vectors_raise_the_exact_error_code() {
  for (const vector of SUENC_GOLDEN_VECTORS.decodeErrors) {
    assert.throws(
      () => decodeSuEnc(vector.encoded, CODEC),
      (error) => assertSDKError(error, vector.error, error.retryable),
      `vector ${vector.name}`
    );
  }
});

test('suenc_unknown_codec_is_rejected_and_never_falls_back_to_another_table', function suenc_unknown_codec_is_rejected_and_never_falls_back_to_another_table() {
  const { codec, error } = SUENC_GOLDEN_VECTORS.unknownCodec;
  const valid = SUENC_GOLDEN_VECTORS.encode.find((vector) => vector.plaintext !== '');
  assert.throws(() => decodeSuEnc(valid.encoded, codec), (raised) => assertSDKError(raised, error, false));
  for (const bad of ['', null, undefined, 'B64T1']) {
    assert.throws(() => decodeSuEnc(valid.encoded, bad), (raised) => assertSDKError(raised, 'UNSUPPORTED_SUENC_CODEC', false));
  }
});

test('suenc_capabilities_report_the_bundled_codecs', function suenc_capabilities_report_the_bundled_codecs() {
  const capabilities = getSuEncCapabilities();
  assert.equal(capabilities.supported, true);
  assert.deepEqual([...capabilities.codecs], Object.keys(SUENC_PROTOCOL.codecs));
  assert.ok(capabilities.codecs.includes(CODEC));
  assert.ok(Object.isFrozen(capabilities));
});

test('suenc_capabilities_and_decode_are_exposed_on_the_sdk_instance', function suenc_capabilities_and_decode_are_exposed_on_the_sdk_instance() {
  const sdk = createSuperSDK({ target: createTarget(async () => response(200, {})) });
  assert.equal(typeof sdk.getSuEncCapabilities, 'function');
  assert.equal(typeof sdk.decodeSuEnc, 'function');
  const vector = SUENC_GOLDEN_VECTORS.encode.find((item) => item.plaintext.includes('SUCCESS'));
  assert.equal(sdk.decodeSuEnc(vector.encoded, CODEC), vector.plaintext);
});

test('web_settings_decodes_a_suenc_encoded_envelope_transparently', async function web_settings_decodes_a_suenc_encoded_envelope_transparently() {
  const envelope = JSON.stringify({ code: 'SUCCESS', data: { is_premium: true } });
  const encoded = encodeWithContract(envelope);
  const sdk = createSuperSDK({
    target: createTarget(async () => response(200, encoded, { 'X-Su-Enc': CODEC }))
  });
  sdk.init({ spid: 'ab12cd34', settings: { cacheTtlMs: 1 } });
  assert.deepEqual(await sdk.getHostSettings('home'), { is_premium: true });
  sdk.clearSettingsCache();
});

test('web_settings_rejects_a_corrupt_suenc_body_without_falling_back_to_plaintext', async function web_settings_rejects_a_corrupt_suenc_body_without_falling_back_to_plaintext() {
  const sdk = createSuperSDK({
    target: createTarget(async () => response(200, '!!!not-a-valid-body!!!', { 'X-Su-Enc': CODEC }))
  });
  sdk.init({ spid: 'ab12cd34', settings: { cacheTtlMs: 1 } });
  await assert.rejects(sdk.getHostSettings('home'), (error) => assertSDKError(error, 'SUENC_DECODE_FAILED', false));
  sdk.clearSettingsCache();
});

test('web_settings_rejects_an_unknown_codec_instead_of_reading_the_body', async function web_settings_rejects_an_unknown_codec_instead_of_reading_the_body() {
  const plaintext = JSON.stringify({ code: 'SUCCESS', data: { leaked: true } });
  const sdk = createSuperSDK({
    target: createTarget(async () => response(200, plaintext, { 'X-Su-Enc': 'b64t9' }))
  });
  sdk.init({ spid: 'ab12cd34', settings: { cacheTtlMs: 1 } });
  await assert.rejects(sdk.getHostSettings('home'), (error) => assertSDKError(error, 'UNSUPPORTED_SUENC_CODEC', false));
  sdk.clearSettingsCache();
});

test('web_settings_without_the_header_keeps_the_existing_plaintext_protocol', async function web_settings_without_the_header_keeps_the_existing_plaintext_protocol() {
  const sdk = createSuperSDK({
    target: createTarget(async () => response(200, { code: 'SUCCESS', data: { plain: 1 } }))
  });
  sdk.init({ spid: 'ab12cd34', settings: { cacheTtlMs: 1 } });
  assert.deepEqual(await sdk.getHostSettings('home'), { plain: 1 });
  sdk.clearSettingsCache();
});

function encodeWithContract(text) {
  const alphabet = SUENC_PROTOCOL.codecs[CODEC].alphabet;
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
