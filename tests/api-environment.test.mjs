import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/index.js';
import { assertSDKError, createTarget, memoryStorage, response } from './helpers.mjs';

test('web_getAPIEnvironment_defaults_to_prod_and_follows_init_config', async function web_getAPIEnvironment_defaults_to_prod_and_follows_init_config() {
  const sdk = createSuperSDK({ target: createTarget(async () => response(200, { code: 'SUCCESS', data: {} })) });
  assert.equal(await sdk.getAPIEnvironment(), 'prod');
  sdk.init({ spid: 'ab12cd34', environment: 'staging' });
  assert.equal(await sdk.getAPIEnvironment(), 'staging');
});

test('web_setAPIEnvironment_rejects_before_init_and_rejects_invalid_values_without_mutation', async function web_setAPIEnvironment_rejects_before_init_and_rejects_invalid_values_without_mutation() {
  const sdk = createSuperSDK({ target: createTarget(async () => response(200, { code: 'SUCCESS', data: {} })) });
  await assert.rejects(sdk.setAPIEnvironment('staging'), (error) => assertSDKError(error, 'NOT_INITIALIZED', false));

  sdk.init({ spid: 'ab12cd34' });
  for (const invalid of ['', ' staging', 'STAGING', 'prod ', 'environment', 123, null, undefined]) {
    await assert.rejects(sdk.setAPIEnvironment(invalid), (error) => error.code === 'INVALID_ARGUMENT');
    assert.equal(await sdk.getAPIEnvironment(), 'prod', 'invalid value must not land');
  }
});

test('web_settings_requests_follow_environment_and_cache_is_isolated_per_env', async function web_settings_requests_follow_environment_and_cache_is_isolated_per_env() {
  const urls = [];
  const sdk = createSuperSDK({ target: createTarget(async (url) => {
    urls.push(String(url));
    return response(200, { code: 'SUCCESS', data: { probe: urls.length } });
  }) });
  sdk.init({ spid: 'ab12cd34' });

  await sdk.getHostSettings('flags');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /env=prod/);

  await sdk.setAPIEnvironment('staging');
  await sdk.getHostSettings('flags');
  assert.equal(urls.length, 2, 'env switch must miss the prod cache entry');
  assert.match(urls[1], /env=staging/);

  await sdk.setAPIEnvironment('prod');
  await sdk.getHostSettings('flags');
  assert.equal(urls.length, 2, 'switching back must hit the original prod cache entry');
});

test('web_reporter_flushes_old_env_events_before_switch_then_uses_new_env', async function web_reporter_flushes_old_env_events_before_switch_then_uses_new_env() {
  const calls = [];
  const sdk = createSuperSDK({ target: createTarget(async (url, options) => {
    calls.push({ url: String(url), options });
    return response(200, { code: 'SUCCESS' });
  }) });
  sdk.init({ spid: 'ab12cd34', analyticsConsent: 'granted' });

  await sdk.reportEvent('probe_old_env', {});
  await sdk.setAPIEnvironment('staging');

  const oldEnvCall = calls.find((call) => call.url.includes('/v2/reportEvent'));
  assert.ok(oldEnvCall, 'pending events must be flushed during the switch');
  assert.equal(oldEnvCall.options.headers['X-Super-API-ENV'], 'prod', 'flush happens before the value swap');
  assert.equal(JSON.parse(oldEnvCall.options.body).basic_data.env, 'prod');

  await sdk.reportEvent('probe_new_env', {});
  await sdk.flush();
  const newEnvCall = calls.filter((call) => call.url.includes('/v2/reportEvent')).at(-1);
  assert.notEqual(newEnvCall, oldEnvCall);
  assert.equal(newEnvCall.options.headers['X-Super-API-ENV'], 'staging');
  assert.equal(JSON.parse(newEnvCall.options.body).basic_data.env, 'staging');
});

test('web_same_value_set_is_noop_and_does_not_flush', async function web_same_value_set_is_noop_and_does_not_flush() {
  const calls = [];
  const sdk = createSuperSDK({ target: createTarget(async (url, options) => {
    calls.push({ url: String(url), options });
    return response(200, { code: 'SUCCESS' });
  }) });
  sdk.init({ spid: 'ab12cd34', analyticsConsent: 'granted' });

  await sdk.reportEvent('stays_queued', {});
  await sdk.setAPIEnvironment('prod');

  assert.equal(calls.filter((call) => call.url.includes('/v2/reportEvent')).length, 0, 'same-value set must not trigger a flush');
  assert.equal(await sdk.getAPIEnvironment(), 'prod');
});

test('native_set_rejects_unsupported_and_get_passes_through_bridge', async function native_set_rejects_unsupported_and_get_passes_through_bridge() {
  const envCallbackIds = [];
  const target = createTarget(async () => response(200, { code: 'SUCCESS' }), memoryStorage());
  target.console = { log() {}, warn() {}, error() {} };
  target.setTimeout = setTimeout;
  target.clearTimeout = clearTimeout;
  target.appbridge = {
    onJSBridgeReady() {},
    getEnvAsync(callbackId) { envCallbackIds.push(callbackId); }
  };
  const sdk = createSuperSDK({ target });
  sdk.init({ spid: 'ab12cd34' });

  await assert.rejects(sdk.setAPIEnvironment('staging'), (error) => assertSDKError(error, 'UNSUPPORTED', false));

  const bridged = sdk.getAPIEnvironment();
  target.JSBridge.subscribeHandler('ASYNC_CALLBACK', envCallbackIds[0], { code: 'SUCCESS', data: { environment: 'staging' } });
  assert.equal(await bridged, 'staging');

  const missingEnv = sdk.getAPIEnvironment();
  target.JSBridge.subscribeHandler('ASYNC_CALLBACK', envCallbackIds[1], { code: 'SUCCESS', data: {} });
  assert.equal(await missingEnv, 'prod', 'missing environment field falls back to prod');
});
