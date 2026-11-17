import test from 'node:test';
import assert from 'node:assert/strict';
import { BRIDGE_PROTOCOL, getEventDefinition, getMethodDefinition, mapNativeErrorCode, validateBridgeManifest } from '../src/protocol.js';

test('manifest validates the known intersection and ignores same-major unknown entries whole', () => {
  const value = manifest();
  value.methods.push({ id: 'futureMethod', kind: { intentionally: 'not parsed' } });
  value.events.push({ id: 'future.event', payload: { intentionally: 'not parsed' } });
  value.futureTopLevel = { value: true };
  const parsed = validateBridgeManifest(JSON.stringify(value));
  assert.equal(parsed.methods.length, 63);
  assert.equal(parsed.events.length, 6);
  assert.equal(Object.isFrozen(parsed), true);
});

test('manifest rejects reserved bootstrap, duplicate ids, signature drift, malformed JSON and byte overflow', () => {
  const cases = [];
  const reserved = manifest();
  reserved.methods.push({ id: 'getBridgeManifest' });
  cases.push([reserved, 'RESERVED_METHOD']);
  const duplicate = manifest();
  duplicate.methods.push({ ...duplicate.methods[0] });
  cases.push([duplicate, 'DUPLICATE_METHOD']);
  const drift = manifest();
  drift.methods.find((entry) => entry.id === 'downloadFile').args.reverse();
  cases.push([drift, 'METHOD_SIGNATURE']);
  for (const [value, reasonCode] of cases) {
    assert.throws(() => validateBridgeManifest(JSON.stringify(value)), (error) => error.reasonCode === reasonCode);
  }
  assert.throws(() => validateBridgeManifest('{'), (error) => error.reasonCode === 'MANIFEST_JSON');
  assert.throws(() => validateBridgeManifest(`${JSON.stringify(manifest())}${' '.repeat(65536)}`), (error) => error.reasonCode === 'MANIFEST_SIZE');
});

// SDK-F261008030551 · TC-SDK-043 · AC-7/AC-6：push 协议钉子 —— 4 methods（wire tuple 顺序）+ 2 BROADCAST events
// + NO_ACTIVITY→UNAVAILABLE(retryable) 别名。v1.json 是单源；这里钉的是双端 BridgeProtocol 与前端共同依赖的形状。
test('test_AC7_protocol_pins_and_alias', function test_AC7_protocol_pins_and_alias() {
  const expected = {
    pushGetStatus: ['callbackId'],
    pushRequestPermission: ['callbackId'],
    pushSetTags: ['callbackId', 'tagsJson'],
    pushSetUserId: ['callbackId', 'userId']
  };
  for (const [id, argNames] of Object.entries(expected)) {
    const method = getMethodDefinition(id);
    assert.ok(method, `missing push method ${id}`);
    assert.equal(method.kind, 'request');
    assert.equal(method.nativeName, id);
    assert.equal(method.result, 'bridge.result.v1');
    assert.deepEqual(method.callbackBinding, { type: 'argument', index: 0 });
    assert.deepEqual(method.args.map((arg) => arg.name), argNames);
    assert.equal(method.legacy.available, true);
  }
  assert.equal(getMethodDefinition('pushSetTags').args[1].type, 'json');
  assert.equal(getMethodDefinition('pushSetUserId').args[1].required, false);
  assert.equal(BRIDGE_PROTOCOL.methods.length, 63);

  for (const id of ['push.message', 'push.opened']) {
    const event = getEventDefinition(id);
    assert.ok(event, `missing push event ${id}`);
    assert.equal(event.wireType, 'BROADCAST');
    assert.equal(event.wireKey, id);
    assert.equal(event.payload, 'bridge.event.v1');
  }
  assert.equal(BRIDGE_PROTOCOL.events.length, 6);

  assert.deepEqual(mapNativeErrorCode('NO_ACTIVITY'), { code: 'UNAVAILABLE', nativeCode: 'NO_ACTIVITY', retryable: true });
  assert.deepEqual(mapNativeErrorCode('NOT_IMPLEMENTED'), { code: 'UNSUPPORTED', nativeCode: 'NOT_IMPLEMENTED', retryable: false });
  assert.deepEqual(mapNativeErrorCode('INVALID_PARAM'), { code: 'INVALID_ARGUMENT', nativeCode: 'INVALID_PARAM', retryable: false });
});

function manifest() {
  return {
    schema: BRIDGE_PROTOCOL.manifestSchema,
    protocolVersion: { ...BRIDGE_PROTOCOL.protocolVersion },
    container: { platform: 'ios', sdkVersion: 'test' },
    methods: BRIDGE_PROTOCOL.methods.map(({ id, kind, args, result }) => ({ id, kind, args: args.map((arg) => ({ ...arg })), result })),
    events: BRIDGE_PROTOCOL.events.map(({ id, payload }) => ({ id, payload }))
  };
}
