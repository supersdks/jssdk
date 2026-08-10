import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/index.js';
import { assertSDKError, createTarget, response } from './helpers.mjs';

test('settings_rejects_stable_supersdk_errors_for_invalid_argument_and_transient_failures_without_lkg', async function settings_rejects_stable_supersdk_errors_for_invalid_argument_and_transient_failures_without_lkg() {
  const cases = [
    [response(429, {}), 'RATE_LIMITED'],
    [response(503, {}), 'UNAVAILABLE'],
    [new TypeError('offline token=secret'), 'NETWORK_ERROR']
  ];
  for (const [outcome, code] of cases) {
    const target = createTarget(async () => { if (outcome instanceof Error) throw outcome; return outcome; });
    const sdk = createSuperSDK({ target });
    sdk.init({ spid: 'ab12cd34' });
    await assert.rejects(sdk.getHostSettings('x'), (error) => assertSDKError(error, code, true));
  }
  const invalid = createSuperSDK({ target: createTarget(async () => response(200, { code: 'SUCCESS', data: {} })) });
  invalid.init({ spid: 'ab12cd34' });
  await assert.rejects(invalid.getHostSettings('x', []), (error) => assertSDKError(error, 'INVALID_ARGUMENT', false));
});

test('settings_not_found_and_lkg_branches_do_not_pollute_or_overwrite_cache', async function settings_not_found_and_lkg_branches_do_not_pollute_or_overwrite_cache() {
  let now = 0;
  const queue = [
    response(200, { code: 'SUCCESS', data: { color: 'blue' } }),
    response(503, {}),
    response(200, { code: 'NOT_FOUND', data: {} })
  ];
  const sdk = createSuperSDK({ target: createTarget(async () => queue.shift()), now: () => now });
  sdk.init({ spid: 'ab12cd34', settings: { cacheTtlMs: 1 } });
  assert.deepEqual(await sdk.getHostSettings('theme'), { color: 'blue' });
  now = 2;
  assert.deepEqual(await sdk.getHostSettings('theme'), { color: 'blue' });
  now = 4;
  assert.deepEqual(await sdk.getHostSettings('theme'), {});
});
