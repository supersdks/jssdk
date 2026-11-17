import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/index.js';
import { createBridgeMock } from '../src/mock.js';
import { BRIDGE_HUB_SYMBOL } from '../src/bridge/callback-hub.js';

test('target hub isolates owners, delegates foreign traffic, detaches on identity drift and CAS restores', async () => {
  const foreignCalls = [];
  const foreign = {
    subscribeHandler(...args) { foreignCalls.push(args); },
    onBackPressed() { foreignCalls.push(['back']); return true; }
  };
  const mock = createBridgeMock({ target: { JSBridge: foreign } });
  const first = createSuperSDK({ target: mock.target, random: () => 0.1 });
  const second = createSuperSDK({ target: mock.target, random: () => 0.2 });
  await Promise.all([first.bridge.ready(), second.bridge.ready()]);
  assert.equal(mock.calls.filter((call) => call.methodId === 'onJSBridgeReady').length, 1);
  assert.notEqual(mock.target.JSBridge, foreign);

  mock.queueResult('getEnv', { code: 'SUCCESS', data: { owner: 1 } });
  mock.queueResult('getEnv', { code: 'SUCCESS', data: { owner: 2 } });
  assert.deepEqual(await Promise.all([first.bridge.request('getEnv', []), second.bridge.request('getEnv', [])]), [{ owner: 1 }, { owner: 2 }]);
  const ids = mock.calls.filter((call) => call.methodId === 'getEnv').map((call) => call.args[0]);
  assert.notEqual(ids[0].split(':')[0], ids[1].split(':')[0]);

  mock.target.JSBridge.subscribeHandler('UNKNOWN', 'foreign-key', { private: true });
  assert.equal(foreignCalls.length, 1);
  assert.equal(mock.target.JSBridge.onBackPressed(), true);

  const pending = first.bridge.request('getEnv', []);
  const replacement = { subscribeHandler() {}, onBackPressed: () => false };
  mock.target.JSBridge = replacement;
  assert.equal(first.bridge.getBridgeState().reasonCode, 'CALLBACK_HUB_REPLACED');
  await assert.rejects(pending, (error) => error.code === 'BRIDGE_DEGRADED' && error.reasonCode === 'CALLBACK_HUB_REPLACED');
  assert.equal(mock.target.JSBridge, replacement);
  assert.equal(mock.target[BRIDGE_HUB_SYMBOL], undefined);

  const third = createSuperSDK({ target: mock.target });
  await third.bridge.ready();
  assert.notEqual(mock.target.JSBridge, replacement);
  third.bridge.dispose();
  assert.equal(mock.target.JSBridge, replacement);
  second.bridge.dispose();
  first.bridge.dispose();
});

test('listener and foreign handler failures are isolated and produce metadata diagnostics', async () => {
  const records = [];
  const mock = createBridgeMock({ target: { JSBridge: { subscribeHandler() { throw new Error('secret'); } } } });
  const sdk = createSuperSDK({ target: mock.target });
  sdk.onDiagnostic((entry) => records.push(entry));
  await sdk.bridge.ready();
  sdk.bridge.subscribe('broadcast', () => { throw new Error('private payload'); });
  assert.doesNotThrow(() => mock.emitEvent('BROADCAST', 'x', { token: 'CANARY' }));
  assert.doesNotThrow(() => mock.target.JSBridge.subscribeHandler('UNKNOWN', 'x', { token: 'CANARY' }));
  assert.ok(records.some((entry) => entry.outcome === 'listener_error'));
  assert.doesNotMatch(JSON.stringify(records), /CANARY|private payload|secret/);
});
