import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/index.js';
import { createBridgeMock } from '../src/mock.js';

test('one thousand mixed terminal paths return callback and listener counts to baseline', async () => {
  const mock = createBridgeMock();
  const diagnostics = [];
  const sdk = createSuperSDK({ target: mock.target });
  sdk.onDiagnostic((entry) => diagnostics.push(entry));
  await sdk.bridge.ready();
  const baseline = sdk.bridge.__debugCounts();

  for (let index = 0; index < 400; index += 1) {
    mock.queueResult('getEnv', { code: 'SUCCESS', data: { index } });
    assert.equal((await sdk.bridge.request('getEnv', [])).index, index);
  }
  for (let index = 0; index < 200; index += 1) {
    mock.queueResult('getEnv', { code: 'INVALID_ARGUMENT' });
    await assert.rejects(sdk.bridge.request('getEnv', []), (error) => error.code === 'INVALID_ARGUMENT');
  }
  for (let index = 0; index < 100; index += 1) {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(sdk.bridge.request('getEnv', [], { signal: controller.signal }), (error) => error.code === 'CANCELLED');
  }
  for (let index = 0; index < 100; index += 1) {
    mock.queueResult('downloadFile', { code: 'SUCCESS', data: { status: 'SUCCESS', filePath: `p${index}` } });
    await sdk.bridge.openStream('downloadFile', ['u', '{}', 'p']).completion;
  }
  for (let index = 0; index < 100; index += 1) {
    const unsubscribe = sdk.bridge.subscribe('broadcast', () => undefined);
    unsubscribe();
    unsubscribe();
  }
  for (let index = 0; index < 100; index += 1) {
    mock.queueResult('getEnv', { results: [
      { code: 'SUCCESS', data: { index } },
      { code: 'SUCCESS', data: { late: true } }
    ] });
    await sdk.bridge.request('getEnv', []);
  }
  await Promise.resolve();
  assert.deepEqual(sdk.bridge.__debugCounts(), baseline);
  assert.ok(diagnostics.filter((entry) => entry.outcome === 'orphan').length <= 100);
});
