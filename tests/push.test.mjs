import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import SuperSDK, { createSuperSDK } from '../src/index.js';
import { createBridgeMock } from '../src/mock.js';
import { createTarget } from './helpers.mjs';

// SDK-F261008030551 · SuperSDK.push namespace（AC-7）。
// 端内 wire 经 createBridgeMock 记录（真实 appbridge 成员名 + 参数序 + 回调投递路径），不以源码片段代替；
// 浏览器分支用无 appbridge 的 target；fixture 读 protocol/push-v1.json（Day-0 契约单源）。

const packageRoot = resolve(import.meta.dirname, '..');

// `push.opened` 载荷 / `lastOpened` 的键集 —— Native `PushOpenedInfo.toJson()` 的镜像（Android
// `SuperPushRegistrarTest.OPENED_PAYLOAD_KEYS` 钉同一字面量）。本文件所有 opened 夹具只允许这些键，
// mock 不得自造 Native 不发的字段（review R1 · EXT-2）。
const OPENED_PAYLOAD_KEYS = ['clickType', 'messageId', 'openedAt', 'url', 'verified'];
function openedFixture(fields) {
  const keys = Object.keys(fields).sort();
  assert.ok(keys.every((key) => OPENED_PAYLOAD_KEYS.includes(key)), `opened fixture key outside Native shape: ${keys}`);
  for (const required of ['messageId', 'clickType', 'openedAt', 'verified']) assert.ok(Object.hasOwn(fields, required), `opened fixture misses ${required}`);
  assert.equal(typeof fields.openedAt, 'number', 'openedAt is epoch ms (number), not ISO string');
  return fields;
}

// legacy 运行时的 registerCallback 用全局 setTimeout 做超时；用 node:test 的 mock timers 接管，
// 既不让 15s / 120s 真实定时器拖住进程退出，也能精确推进到超时边界。
function inAppSDK(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const target = createTarget(async () => { throw new Error('no network in push tests'); });
  const mock = createBridgeMock({ target });
  const sdk = createSuperSDK({ target, random: () => 0.5 });
  sdk.installGlobal();
  return { sdk, mock, target };
}

function browserSDK() {
  const target = createTarget(async () => { throw new Error('no network in push tests'); });
  const sdk = createSuperSDK({ target });
  return { sdk, target };
}

function pushError(error, code, { nativeCode, retryable } = {}) {
  assert.ok(error instanceof Error);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  if (nativeCode !== undefined) assert.equal(error.nativeCode, nativeCode);
  if (retryable !== undefined) assert.equal(error.retryable, retryable);
  return true;
}

// TC-SDK-042 · 纯浏览器：getStatus 不支持、其余 reject NOT_SUPPORTED，无同步异常
test('test_AC7_browser_not_supported', async function test_AC7_browser_not_supported() {
  const { sdk } = browserSDK();
  assert.equal(typeof sdk.push, 'object');
  assert.deepEqual(await sdk.push.getStatus(), { supported: false });
  let promise;
  assert.doesNotThrow(() => { promise = sdk.push.requestPermission(); });
  await assert.rejects(promise, (error) => pushError(error, 'NOT_SUPPORTED', { retryable: false }));
  await assert.rejects(sdk.push.setTags(['vip']), (error) => pushError(error, 'NOT_SUPPORTED'));
  await assert.rejects(sdk.push.setUserId('u_1'), (error) => pushError(error, 'NOT_SUPPORTED'));
  // 事件订阅在浏览器照常注册（永远不会收到 Native 投递），返回退订函数
  const off = sdk.push.onMessage(() => {});
  assert.equal(typeof off, 'function');
  off();
  // 默认导出（globalThis target · node 下无 appbridge）同样暴露 push 命名空间
  assert.equal(typeof SuperSDK.push.getStatus, 'function');
  assert.deepEqual(await SuperSDK.push.getStatus(), { supported: false });
});

