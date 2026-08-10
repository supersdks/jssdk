import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/index.js';
import { createTarget, memoryStorage, response } from './helpers.mjs';

test('report_event_resolves_only_after_consent_approved_bounded_enqueue_with_stable_event_id', async function report_event_resolves_only_after_consent_approved_bounded_enqueue_with_stable_event_id() {
  const sdk = createSuperSDK({ target: createTarget(async () => response(200, { code: 'SUCCESS' })) });
  sdk.init({ spid: 'ab12cd34', analytics: { queueCapacity: 1 } });
  await assert.rejects(sdk.reportEvent('open'), (error) => error.code === 'CONSENT_DENIED');
  await sdk.setAnalyticsConsent('granted');
  const queued = await sdk.reportEvent('open', { page: 'home' });
  assert.match(queued.eventId, /^[0-9a-f-]{36}$/);
  assert.equal(queued.queued, true);
  await assert.rejects(sdk.reportEvent('second'), (error) => error.code === 'QUEUE_FULL');
});

test('init_rejects_a_batch_budget_that_cannot_send_a_permitted_event', function init_rejects_a_batch_budget_that_cannot_send_a_permitted_event() {
  const sdk = createSuperSDK({ target: createTarget(async () => response(200, { code: 'SUCCESS' })) });
  assert.throws(
    () => sdk.init({ spid: 'ab12cd34', analytics: { maxBatchBytes: (32 * 1024) - 1 } }),
    (error) => error.code === 'INVALID_ARGUMENT'
  );
});

test('queue_capacity_age_batch_payload_and_storage_limits_drop_or_retry_with_diagnostics', async function queue_capacity_age_batch_payload_and_storage_limits_drop_or_retry_with_diagnostics() {
  let now = 0;
  const storage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); }
  };
  const sdk = createSuperSDK({ target: createTarget(async () => response(503, {}), storage), now: () => now, random: () => 0.5 });
  const diagnostics = [];
  sdk.onDiagnostic((entry) => diagnostics.push(entry));
  sdk.init({ spid: 'ab12cd34', analytics: { maxAgeMs: 1, maxRetries: 1, queueCapacity: 2 } });
  await sdk.setAnalyticsConsent('granted');
  await assert.rejects(sdk.reportEvent('huge', { value: 'x'.repeat(40 * 1024) }), (error) => error.code === 'PAYLOAD_TOO_LARGE');
  await sdk.reportEvent('old');
  now = 2;
  const result = await sdk.flush();
  assert.equal(result.discarded, 1);
  assert.equal(result.pending, 0);
  assert.equal(sdk.getDeliveryState().persistent, false);
  assert.ok(diagnostics.some((entry) => entry.category === 'identity_storage'));
});
