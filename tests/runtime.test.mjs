import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/index.js';
import { createTarget, memoryStorage, response } from './helpers.mjs';

test('init_and_initFallback_have_same_observable_config_behavior', async function init_and_initFallback_have_same_observable_config_behavior() {
  const make = () => createSuperSDK({ target: createTarget(async () => response(200, { code: 'SUCCESS', data: {} })) });
  const one = make();
  const two = make();
  one.init({ spid: 'ab12cd34', environment: 'staging' });
  two.initFallback({ spid: 'ab12cd34', environment: 'staging' });
  assert.deepEqual(await one.getEnv(), await two.getEnv());
  assert.equal(one.getAnalyticsConsent(), 'denied');
  assert.equal(two.getAnalyticsConsent(), 'denied');
});

test('legacy_global_and_ready_contract_survives_iife_load', async function legacy_global_and_ready_contract_survives_iife_load() {
  let ready = 0;
  const target = createTarget(async () => response(200, { code: 'SUCCESS', data: {} }));
  target.appbridge = { onJSBridgeReady() { ready += 1; } };
  const sdk = createSuperSDK({ target });
  assert.equal(target.SuperSDK, undefined);
  assert.equal(target.JSBridge, undefined);
  sdk.init({ spid: 'ab12cd34' });
  assert.equal(typeof target.JSBridge.subscribeHandler, 'function');
  assert.equal(ready, 1);
  sdk.installGlobal();
  assert.equal(target.SuperSDK, sdk);
  assert.equal(ready, 2);
});

test('denied_first_init_removes_legacy_identity_and_outbox_across_reload', async function denied_first_init_removes_legacy_identity_and_outbox_across_reload() {
  const storage = memoryStorage({ supersdk_device_id: 'legacy-id', supersdk_outbox: 'private', supersdk_analytics_outbox: 'private' });
  const target = createTarget(async () => response(200, { code: 'SUCCESS', data: {} }), storage);
  const sdk = createSuperSDK({ target });
  sdk.init({ spid: 'ab12cd34' });
  assert.equal((await sdk.getEnv()).deviceId, '');
  assert.equal(storage.getItem('supersdk_device_id'), null);
  assert.equal(storage.getItem('supersdk_outbox'), null);
  await assert.rejects(sdk.reportEvent('open'), (error) => error.code === 'CONSENT_DENIED');
  assert.deepEqual(await sdk.getHostSettings(), {});
});
