import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/index.js';
import { createTarget, deferred, response } from './helpers.mjs';

test('concurrent_equivalent_requests_share_one_observable_result_and_clear_cache_is_effective', async function concurrent_equivalent_requests_share_one_observable_result_and_clear_cache_is_effective() {
  const first = deferred();
  let calls = 0;
  const sdk = createSuperSDK({ target: createTarget(async () => {
    calls += 1;
    if (calls === 1) return first.promise;
    return response(200, { code: 'SUCCESS', data: { calls } });
  }) });
  sdk.init({ spid: 'ab12cd34' });
  const a = sdk.getHostSettings('x', { a: 1, b: 2 });
  const b = sdk.getHostSettings('x', { b: 2, a: 1 });
  first.resolve(response(200, { code: 'SUCCESS', data: { calls: 1 } }));
  assert.deepEqual(await a, { calls: 1 });
  assert.deepEqual(await b, { calls: 1 });
  assert.equal(calls, 1);
  sdk.clearSettingsCache();
  assert.deepEqual(await sdk.getHostSettings('x', { a: 1, b: 2 }), { calls: 2 });
});

test('clear_does_not_allow_an_old_inflight_response_to_refill_the_new_cache_generation', async function clear_does_not_allow_an_old_inflight_response_to_refill_the_new_cache_generation() {
  const stale = deferred();
  let calls = 0;
  const sdk = createSuperSDK({ target: createTarget(async () => {
    calls += 1;
    if (calls === 1) return stale.promise;
    return response(200, { code: 'SUCCESS', data: { generation: calls } });
  }) });
  sdk.init({ spid: 'ab12cd34' });

  const originalCaller = sdk.getHostSettings('x', { a: 1 });
  await waitFor(() => calls === 1);
  sdk.clearSettingsCache();
  stale.resolve(response(200, { code: 'SUCCESS', data: { generation: 1 } }));
  assert.deepEqual(await originalCaller, { generation: 1 }, 'the caller that started before clear may still receive its response');

  assert.deepEqual(await sdk.getHostSettings('x', { a: 1 }), { generation: 2 });
  assert.equal(calls, 2, 'a post-clear read must not receive the stale in-flight value');
  assert.deepEqual(await sdk.getHostSettings('x', { a: 1 }), { generation: 2 });
  assert.equal(calls, 2, 'only the new generation may populate the cache');
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for deferred fetch to begin');
}
