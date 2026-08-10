import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/index.js';
import { createTarget, response } from './helpers.mjs';

test('flush_handles_207_per_event_success_permanent_failure_and_retryable_failure_without_duplicate_successes', async function flush_handles_207_per_event_success_permanent_failure_and_retryable_failure_without_duplicate_successes() {
  const requests = [];
  let round = 0;
  const target = createTarget(async (_url, options) => {
    const payload = JSON.parse(options.body);
    requests.push(payload);
    const ids = payload.events.map((event) => event.event_param.evt_unique_id);
    round += 1;
    if (round === 1) {
      return response(207, {
        code: 'PARTIAL_INVALID_EVENT',
        successes: [{ index: 0, evt_unique_id: ids[0] }],
        failures: [
          { index: 1, evt_unique_id: '', error_code: 'INVALID_EVENT' },
          { index: 2, evt_unique_id: ids[2], error_code: 'PUBSUB_TIMEOUT' }
        ]
      });
    }
    return response(200, { code: 'SUCCESS', successes: [{ index: 0, evt_unique_id: ids[0] }] });
  });
  const sdk = createSuperSDK({ target, random: () => 0.5 });
  sdk.init({ spid: 'ab12cd34', analyticsConsent: 'granted', analytics: { baseBackoffMs: 1 } });
  const first = await sdk.reportEvent('one');
  await sdk.reportEvent('bad');
  const third = await sdk.reportEvent('retry');
  const result = await sdk.flush();
  assert.deepEqual({ sent: result.sent, discarded: result.discarded, retrying: result.retrying }, { sent: 1, discarded: 1, retrying: 1 });
  assert.equal(sdk.getDeliveryState().pending, 1);
  assert.equal(requests[0].events[0].event_param.evt_unique_id, first.eventId);
  assert.equal(requests[0].events[2].event_param.evt_unique_id, third.eventId);
  assert.equal(requests[1], undefined);
});

test('timeout_rate_limit_and_server_failure_retain_same_event_id_with_bounded_backoff', async function timeout_rate_limit_and_server_failure_retain_same_event_id_with_bounded_backoff() {
  let now = 0;
  const seen = [];
  const statuses = [429, 503, 200];
  const sdk = createSuperSDK({
    target: createTarget(async (_url, options) => {
      const body = JSON.parse(options.body);
      seen.push(body.events[0].event_param.evt_unique_id);
      return response(statuses.shift(), { code: statuses.length ? 'UPSTREAM_ERROR' : 'SUCCESS' });
    }),
    now: () => now,
    random: () => 0.5
  });
  sdk.init({ spid: 'ab12cd34', analyticsConsent: 'granted', analytics: { baseBackoffMs: 1, maxBackoffMs: 10 } });
  const queued = await sdk.reportEvent('retry');
  await sdk.flush();
  now = 1_000;
  await sdk.flush();
  now = 2_000;
  await sdk.flush();
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((id) => id === queued.eventId));
});

test('collector_OK_envelope_confirms_the_batch', async function collector_OK_envelope_confirms_the_batch() {
  const sdk = createSuperSDK({ target: createTarget(async () => response(200, { code: 'OK', successes: [], failures: [] })) });
  sdk.init({ spid: 'ab12cd34', analyticsConsent: 'granted' });
  await sdk.reportEvent('collector_contract');
  const result = await sdk.flush();
  assert.deepEqual({ sent: result.sent, pending: result.pending }, { sent: 1, pending: 0 });
});

test('non_207_2xx_without_a_success_envelope_retries_the_same_event_id', async function non_207_2xx_without_a_success_envelope_retries_the_same_event_id() {
  for (const body of [null, new SyntaxError('html response'), { code: 'BAD_REQUEST' }]) {
    let now = 0;
    const seen = [];
    const sdk = createSuperSDK({
      target: createTarget(async (_url, options) => {
        seen.push(JSON.parse(options.body).events[0].event_param.evt_unique_id);
        return response(200, body);
      }),
      now: () => now,
      random: () => 0.5
    });
    sdk.init({ spid: 'ab12cd34', analyticsConsent: 'granted' });
    const queued = await sdk.reportEvent('bad_success_envelope');
    const first = await sdk.flush();
    now = 1_000;
    await sdk.flush();

    assert.deepEqual({ sent: first.sent, retrying: first.retrying, pending: first.pending }, { sent: 0, retrying: 1, pending: 1 });
    assert.equal(sdk.getDeliveryState().lastOutcome.code, 'PROTOCOL_MISMATCH');
    assert.deepEqual(seen, [queued.eventId, queued.eventId]);
  }
});

test('malformed_207_items_retry_the_whole_batch_without_removing_any_event', async function malformed_207_items_retry_the_whole_batch_without_removing_any_event() {
  const malformedResponses = [
    (ids) => ({ successes: [{ evt_unique_id: ids[0] }, { evt_unique_id: ids[0] }], failures: [] }),
    (ids) => ({ successes: [{ evt_unique_id: ids[0] }], failures: [{ evt_unique_id: ids[0], error_code: 'INVALID_EVENT' }] }),
    (ids) => ({ successes: [{ index: 1, evt_unique_id: ids[0] }], failures: [] })
  ];

  for (const makeResponse of malformedResponses) {
    let now = 0;
    const batches = [];
    let requestCount = 0;
    const sdk = createSuperSDK({
      target: createTarget(async (_url, options) => {
        const ids = JSON.parse(options.body).events.map((event) => event.event_param.evt_unique_id);
        batches.push(ids);
        requestCount += 1;
        return requestCount === 1
          ? response(207, makeResponse(ids))
          : response(200, { code: 'SUCCESS' });
      }),
      now: () => now,
      random: () => 0.5
    });
    sdk.init({ spid: 'ab12cd34', analyticsConsent: 'granted' });
    const first = await sdk.reportEvent('first');
    const second = await sdk.reportEvent('second');
    const result = await sdk.flush();
    now = 1_000;
    await sdk.flush();

    assert.deepEqual({ sent: result.sent, discarded: result.discarded, retrying: result.retrying, pending: result.pending }, { sent: 0, discarded: 0, retrying: 2, pending: 2 });
    assert.equal(sdk.getDeliveryState().lastOutcome.code, 'SUCCESS');
    assert.deepEqual(batches, [[first.eventId, second.eventId], [first.eventId, second.eventId]]);
  }
});
