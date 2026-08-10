import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/index.js';
import { createTarget, deferred, memoryStorage, response } from './helpers.mjs';

test('granted_and_revoked_consent_controls_identity_persistence_reporting_and_settings_independently', async function granted_and_revoked_consent_controls_identity_persistence_reporting_and_settings_independently() {
  const storage = memoryStorage();
  const pending = deferred();
  const started = deferred();
  const target = createTarget((_url, options) => new Promise((resolve, reject) => {
    started.resolve();
    options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    pending.promise.then(resolve, reject);
  }), storage);
  const sdk = createSuperSDK({ target });
  sdk.init({ spid: 'ab12cd34' });
  await sdk.setAnalyticsConsent('granted');
  assert.ok((await sdk.getEnv()).deviceId);
  await sdk.reportEvent('open');
  const flushing = sdk.flush();
  await started.promise;
  const revoking = sdk.setAnalyticsConsent('denied');
  await revoking;
  const result = await flushing;
  assert.equal(result.reason, 'consent_revoked');
  assert.equal(storage.getItem('supersdk_device_id'), null);
  assert.equal(sdk.getDeliveryState().pending, 0);
});

test('denied_explicit_device_id_and_storage_failure_never_persist_or_upload_identity', async function denied_explicit_device_id_and_storage_failure_never_persist_or_upload_identity() {
  let uploads = 0;
  const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const sdk = createSuperSDK({ target: createTarget(async () => { uploads += 1; return response(200, { code: 'SUCCESS' }); }, storage) });
  sdk.init({ spid: 'ab12cd34', deviceId: 'explicit-secret', analyticsConsent: 'denied' });
  assert.equal((await sdk.getEnv()).deviceId, '');
  await assert.rejects(sdk.reportEvent('open'), (error) => error.code === 'CONSENT_DENIED');
  assert.equal(uploads, 0);
});
