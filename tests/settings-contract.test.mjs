import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/index.js';
import { createTarget, response } from './helpers.mjs';

test('settings_all_and_by_key_miss_return_empty_object_and_null_only_for_own_data_properties', async function settings_all_and_by_key_miss_return_empty_object_and_null_only_for_own_data_properties() {
  const responses = [
    response(200, { code: 'NOT_FOUND', data: {} }),
    response(200, { code: 'SUCCESS', data: 'primitive' }),
    response(200, { code: 'SUCCESS', data: { own: 7 } })
  ];
  const sdk = createSuperSDK({ target: createTarget(async () => responses.shift()) });
  sdk.init({ spid: 'ab12cd34', settings: { cacheTtlMs: 1 } });
  assert.deepEqual(await sdk.getHostSettings('missing'), {});
  assert.equal(await sdk.getHostSettingsByKey('own', 'primitive'), null);
  assert.equal(await sdk.getHostSettingsByKey('own', 'object'), 7);
  assert.equal(await sdk.getHostSettingsByKey('toString', 'object'), null);
  sdk.clearSettingsCache();
});
