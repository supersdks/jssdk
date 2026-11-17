import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import vm from 'node:vm';
import { createSuperSDK } from '../src/index.js';

const packageRoot = resolve(import.meta.dirname, '..');

test('compatibility enclave is anchored to immutable published 1.0 bytes and inventory', async () => {
  const fixtureRoot = resolve(packageRoot, 'tests/fixtures/runtime-1.0');
  const contract = JSON.parse(await readFile(resolve(fixtureRoot, 'contract.json'), 'utf8'));
  const encoded = await readFile(resolve(fixtureRoot, 'supersdk-1.0.0.js.gz.base64'), 'utf8');
  const artifact = gunzipSync(Buffer.from(encoded.replace(/\s/g, ''), 'base64'));
  assert.equal(artifact.byteLength, contract.source.bytes);
  assert.equal(createHash('sha256').update(artifact).digest('hex'), contract.source.sha256);
  assert.equal(contract.source.package, '@supersdk/jssdk');
  assert.equal(contract.source.version, '1.0.0');

  const source = await readFile(resolve(packageRoot, 'src/runtime/legacy-runtime.js'), 'utf8');
  const references = [...source.matchAll(/global\.appbridge\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  assert.equal(references.length, contract.inventory.directReferences);
  assert.equal(new Set(references).size, contract.inventory.uniqueNativeMembers);
});

test('current compatibility enclave matches frozen 1.0 dispatch timing callback progress cancel and event traces', async () => {
  const fixtureRoot = resolve(packageRoot, 'tests/fixtures/runtime-1.0');
  const contract = JSON.parse(await readFile(resolve(fixtureRoot, 'contract.json'), 'utf8'));
  const encoded = await readFile(resolve(fixtureRoot, 'supersdk-1.0.0.js.gz.base64'), 'utf8');
  const artifact = gunzipSync(Buffer.from(encoded.replace(/\s/g, ''), 'base64')).toString('utf8');
  const frozenTarget = recordingTarget();
  vm.runInContext(artifact, vm.createContext(frozenTarget), { filename: 'published-@supersdk-jssdk-1.0.0.js' });
  const currentTarget = recordingTarget();
  const currentSDK = createSuperSDK({ target: currentTarget, random: () => 0.5 });
  currentSDK.installGlobal();
  const frozen = await recordCompatibilityTrace(frozenTarget.SuperSDK, frozenTarget);
  const current = await recordCompatibilityTrace(currentSDK, currentTarget);
  const expected = expectedCompatibilityTrace(contract);
  assert.deepEqual(frozen, expected);
  assert.deepEqual(current, expected);
});

test('legacy stream and lifecycle wrappers keep their synchronous and event shapes through the hub', () => {
  const nativeCalls = [];
  const target = {
    appbridge: {
      onJSBridgeReady() {},
      downloadFile(...args) { nativeCalls.push(['downloadFile', ...args]); },
      cancelDownload(...args) { nativeCalls.push(['cancelDownload', ...args]); }
    }
  };
  const sdk = createSuperSDK({ target, random: () => 0.25 });
  sdk.installGlobal();
  const progress = [];
  const cancel = sdk.downloadFile({
    url: 'https://example.invalid/file', savePath: 'safe/file', headers: {},
    onStart: () => progress.push('START'),
    onProgress: (value) => progress.push(`PROGRESS:${value.progress}`),
    onSuccess: (value) => progress.push(`SUCCESS:${value.filePath}`)
  });
  assert.equal(typeof cancel, 'function');
  const requestId = nativeCalls[0][1];
  target.JSBridge.subscribeHandler('ASYNC_CALLBACK', requestId, { code: 'SUCCESS', data: { status: 'START' } });
  target.JSBridge.subscribeHandler('ASYNC_CALLBACK', requestId, { code: 'SUCCESS', data: { status: 'PROGRESS', progress: 4 } });
  target.JSBridge.subscribeHandler('ASYNC_CALLBACK', requestId, { code: 'SUCCESS', data: { status: 'SUCCESS', filePath: 'safe/file' } });
  cancel();
  assert.deepEqual(progress, ['START', 'PROGRESS:4', 'SUCCESS:safe/file']);
  assert.equal(nativeCalls.at(-1)[0], 'cancelDownload');

  const lifecycle = [];
  const offForeground = sdk.onForeground((value) => lifecycle.push(value.triggerFrom));
  target.JSBridge.subscribeHandler('SYSTEM', 'onEnterForeground', { triggerFrom: 'activity' });
  offForeground();
  offForeground();
  target.JSBridge.subscribeHandler('SYSTEM', 'onEnterForeground', { triggerFrom: 'view' });
  assert.deepEqual(lifecycle, ['activity']);
});

test('2.0 declarations compile runtime-accurate results and reject the four 1.0 mismatches', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'supersdk-types-2-'));
  const source = `
    import SDK, { type SuperSDKError } from ${JSON.stringify(resolve(packageRoot, 'dist/index.js'))};
    import { BRIDGE_PROTOCOL, type BridgeMethodMap } from ${JSON.stringify(resolve(packageRoot, 'dist/protocol.js'))};
    import { createBridgeMock } from ${JSON.stringify(resolve(packageRoot, 'dist/mock.js'))};
    const exists: Promise<{exists:boolean,isFile:boolean,isDirectory:boolean}> = SDK.fileExists('x');
    const content: Promise<{content:string}> = SDK.readFile('x');
    const md5: Promise<{md5:string}> = SDK.getFileMd5('x');
    const cancel: () => void = SDK.downloadFile({url:'u',savePath:'p'});
    // @ts-expect-error 1.0 incorrectly declared a primitive boolean
    const oldExists: Promise<boolean> = SDK.fileExists('x');
    // @ts-expect-error 1.0 incorrectly declared a string
    const oldContent: Promise<string> = SDK.readFile('x');
    // @ts-expect-error 1.0 incorrectly declared a string
    const oldMd5: Promise<string> = SDK.getFileMd5('x');
    // @ts-expect-error 1.0 incorrectly declared URL args and a Promise
    const oldDownload: Promise<unknown> = SDK.downloadFile('u', 'p');
    const env: Promise<BridgeMethodMap['getEnv']['result']> = SDK.bridge.request('getEnv', []);
    const error: SuperSDKError | null = null;
    void exists; void content; void md5; void cancel; void oldExists; void oldContent; void oldMd5; void oldDownload;
    void env; void error; void BRIDGE_PROTOCOL; void createBridgeMock;
  `;
  await writeFile(resolve(temporary, 'consumer.ts'), source);
  await writeFile(resolve(temporary, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2020', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, lib: ['ES2020', 'DOM'] },
    files: ['consumer.ts']
  }));
  execFileSync(process.execPath, [resolve(packageRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: temporary, stdio: 'pipe' });
});