// TC-SDK-036 · getStatus 字段形状（含 lastOpened / lastError / verified）
test('test_AC7_getStatus_shape', async function test_AC7_getStatus_shape(t) {
  const { sdk, mock } = inAppSDK(t);

  const opened = openedFixture({ messageId: 'pm_0123456789ab', url: 'https://example.com/promo', clickType: 'open_url', openedAt: 1760000000000, verified: true });
  mock.queueResult('pushGetStatus', { code: 'SUCCESS', data: { supported: true, permission: 'granted', registered: true, lastOpened: opened } });
  const first = await sdk.push.getStatus();
  assert.deepEqual(first, { supported: true, permission: 'granted', registered: true, lastOpened: opened });
  assert.deepEqual(mock.calls.filter((call) => call.methodId === 'pushGetStatus').map((call) => call.args.length), [1]);

  // 无未读点击时省略 lastOpened；lastError 存在时 registered 恒为 false（派生值 · 原生侧保证，这里钉透传不改写）
  mock.queueResult('pushGetStatus', { code: 'SUCCESS', data: { supported: true, permission: 'denied', registered: false, lastError: 'NETWORK_ERROR' } });
  const failed = await sdk.push.getStatus();
  assert.deepEqual(failed, { supported: true, permission: 'denied', registered: false, lastError: 'NETWORK_ERROR' });
  assert.equal(Object.hasOwn(failed, 'lastOpened'), false);

  // 回执不可达的降级路径：verified=false，url 为 intent 原值 —— 原样透传给 H5
  const degraded = openedFixture({ messageId: 'pm_abcdefabcdef', url: 'https://example.com/intent', clickType: 'open_url', openedAt: 1760000001000, verified: false });
  mock.queueResult('pushGetStatus', { code: 'SUCCESS', data: { supported: true, permission: 'prompt', registered: true, lastOpened: degraded } });
  assert.deepEqual((await sdk.push.getStatus()).lastOpened, degraded);

  // 宿主未接线（TC-SDK-041 的 H5 面）：只回 {supported:false}
  mock.queueResult('pushGetStatus', { code: 'SUCCESS', data: { supported: false } });
  assert.deepEqual(await sdk.push.getStatus(), { supported: false });

  // 容器明确不支持（iOS stub NOT_SUPPORTED / NOT_IMPLEMENTED）：getStatus 是能力探测，折成 {supported:false} 而不 reject
  mock.queueResult('pushGetStatus', { code: 'NOT_SUPPORTED', message: 'push is not available on iOS yet' });
  assert.deepEqual(await sdk.push.getStatus(), { supported: false });
  mock.queueResult('pushGetStatus', { code: 'NOT_IMPLEMENTED', message: 'push service not wired' });
  assert.deepEqual(await sdk.push.getStatus(), { supported: false });
  // 其余失败照常 reject（注册表归一）
  mock.queueResult('pushGetStatus', { code: 'NO_ACTIVITY', message: 'x' });
  await assert.rejects(sdk.push.getStatus(), (error) => pushError(error, 'UNAVAILABLE', { nativeCode: 'NO_ACTIVITY', retryable: true }));

  // lastError 闭集与 Day-0 fixture 一致（类型声明 / 文档只是它的镜像）
  const fixture = JSON.parse(await readFile(resolve(packageRoot, 'protocol/push-v1.json'), 'utf8'));
  assert.deepEqual(fixture.sdk_last_error_closed_set, ['TOKEN_UNAVAILABLE', 'NOT_FOUND', 'INVALID_REQUEST', 'RATE_LIMITED', 'NETWORK_ERROR', 'UNAVAILABLE']);
});

