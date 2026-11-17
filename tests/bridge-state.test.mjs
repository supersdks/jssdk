import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/index.js';
import { BRIDGE_PROTOCOL } from '../src/protocol.js';

test('bridge discovery has five stable states and does not silently fall back from bootstrap', async () => {
  assert.equal((await createSuperSDK({ target: {} }).bridge.ready()).status, 'absent');
  assert.equal((await createSuperSDK({ target: { appbridge: { share() {} } } }).bridge.ready()).status, 'legacy');
  assert.equal((await createSuperSDK({ target: { appbridge: {} } }).bridge.ready()).status, 'degraded');

  const valid = manifest();
  assert.equal((await createSuperSDK({ target: container(valid) }).bridge.ready()).status, 'negotiated');
  const future = manifest();
  future.protocolVersion.major = 2;
  assert.equal((await createSuperSDK({ target: container(future) }).bridge.ready()).status, 'incompatible');
  const malformed = { appbridge: { share() {}, getBridgeManifest: () => '' } };
  const sdk = createSuperSDK({ target: malformed });
  assert.equal((await sdk.bridge.ready()).status, 'degraded');
  await assert.rejects(sdk.bridge.command('share', ['x']), (error) => error.code === 'BRIDGE_DEGRADED');
  assert.equal(sdk.bridge.getBridgeState().status, 'degraded');
});

test('ready probes once per identity and coalesces a force round', async () => {
  let probes = 0;
  const target = container(manifest());
  target.appbridge.getBridgeManifest = () => { probes += 1; return JSON.stringify(manifest()); };
  const sdk = createSuperSDK({ target });
  await Promise.all([sdk.bridge.ready(), sdk.bridge.ready(), sdk.bridge.ready()]);
  assert.equal(probes, 1);
  await Promise.all([sdk.bridge.ready({ force: true }), sdk.bridge.ready({ force: true })]);
  assert.equal(probes, 2);
  const previousGeneration = sdk.bridge.getBridgeState().generation;
  target.appbridge = container(manifest()).appbridge;
  assert.equal(sdk.bridge.supports('share'), true);
  assert.ok(sdk.bridge.getBridgeState().generation > previousGeneration);
});

test('throwing bootstrap and legacy member getters are degraded with bounded diagnostics', async () => {
  for (const appbridge of [
    Object.defineProperty({}, 'getBridgeManifest', { get() { throw new Error('private bootstrap'); } }),
    Object.defineProperty({}, 'share', { get() { throw new Error('private legacy getter'); } })
  ]) {
    const diagnostics = [];
    const sdk = createSuperSDK({ target: { appbridge } });
    sdk.onDiagnostic((entry) => diagnostics.push(entry));
    assert.equal((await sdk.bridge.ready()).status, 'degraded');
    assert.ok(diagnostics.some((entry) => entry.state === 'degraded'));
    assert.doesNotMatch(JSON.stringify(diagnostics), /private bootstrap|private legacy getter/);
  }
});

function container(value) {
  const appbridge = {
    getBridgeManifest: () => JSON.stringify(value),
    onJSBridgeReady() {},
    share() {}
  };
  return { appbridge };
}

function manifest() {
  return {
    schema: BRIDGE_PROTOCOL.manifestSchema,
    protocolVersion: { ...BRIDGE_PROTOCOL.protocolVersion },
    container: { platform: 'android', sdkVersion: 'test' },
    methods: BRIDGE_PROTOCOL.methods.map(({ id, kind, args, result }) => ({ id, kind, args, result })),
    events: BRIDGE_PROTOCOL.events.map(({ id, payload }) => ({ id, payload }))
  };
}