function recordingTarget() {
  const calls = [];
  const target = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    URL,
    Math,
    Date,
    Promise,
    calls,
    appbridge: {}
  };
  for (const name of ['onJSBridgeReady', 'share', 'openPage', 'cancelDownload']) {
    target.appbridge[name] = (...args) => calls.push([name, ...args]);
  }
  for (const name of ['getEnvAsync', 'downloadFile', 'fileExists', 'readFile', 'getFileMd5']) {
    target.appbridge[name] = (...args) => calls.push([name, ...args]);
  }
  return target;
}

async function recordCompatibilityTrace(sdk, target) {
  target.calls.length = 0;
  const returns = [];
  returns.push(['share', typeof sdk.share('content')]);
  returns.push(['openPage', typeof sdk.openPage('https://example.invalid/', { showTitleBar: false })]);

  const envPromise = sdk.getEnv();
  returns.push(['getEnv', isPromise(envPromise) ? 'Promise' : typeof envPromise]);
  const envCall = target.calls.find((call) => call[0] === 'getEnvAsync');
  target.JSBridge.subscribeHandler('ASYNC_CALLBACK', envCall[1], { code: 'SUCCESS', data: { os: 'fixture' } });
  await envPromise;

  const results = {};
  const fileResults = {
    fileExists: { exists: true, isFile: true, isDirectory: false },
    readFile: { content: 'text' },
    getFileMd5: { md5: 'abc' }
  };
  for (const [api, data] of Object.entries(fileResults)) {
    const promise = sdk[api]('safe/file');
    returns.push([api, isPromise(promise) ? 'Promise' : typeof promise]);
    const call = target.calls.findLast((entry) => entry[0] === api);
    target.JSBridge.subscribeHandler('ASYNC_CALLBACK', call[2], { code: 'SUCCESS', data });
    results[api] = await promise;
  }

  const statuses = [];
  const cancel = sdk.downloadFile({
    url: 'https://example.invalid/file', savePath: 'safe/file', headers: {},
    onStart: () => statuses.push('START'),
    onProgress: () => statuses.push('PROGRESS'),
    onSuccess: () => statuses.push('SUCCESS')
  });
  returns.push(['downloadFile', typeof cancel]);
  const downloadCall = target.calls.find((call) => call[0] === 'downloadFile');
  for (const status of ['START', 'PROGRESS', 'SUCCESS']) {
    target.JSBridge.subscribeHandler('ASYNC_CALLBACK', downloadCall[1], { code: 'SUCCESS', data: { status, progress: 1, filePath: 'safe/file' } });
  }
  cancel();

  const events = [];
  const unsubscribe = sdk.onForeground((event) => events.push(event.triggerFrom));
  returns.push(['onForeground', typeof unsubscribe]);
  target.JSBridge.subscribeHandler('SYSTEM', 'onEnterForeground', { triggerFrom: 'activity' });
  unsubscribe();

  return {
    calls: target.calls.filter((call) => call[0] !== 'onJSBridgeReady').map(normalizeCall),
    returns,
    statuses,
    events,
    results
  };
}

function expectedCompatibilityTrace(contract) {
  const calls = [];
  const returns = [];
  for (const trace of contract.traces) {
    returns.push([trace.api, trace.return === 'undefined' ? 'undefined' : trace.return === 'Promise' ? 'Promise' : 'function']);
    if (trace.nativeName) calls.push([trace.nativeName, ...trace.args]);
    if (trace.cancelNativeName) calls.push([trace.cancelNativeName, '$callback']);
  }
  return {
    calls,
    returns,
    statuses: contract.traces.find((trace) => trace.progress)?.progress || [],
    events: contract.traces.some((trace) => trace.eventType === 'SYSTEM') ? ['activity'] : [],
    results: contract.runtimeResults
  };
}

function normalizeCall(call) {
  return call.map((value) => typeof value === 'string' && (/^cb_/.test(value) || /^sdk[^:]+:r/.test(value)) ? '$callback' : value);
}

function isPromise(value) {
  return Boolean(value) && typeof value.then === 'function';
}