// TC-SDK-038（JSSDK 面）· 透传：11 项 tags 原样进 bridge（wire tuple 完整），越界由 Native 拒绝 → INVALID_ARGUMENT
test('push_setTags_and_setUserId_pass_through_the_exact_wire_tuple_and_only_type_guard_locally', async function push_setTags_and_setUserId_pass_through_the_exact_wire_tuple_and_only_type_guard_locally(t) {
  const { sdk, mock } = inAppSDK(t);

  const eleven = Array.from({ length: 11 }, (_, index) => `tag_${index}`);
  mock.queueResult('pushSetTags', { code: 'INVALID_PARAM', message: 'tags: at most 10 items' });
  await assert.rejects(sdk.push.setTags(eleven), (error) => {
    pushError(error, 'INVALID_ARGUMENT', { nativeCode: 'INVALID_PARAM', retryable: false });
    assert.equal(error.detail, 'tags: at most 10 items');
    return true;
  });
  const setTagsCall = mock.calls.find((call) => call.methodId === 'pushSetTags');
  assert.equal(setTagsCall.nativeName, 'pushSetTags');
  assert.equal(setTagsCall.args.length, 2);
  assert.match(setTagsCall.args[0], /^sdk[^:]+:r/);
  assert.equal(setTagsCall.args[1], JSON.stringify(eleven));
  assert.deepEqual(JSON.parse(setTagsCall.args[1]), eleven, '11 tags reach the bridge untouched');

  // 边界内成功 resolve undefined；null / [] 清空显式带 "[]"
  mock.queueResult('pushSetTags', { code: 'SUCCESS', data: {} });
  assert.equal(await sdk.push.setTags(['vip', 'beta']), undefined);
  mock.queueResult('pushSetTags', { code: 'SUCCESS', data: {} });
  await sdk.push.setTags(null);
  mock.queueResult('pushSetTags', { code: 'SUCCESS', data: {} });
  await sdk.push.setTags([]);
  const tagWires = mock.calls.filter((call) => call.methodId === 'pushSetTags').map((call) => call.args[1]);
  assert.deepEqual(tagWires.slice(1), ['["vip","beta"]', '[]', '[]']);

  // userId：string 原样；null / '' 清除都以 '' 上桥（Native 折 null，登记体显式 user_id: null）
  for (const [input, wire] of [['u_123', 'u_123'], [null, ''], ['', ''], [undefined, '']]) {
    mock.queueResult('pushSetUserId', { code: 'SUCCESS', data: {} });
    assert.equal(await sdk.push.setUserId(input), undefined);
    const call = mock.calls.at(-1);
    assert.equal(call.nativeName, 'pushSetUserId');
    assert.deepEqual(call.args.slice(1), [wire]);
  }

  // 本地只做类型兜底：非数组 / 非字符串项 / 非字符串 userId → INVALID_ARGUMENT 且不碰 bridge
  const before = mock.calls.length;
  for (const bad of ['vip', { tags: [] }, 42, [1], ['ok', null], [['nested']]]) {
    await assert.rejects(sdk.push.setTags(bad), (error) => pushError(error, 'INVALID_ARGUMENT', { retryable: false }));
  }
  for (const bad of [123, {}, ['u']]) {
    await assert.rejects(sdk.push.setUserId(bad), (error) => pushError(error, 'INVALID_ARGUMENT', { retryable: false }));
  }
  assert.equal(mock.calls.length, before, 'type-guard rejections never reach the bridge');

  // 129 码点 userId 不在 JS 层拦（边界单源 = Native）：原样上桥，由 Native INVALID_PARAM 决定
  const long = 'x'.repeat(129);
  mock.queueResult('pushSetUserId', { code: 'INVALID_PARAM', message: 'userId too long' });
  await assert.rejects(sdk.push.setUserId(long), (error) => pushError(error, 'INVALID_ARGUMENT', { nativeCode: 'INVALID_PARAM' }));
  assert.equal(mock.calls.at(-1).args[1], long);
});

