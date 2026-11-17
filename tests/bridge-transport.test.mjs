import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/index.js';
import { createBridgeMock } from '../src/mock.js';

test('request command stream and subscription use the declared wire and unique terminal state', async () => {
  const mock = createBridgeMock();
  const sdk = createSuperSDK({ target: mock.target });
  mock.queueResult('requestShortUrl', { code: 'SUCCESS', data: { shortUrl: 's' } });
  assert.deepEqual(await sdk.bridge.request('requestShortUrl', ['{"url":"u"}']), { shortUrl: 's' });
  const shortCall = mock.calls.find((call) => call.methodId === 'requestShortUrl');
  assert.match(JSON.parse(shortCall.args[0]).callbackId, /^sdk[^:]+:r/);

  await sdk.bridge.command('share', ['content']);
  assert.deepEqual(mock.calls.find((call) => call.methodId === 'share').args, ['content']);

  mock.queueResult('downloadFile', { results: [
    { code: 'SUCCESS', data: { status: 'START' } },
    { code: 'SUCCESS', data: { status: 'PROGRESS', progress: 50 } },
    { code: 'SUCCESS', data: { status: 'SUCCESS', filePath: 'safe/a' } },
    { code: 'SUCCESS', data: { status: 'SUCCESS', filePath: 'late' } }
  ] });
  const stream = sdk.bridge.openStream('downloadFile', ['https://example.invalid/a', '{}', 'safe/a']);
  const progress = [];
  stream.onProgress((value) => progress.push(value.status));
  assert.equal((await stream.completion).filePath, 'safe/a');
  assert.deepEqual(progress, ['START', 'PROGRESS']);

  const events = [];
  const unsubscribe = sdk.bridge.subscribe('broadcast', (event) => events.push(event));
  mock.emitEvent('BROADCAST', 'updated', { ok: true });
  unsubscribe();
  unsubscribe();
  mock.emitEvent('BROADCAST', 'updated', { ok: false });
  assert.equal(events.length, 1);
});

test('native errors have one mapping and invalid timeout is rejected before dispatch', async () => {
  const mock = createBridgeMock();
  const sdk = createSuperSDK({ target: mock.target });
  const baseline = mock.calls.length;
  await assert.rejects(sdk.bridge.request('getEnv', [], { timeoutMs: 99 }), (error) => error.code === 'INVALID_ARGUMENT');
  assert.equal(mock.calls.length, baseline);

  for (const [native, expected, detail] of [
    ['INVALID_PARAMS', 'INVALID_ARGUMENT', 'INVALID_PARAMS'],
    ['PAYMENT_VENDOR_PRIVATE', 'BRIDGE_ERROR', 'UNKNOWN']
  ]) {
    mock.queueResult('getEnv', { code: native, message: 'not logged' });
    await assert.rejects(sdk.bridge.request('getEnv', []), (error) =>
      error.code === expected && error.nativeCode === detail && error.retryable === false
    );
  }
  for (const envelope of [{}, { code: 4 }, { code: '' }]) {
    mock.queueResult('getEnv', envelope);
    await assert.rejects(sdk.bridge.request('getEnv', []), (error) => error.code === 'PROTOCOL_MISMATCH');
  }
});

test('timeout abort and stream cancel clean callbacks and dispatch best-effort cancellation', async () => {
  const mock = createBridgeMock();
  let nextTimer = 0;
  const timers = new Map();
  const sdk = createSuperSDK({
    target: mock.target,
    bridgeSetTimeout(handler) { nextTimer += 1; timers.set(nextTimer, handler); return nextTimer; },
    bridgeClearTimeout(id) { timers.delete(id); }
  });
  const request = sdk.bridge.request('getEnv', [], { timeoutMs: 100 });
  [...timers.values()][0]();
  await assert.rejects(request, (error) => error.code === 'TIMEOUT');
  assert.equal(sdk.bridge.__debugCounts().callbacks, 0);

  const controller = new AbortController();
  const aborted = sdk.bridge.request('getEnv', [], { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, (error) => error.code === 'CANCELLED');

  const stream = sdk.bridge.openStream('downloadFile', ['u', '{}', 'p']);
  stream.cancel();
  await assert.rejects(stream.completion, (error) => error.code === 'CANCELLED');
  assert.equal(mock.calls.at(-1).methodId, 'cancelDownload');
  assert.equal(sdk.bridge.__debugCounts().callbacks, 0);
});

test('abort is rechecked after listener registration to close the dispatch race', async () => {
  const mock = createBridgeMock();
  let aborted = false;
  const signal = {
    get aborted() { return aborted; },
    addEventListener() { aborted = true; },
    removeEventListener() {}
  };
  const sdk = createSuperSDK({ target: mock.target });
  await assert.rejects(sdk.bridge.request('getEnv', [], { signal }), (error) => error.code === 'CANCELLED');
  assert.equal(sdk.bridge.__debugCounts().callbacks, 0);
});

test('timeout defaults and integer bounds are kind-specific and commands never create ack timers', async () => {
  const mock = createBridgeMock();
  let timerId = 0;
  const timers = new Map();
  const delays = [];
  const sdk = createSuperSDK({
    target: mock.target,
    bridgeSetTimeout(handler, delay) { delays.push(delay); timerId += 1; timers.set(timerId, handler); return timerId; },
    bridgeClearTimeout(id) { timers.delete(id); }
  });
  for (const timeoutMs of [undefined, 100, 60000]) {
    const pending = sdk.bridge.request('getEnv', [], timeoutMs === undefined ? {} : { timeoutMs });
    const [id, handler] = [...timers.entries()].at(-1);
    handler();
    timers.delete(id);
    await assert.rejects(pending, (error) => error.code === 'TIMEOUT');
  }
  assert.deepEqual(delays.slice(0, 3), [5000, 100, 60000]);

  const stream = sdk.bridge.openStream('downloadFile', ['u', '{}', 'p']);
  assert.equal(delays.at(-1), 300000);
  stream.cancel();
  await assert.rejects(stream.completion, (error) => error.code === 'CANCELLED');
  const beforeCommand = delays.length;
  await sdk.bridge.command('share', ['x'], { timeoutMs: 100 });
  await sdk.bridge.command('share', ['x'], { timeoutMs: 60000 });
  assert.equal(delays.length, beforeCommand);

  for (const invalid of [NaN, Infinity, -1, 0, 1.5, 99, 60001]) {
    await assert.rejects(sdk.bridge.request('getEnv', [], { timeoutMs: invalid }), (error) => error.code === 'INVALID_ARGUMENT');
    await assert.rejects(sdk.bridge.command('share', ['x'], { timeoutMs: invalid }), (error) => error.code === 'INVALID_ARGUMENT');
  }
  for (const invalid of [NaN, Infinity, -1, 0, 1.5, 999, 1800001]) {
    assert.throws(() => sdk.bridge.openStream('downloadFile', ['u', '{}', 'p'], { timeoutMs: invalid }), (error) => error.code === 'INVALID_ARGUMENT');
  }
});