// TC-SDK-034（H5 面）· NO_ACTIVITY → UNAVAILABLE retryable；TC-SDK-041（H5 面）· NOT_IMPLEMENTED → UNSUPPORTED；
// requestPermission 交互类超时 120000ms → TIMEOUT
test('push_requestPermission_maps_native_codes_through_the_registry_and_uses_the_interactive_timeout', async function push_requestPermission_maps_native_codes_through_the_registry_and_uses_the_interactive_timeout(t) {
  const { sdk, mock } = inAppSDK(t);

  mock.queueResult('pushRequestPermission', { code: 'SUCCESS', data: { permission: 'granted' } });
  assert.deepEqual(await sdk.push.requestPermission(), { permission: 'granted' });
  assert.deepEqual(mock.calls.at(-1).args.length, 1);

  mock.queueResult('pushRequestPermission', { code: 'NO_ACTIVITY', message: 'no foreground activity' });
  await assert.rejects(sdk.push.requestPermission(), (error) => pushError(error, 'UNAVAILABLE', { nativeCode: 'NO_ACTIVITY', retryable: true }));

  for (const methodId of ['pushRequestPermission', 'pushSetTags', 'pushSetUserId']) {
    mock.queueResult(methodId, { code: 'NOT_IMPLEMENTED', message: 'push service not wired' });
  }
  await assert.rejects(sdk.push.requestPermission(), (error) => pushError(error, 'UNSUPPORTED', { nativeCode: 'NOT_IMPLEMENTED', retryable: false }));
  await assert.rejects(sdk.push.setTags(['a']), (error) => pushError(error, 'UNSUPPORTED', { nativeCode: 'NOT_IMPLEMENTED', retryable: false }));
  await assert.rejects(sdk.push.setUserId('u'), (error) => pushError(error, 'UNSUPPORTED', { nativeCode: 'NOT_IMPLEMENTED', retryable: false }));

  // 注册表外的 code → BRIDGE_ERROR（nativeCode UNKNOWN）
  mock.queueResult('pushSetTags', { code: 'SOMETHING_ELSE', message: 'x' });
  await assert.rejects(sdk.push.setTags(['a']), (error) => pushError(error, 'BRIDGE_ERROR', { nativeCode: 'UNKNOWN', retryable: false }));

  // 超时：requestPermission 是交互类（120000ms），getStatus 等非交互类保持 15000ms。
  // 推进到 119999ms 仍 pending，再推 1ms 即 TIMEOUT（经注册表 → TIMEOUT retryable）。
  const pending = sdk.push.requestPermission();
  const settled = Symbol('settled');
  const probe = (promise) => Promise.race([promise.then(() => settled, () => settled), Promise.resolve('pending')]);
  t.mock.timers.tick(119999);
  assert.equal(await probe(pending), 'pending', 'still waiting for the system permission dialog at 119999ms');
  t.mock.timers.tick(1);
  await assert.rejects(pending, (error) => pushError(error, 'TIMEOUT', { nativeCode: 'TIMEOUT', retryable: true }));

  const status = sdk.push.getStatus();
  t.mock.timers.tick(15000);
  await assert.rejects(status, (error) => pushError(error, 'TIMEOUT', { retryable: true }));
});

// Native 太老（无 push JSB 成员）→ SDK_TOO_OLD；不调用任何 appbridge 成员
test('push_rejects_SDK_TOO_OLD_when_the_native_container_lacks_the_push_members', async function push_rejects_SDK_TOO_OLD_when_the_native_container_lacks_the_push_members(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const target = createTarget(async () => { throw new Error('offline'); });
  target.appbridge = { onJSBridgeReady() {}, getEnvAsync(...args) { calls.push(args); } };
  const sdk = createSuperSDK({ target, random: () => 0.5 });
  sdk.installGlobal();
  await assert.rejects(sdk.push.getStatus(), (error) => pushError(error, 'SDK_TOO_OLD', { retryable: false }));
  await assert.rejects(sdk.push.requestPermission(), (error) => pushError(error, 'SDK_TOO_OLD'));
  await assert.rejects(sdk.push.setTags([]), (error) => pushError(error, 'SDK_TOO_OLD'));
  await assert.rejects(sdk.push.setUserId(null), (error) => pushError(error, 'SDK_TOO_OLD'));
  assert.equal(calls.length, 0);
});

// TC-SDK-040（H5 面）· onMessage / onOpened = BROADCAST push.message / push.opened 的订阅别名：
// 事件只派发给已订阅者，退订后不再收到；无监听者的事件直接丢弃（冷启动页面靠 lastOpened）
test('push_onMessage_and_onOpened_subscribe_to_the_broadcast_events_and_return_unsubscribe', async function push_onMessage_and_onOpened_subscribe_to_the_broadcast_events_and_return_unsubscribe(t) {
  const { sdk, mock } = inAppSDK(t);
  const received = { message: [], opened: [], generic: [] };

  // 事件发生在订阅之前 → 丢弃（不缓存）
  mock.emitEvent('BROADCAST', 'push.opened', openedFixture({ messageId: 'pm_000000000000', clickType: 'open_app', openedAt: 1, verified: true }));

  const offMessage = sdk.push.onMessage((payload) => received.message.push(payload));
  const offOpened = sdk.push.onOpened((payload) => received.opened.push(payload));
  const offGeneric = sdk.subscribe('push.message', (payload) => received.generic.push(payload));
  assert.equal(typeof offMessage, 'function');
  assert.equal(typeof offOpened, 'function');

  const message = { messageId: 'pm_0123456789ab', title: 'Hi', body: 'Body', imageUrl: null, url: 'https://example.com/a', clickType: 'open_url', data: { message_id: 'pm_0123456789ab', url: 'https://example.com/a' } };
  const opened = openedFixture({ messageId: 'pm_0123456789ab', url: 'https://example.com/a', clickType: 'open_url', openedAt: 1760000000000, verified: true });
  mock.emitEvent('BROADCAST', 'push.message', message);
  mock.emitEvent('BROADCAST', 'push.opened', opened);
  assert.deepEqual(received.message, [message]);
  assert.deepEqual(received.opened, [opened]);
  assert.deepEqual(received.generic, [message], 'push.message is an ordinary BROADCAST key for SuperSDK.subscribe too');

  // push.message 不会串到 onOpened，反之亦然
  assert.equal(received.opened.length, 1);
  assert.equal(received.message.length, 1);

  offMessage();
  offMessage();
  offOpened();
  mock.emitEvent('BROADCAST', 'push.message', message);
  mock.emitEvent('BROADCAST', 'push.opened', opened);
  assert.equal(received.message.length, 1);
  assert.equal(received.opened.length, 1);
  assert.equal(received.generic.length, 2);
  offGeneric();

  assert.throws(() => sdk.push.onMessage('not a function'), (error) => pushError(error, 'INVALID_ARGUMENT'));
  assert.throws(() => sdk.push.onOpened(), (error) => pushError(error, 'INVALID_ARGUMENT'));
});

// 契约形状钉子：Day-0 fixture 可读且 opened 回执响应带 click_type / url（D-T6 C · SDK 只打开服务端返回的 url）
test('push_fixture_is_readable_and_pins_the_opened_receipt_shape', async function push_fixture_is_readable_and_pins_the_opened_receipt_shape() {
  const fixture = JSON.parse(await readFile(resolve(packageRoot, 'protocol/push-v1.json'), 'utf8'));
  assert.deepEqual(Object.keys(fixture.opened.response_success.data).sort(), ['click_type', 'url']);
  assert.equal(fixture.opened.response_success.code, 'SUCCESS');
  assert.equal(fixture.opened.response_not_found.code, 'NOT_FOUND');
  assert.deepEqual(fixture.opened.request.required, ['spid', 'device_id', 'message_id']);
  assert.equal(fixture.opened.request.message_id.regex, '^pm_[0-9a-f]{12}$');
  assert.equal(fixture.push_open_event.event_name, '$push_open');
  assert.deepEqual(Object.keys(fixture.push_open_event.params).sort(), ['click_type', 'message_id', 'url', 'verified']);
});
