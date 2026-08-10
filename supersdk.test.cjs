/**
 * JSSDK-F001 Non-App Fallback Tests
 * Run with: node supersdk.test.js
 */

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log('  PASS:', message);
  } else {
    failed++;
    console.error('  FAIL:', message);
  }
}

function assertRejects(promise, messagePart, testName) {
  return promise.then(function() {
    failed++;
    console.error('  FAIL:', testName, '- expected rejection but resolved');
  }).catch(function(e) {
    if (e.message && e.message.includes(messagePart)) {
      passed++;
      console.log('  PASS:', testName);
    } else {
      failed++;
      console.error('  FAIL:', testName, '- wrong error message:', e.message);
    }
  });
}

function assertThrows(fn, ErrorType, messagePart, testName) {
  try {
    fn();
    failed++;
    console.error('  FAIL:', testName, '- expected throw but returned');
  } catch (e) {
    if (e instanceof ErrorType && e.message.includes(messagePart)) {
      passed++;
      console.log('  PASS:', testName);
    } else {
      failed++;
      console.error('  FAIL:', testName, '- wrong error:', e && e.constructor && e.constructor.name, e && e.message);
    }
  }
}

// Mock browser environment
global.window = global;
global.navigator = { userAgent: '' };
global.document = {
  querySelectorAll: function() { return []; },
  createElement: function() { return { setAttribute: function(){}, style: {} }; },
  body: { appendChild: function(){} }
};
global.history = { back: function() { global._historyBackCalled = true; } };
global.closed = false;

// Track window.open calls
let lastOpenArgs = null;
global.open = function(url, target) { lastOpenArgs = [url, target]; };
global.close = function() {};

// Mock localStorage
const _storage = {};
global.localStorage = {
  getItem: function(key) { return _storage[key] || null; },
  setItem: function(key, val) { _storage[key] = val; },
  removeItem: function(key) { delete _storage[key]; }
};

// Mock fetch
let lastFetchArgs = null;
let fetchCalls = [];
let fetchQueue = [];
let fetchResponse = { ok: true, status: 200 };
let fetchShouldThrow = false;
global.fetch = function(url, options) {
  lastFetchArgs = { url: url, options: options };
  fetchCalls.push(lastFetchArgs);
  if (fetchQueue.length > 0) {
    var next = fetchQueue.shift();
    if (next && next.error) {
      return Promise.reject(next.error);
    }
    return Promise.resolve(next);
  }
  if (fetchShouldThrow) {
    return Promise.reject(new TypeError('Network error'));
  }
  return Promise.resolve(fetchResponse);
};

// Mock console methods for capture
const logCapture = [];
const warnCapture = [];
const errorCapture = [];
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

function captureConsole() {
  logCapture.length = 0;
  warnCapture.length = 0;
  errorCapture.length = 0;
  console.log = function() { logCapture.push(Array.from(arguments).join(' ')); };
  console.warn = function() { warnCapture.push(Array.from(arguments).join(' ')); };
  console.error = function() { errorCapture.push(Array.from(arguments).join(' ')); };
}

function restoreConsole() {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}

// Clear appbridge to simulate browser environment
delete global.appbridge;

// Load SDK
const SDK = require('./dist/index.cjs');

async function runTests() {

  // =============== Section 1: init ===============
  console.log('\n=== Init Tests ===');

  // TC-003: config shape/identity validation happens before appbridge detection.
  global.appbridge = {};
  captureConsole();
  assertThrows(
    function() { SDK.initFallback({ aid: 'legacy01', spid: 'ab12cd34' }); },
    TypeError,
    'aid is unsupported',
    'TC-003: legacy aid is rejected before appbridge detection'
  );
  SDK.initFallback({ spid: 'ab12cd34', environment: 'staging' });
  restoreConsole();
  assert(SDK.isFallbackMode() === false, 'TC-003: valid appbridge init is ignored after validation');
  delete global.appbridge;

  [
    { value: null, type: TypeError, message: 'config must be a plain object', label: 'null config' },
    { value: undefined, type: TypeError, message: 'config must be a plain object', label: 'undefined config' },
    { value: [], type: TypeError, message: 'config must be a plain object', label: 'array config' },
    { value: 'config', type: TypeError, message: 'config must be a plain object', label: 'string config' },
    { value: {}, type: TypeError, message: 'spid is required', label: 'missing spid' },
    { value: { spid: 'ABC12345' }, type: RangeError, message: 'spid must match', label: 'uppercase spid' },
    { value: { spid: 'abc1234' }, type: RangeError, message: 'spid must match', label: 'short spid' },
    { value: { spid: 'ab12cd34', environment: '' }, type: RangeError, message: 'environment must match', label: 'empty environment' },
    { value: { spid: 'ab12cd34', environment: ' staging' }, type: RangeError, message: 'environment must match', label: 'spaced environment' },
    { value: { spid: 'ab12cd34', environment: 'STAGING' }, type: RangeError, message: 'environment must match', label: 'uppercase environment' }
  ].forEach(function(testCase) {
    captureConsole();
    assertThrows(
      function() { SDK.initFallback(testCase.value); },
      testCase.type,
      testCase.message,
      'TC-003: rejects ' + testCase.label
    );
    restoreConsole();
  });
  assert(SDK.isFallbackMode() === false, 'TC-003: rejected configs do not create fallback state');

  // TC-001: initFallback in browser environment
  SDK.initFallback({ baseUrl: 'https://api.supersdk.com', spid: 'testapp1', appName: 'TestApp' });
  var name = await SDK.getAppName();
  assert(name === 'TestApp', 'TC-001: initFallback injects config, getAppName returns TestApp');
  var env = await SDK.getEnv();
  assert(env.environment === 'prod', 'TC-001: omitted environment defaults to prod');

  // TC-003: Multiple init overwrites
  SDK.initFallback({ spid: 'testapp1', appName: 'B' });
  name = await SDK.getAppName();
  assert(name === 'B', 'TC-003: Multiple init overwrites appName to B');

  // TC-036: Merge semantics
  // Reset state by reloading - we can't easily, so test differently
  // First set known state
  SDK.initFallback({ spid: 'ab12cd34', environment: 'staging', appName: 'A' });
  SDK.initFallback({ spid: 'ef56gh78' });
  name = await SDK.getAppName();
  assert(name === 'A', 'TC-036: merge semantics - appName preserved as A');
  env = await SDK.getEnv();
  assert(env.spid === 'ef56gh78', 'TC-036: merge semantics - spid updated');
  assert(env.environment === 'staging', 'TC-036: merge semantics - environment preserved');

  captureConsole();
  assertThrows(
    function() { SDK.initFallback({ spid: 'INVALID!', environment: 'prod', appName: 'corrupted' }); },
    RangeError,
    'spid must match',
    'TC-003: invalid re-init throws before state commit'
  );
  restoreConsole();
  env = await SDK.getEnv();
  assert(env.spid === 'ef56gh78' && env.environment === 'staging',
    'TC-003: invalid re-init preserves previously committed identity');
  name = await SDK.getAppName();
  assert(name === 'A', 'TC-003: invalid re-init preserves other fallback fields');

  // TC-005: consent is denied by default, so device identity is removed.
  var storedId = _storage['supersdk_device_id'];
  env = await SDK.getEnv();
  assert(env.deviceId === '', 'TC-005: denied consent exposes an empty deviceId');
  assert(storedId === undefined, 'TC-005: denied consent removes persisted deviceId');

  // TC-017: isFallbackMode
  assert(SDK.isFallbackMode() === true, 'TC-037: isFallbackMode returns true after init in browser');

  // =============== Section 2: Navigation ===============
  console.log('\n=== Navigation Tests ===');

  // TC-007: openPage fallback
  lastOpenArgs = null;
  SDK.openPage('https://example.com', { showTitleBar: true });
  assert(lastOpenArgs && lastOpenArgs[0] === 'https://example.com' && lastOpenArgs[1] === '_blank',
    'TC-007: openPage calls window.open with url and _blank');

  // TC-008: openExternal fallback
  lastOpenArgs = null;
  SDK.openExternal('https://example.com');
  assert(lastOpenArgs && lastOpenArgs[0] === 'https://example.com' && lastOpenArgs[1] === '_blank',
    'TC-008: openExternal calls window.open');

  // TC-009: openWithBrowser fallback
  lastOpenArgs = null;
  SDK.openWithBrowser('https://example.com');
  assert(lastOpenArgs && lastOpenArgs[0] === 'https://example.com' && lastOpenArgs[1] === '_blank',
    'TC-009: openWithBrowser calls window.open');

  // TC-010: openBrowser fallback
  lastOpenArgs = null;
  SDK.openBrowser('https://example.com', 'Test');
  assert(lastOpenArgs && lastOpenArgs[0] === 'https://example.com' && lastOpenArgs[1] === '_blank',
    'TC-010: openBrowser calls window.open');

  // TC-011: closePage fallback
  global._historyBackCalled = false;
  global.closed = false;
  SDK.closePage();
  // window.close() doesn't actually close in Node, closed stays false, so history.back should be called
  assert(global._historyBackCalled === true, 'TC-011: closePage calls history.back when window.close fails');

  // =============== Section 3: UI Feedback ===============
  console.log('\n=== UI Feedback Tests ===');

  // TC-012: showToast fallback
  captureConsole();
  SDK.showToast('hello');
  restoreConsole();
  assert(logCapture.some(l => l.includes('[SuperSDK Toast]:') && l.includes('hello')),
    'TC-012: showToast outputs [SuperSDK Toast]: hello');

  // TC-013: share fallback (sync void)
  captureConsole();
  var shareResult = SDK.share('test content');
  restoreConsole();
  assert(shareResult === undefined, 'TC-013: share returns void (undefined)');
  assert(logCapture.some(l => l.includes('[SuperSDK Share]:') && l.includes('test content')),
    'TC-013: share outputs [SuperSDK Share]: test content');

  // =============== Section 4: Env & Config ===============
  console.log('\n=== Environment & Config Tests ===');

  // TC-016: getEnv with init
  SDK.initFallback({ spid: 'testapp1', environment: 'staging', appName: 'TestApp' });
  env = await SDK.getEnv();
  assert(env.spid === 'testapp1', 'TC-016: getEnv.spid = testapp1');
  assert(env.environment === 'staging', 'TC-016: getEnv.environment = staging');
  assert(env.appName === 'TestApp', 'TC-016: getEnv.appName = TestApp');
  assert(env.os === 'web', 'TC-016: getEnv.os = web');
  assert(env.appVersion === '', 'TC-016: getEnv.appVersion = empty');
  assert(env.sdkVersion === '', 'TC-016: getEnv.sdkVersion = empty');
  assert(env.statusBarHeight === 0, 'TC-016: getEnv.statusBarHeight = 0');
  assert(env.navigationBarHeight === 0, 'TC-016: getEnv.navigationBarHeight = 0');
  assert(env.deviceId === '', 'TC-016: getEnv.deviceId is empty while consent is denied');

  // TC-018: getAppIcon with config
  SDK.initFallback({ spid: 'testapp1', appIcon: 'data:image/png;base64,abc' });
  var icon = await SDK.getAppIcon();
  assert(icon === 'data:image/png;base64,abc', 'TC-018: getAppIcon returns configured icon');

  // TC-019/020: SDK-owned dynamic settings APIs are intentionally not exposed.
  assert(typeof SDK.getSDKSettings === 'undefined', 'TC-019: getSDKSettings is not exposed');
  assert(typeof SDK.getSDKSettingsByKey === 'undefined', 'TC-020: getSDKSettingsByKey is not exposed');

  // TC-021: getHostSettings
  fetchResponse = {
    ok: true,
    status: 200,
    json: function() { return Promise.resolve({ code: 'SUCCESS', data: { someKey: 'someValue' } }); }
  };
  var settings = await SDK.getHostSettings();
  assert(settings.someKey === 'someValue', 'TC-021: getHostSettings returns Web settings data');

  // TC-022: getHostSettingsByKey
  var val = await SDK.getHostSettingsByKey('someKey');
  assert(val === 'someValue', 'TC-022: getHostSettingsByKey returns an own-property value');

  // TC-046: getHostSettings passes configName to native bridge
  let hostSettingsArgs = null;
  global.appbridge = {
    getHostSettingsByConfigNameAsync: function(configName, callbackId) {
      hostSettingsArgs = [configName, callbackId];
      setTimeout(function() {
        global.JSBridge.subscribeHandler('ASYNC_CALLBACK', callbackId, {
          code: 'SUCCESS',
          data: { enabled: true }
        });
      }, 0);
    }
  };
  settings = await SDK.getHostSettings('feature_flags');
  assert(hostSettingsArgs && hostSettingsArgs[0] === 'feature_flags',
    'TC-046: getHostSettings passes explicit configName');
  assert(settings.enabled === true, 'TC-046: getHostSettings resolves native data');

  // TC-047: getHostSettings without configName uses legacy no-configName bridge
  let legacyHostSettingsCalled = false;
  hostSettingsArgs = null;
  global.appbridge.getHostSettingsAsync = function(callbackId) {
    legacyHostSettingsCalled = true;
    setTimeout(function() {
      global.JSBridge.subscribeHandler('ASYNC_CALLBACK', callbackId, {
        code: 'SUCCESS',
        data: {}
      });
    }, 0);
  };
  settings = await SDK.getHostSettings();
  assert(legacyHostSettingsCalled === true,
    'TC-047: getHostSettings without configName uses legacy no-configName bridge');
  assert(hostSettingsArgs === null,
    'TC-047: getHostSettings without configName does not call configName bridge');
  delete global.appbridge;

  // TC-048: getHostSettingsByKey passes configName and key to native bridge
  let hostSettingsByKeyArgs = null;
  global.appbridge = {
    getHostSettingsByConfigNameAndKeyAsync: function(configName, key, callbackId) {
      hostSettingsByKeyArgs = [configName, key, callbackId];
      setTimeout(function() {
        global.JSBridge.subscribeHandler('ASYNC_CALLBACK', callbackId, {
          code: 'SUCCESS',
          data: { rollout: 50 }
        });
      }, 0);
    }
  };
  val = await SDK.getHostSettingsByKey('rollout', 'feature_flags');
  assert(hostSettingsByKeyArgs && hostSettingsByKeyArgs[0] === 'feature_flags',
    'TC-048: getHostSettingsByKey passes explicit configName');
  assert(hostSettingsByKeyArgs && hostSettingsByKeyArgs[1] === 'rollout',
    'TC-048: getHostSettingsByKey passes key');
  assert(val.rollout === 50, 'TC-048: getHostSettingsByKey resolves native data');
  delete global.appbridge;

  // =============== Section 5: reportEvent ===============
  console.log('\n=== ReportEvent Tests ===');

  // TC-023: reportEvent with baseUrl and project identity
  SDK.initFallback({ baseUrl: 'https://api.supersdk.com', spid: 'testapp1', environment: 'staging' });
  await SDK.setAnalyticsConsent('granted');
  lastFetchArgs = null;
  fetchResponse = { ok: true, status: 200, json: function() { return Promise.resolve({ code: 'SUCCESS' }); } };
  fetchShouldThrow = false;
  await SDK.reportEvent('click_btn', { page: 'home' });
  await SDK.flush();
  assert(lastFetchArgs !== null, 'TC-023: fetch was called');
  assert(lastFetchArgs.url === 'https://api.supersdk.com/superapi/v2/reportEvent', 'TC-023: correct v2 endpoint');
  var body = JSON.parse(lastFetchArgs.options.body);
  assert(body.basic_data.app_id === undefined, 'TC-023: Web basic_data does not forge native app_id');
  assert(body.basic_data.host_spid === 'testapp1', 'TC-023: basic_data.host_spid = configured spid');
  assert(body.basic_data.env === 'staging', 'TC-023: basic_data.env = configured environment');
  assert(body.basic_data.host_aid === undefined, 'TC-023: basic_data.host_aid is absent');
  assert(lastFetchArgs.options.headers['Content-Type'] === 'application/json', 'TC-023: Content-Type header is application/json');
  assert(lastFetchArgs.options.headers['X-Aid'] === 'testapp1', 'TC-023: X-Aid compatibility header carries spid');
  assert(lastFetchArgs.options.headers['X-Super-API-ENV'] === 'staging', 'TC-023: environment header matches body');
  assert(lastFetchArgs.options.headers['X-Spid'] === undefined, 'TC-023: X-Spid header is absent');
  assert(body.basic_data.os_type === 'web', 'TC-023: basic_data.os_type = web');
  assert(body.basic_data.source === 'web_sdk_untrusted', 'TC-023: basic_data.source = web_sdk_untrusted');
  assert(body.events[0].event_name === 'click_btn', 'TC-023: event_name = click_btn');
  assert(typeof body.events[0].event_param === 'object' && !Array.isArray(body.events[0].event_param), 'TC-023: event_param is a plain object (AC-4)');
  assert(body.events[0].event_param.page === 'home', 'TC-023: event_param.page = home (object access)');
  assert(typeof body.events[0].event_param.evt_unique_id === 'string', 'TC-023: event_param carries a stable event ID');
  assert(typeof body.events[0].client_ts_ms === 'number', 'TC-023: client_ts_ms is number');

  // TC-004 boundary: 非 plain-object params 一律落 {} (AC-4 plain-object guard)
  function _eventParamOf(args) { return JSON.parse(args.options.body).events[0].event_param; }
  function _hasOnlyEventId(v) {
    return v && typeof v === 'object' && !Array.isArray(v)
      && Object.keys(v).length === 1 && typeof v.evt_unique_id === 'string';
  }
  var boundaryInputs = ['a string', 123, [1, 2, 3], new Date(), null, undefined];
  for (var bi = 0; bi < boundaryInputs.length; bi++) {
    lastFetchArgs = null;
    await SDK.reportEvent('boundary_evt', boundaryInputs[bi]);
    await SDK.flush();
    assert(_hasOnlyEventId(_eventParamOf(lastFetchArgs)),
      'TC-004: non-plain-object params preserve only evt_unique_id (' + (boundaryInputs[bi] === null ? 'null' : typeof boundaryInputs[bi] === 'object' ? Object.prototype.toString.call(boundaryInputs[bi]) : typeof boundaryInputs[bi]) + ')');
  }

  // TC-021: retryable HTTP failure remains observable in the delivery state.
  fetchResponse = { ok: false, status: 500, json: function() { return Promise.resolve({ code: 'UPSTREAM_ERROR' }); } };
  await SDK.reportEvent('test', {});
  var failedFlush = await SDK.flush();
  assert(failedFlush.retrying === 1, 'TC-021: HTTP 500 schedules one retry');
  assert(SDK.getDeliveryState().pending === 1, 'TC-021: retry is visible in delivery state');
  await SDK.setAnalyticsConsent('denied');
  await SDK.setAnalyticsConsent('granted');

  // TC-021: network failure uses the same observable retry contract.
  fetchShouldThrow = true;
  await SDK.reportEvent('test', {});
  failedFlush = await SDK.flush();
  assert(failedFlush.retrying === 1, 'TC-021: network failure schedules one retry');
  fetchShouldThrow = false;
  await SDK.setAnalyticsConsent('denied');
  await SDK.setAnalyticsConsent('granted');

  // TC-045: reportEvent baseUrls fallback and records last successful URL
  _storage['supersdk_last_success_base_url'] = 'https://bad.supersdk.com/superapi';
  SDK.initFallback({
    baseUrls: ['https://bad.supersdk.com/superapi/', 'https://good.supersdk.com/superapi'],
    spid: 'testapp1',
    environment: 'staging',
    analyticsConsent: 'granted'
  });
  fetchCalls = [];
  fetchQueue = [
    { ok: false, status: 500, json: function() { return Promise.resolve({ code: 'UPSTREAM_ERROR' }); } },
    { ok: true, status: 200, json: function() { return Promise.resolve({ code: 'SUCCESS' }); } }
  ];
  await SDK.reportEvent('fallback_test', {});
  await SDK.flush();
  assert(fetchCalls.length === 2, 'TC-045: reportEvent tries next base URL after 5xx');
  assert(fetchCalls[0].url === 'https://bad.supersdk.com/superapi/v2/reportEvent',
    'TC-045: last successful URL is tried first');
  assert(fetchCalls[1].url === 'https://good.supersdk.com/superapi/v2/reportEvent',
    'TC-045: second base URL receives retry');
  fetchCalls.forEach(function(call, index) {
    var fallbackBody = JSON.parse(call.options.body);
    assert(call.options.headers['Content-Type'] === 'application/json',
      'TC-008: fallback fetch ' + (index + 1) + ' has Content-Type');
    assert(call.options.headers['X-Aid'] === 'testapp1'
      && call.options.headers['X-Super-API-ENV'] === 'staging'
      && call.options.headers['X-Spid'] === undefined,
      'TC-008: fallback fetch ' + (index + 1) + ' has compatible identity headers only');
    assert(fallbackBody.basic_data.host_spid === 'testapp1'
      && fallbackBody.basic_data.env === 'staging'
      && fallbackBody.basic_data.host_aid === undefined
      && fallbackBody.basic_data.app_id === undefined,
      'TC-008: fallback fetch ' + (index + 1) + ' body identity matches headers');
  });
  assert(_storage['supersdk_last_success_base_url'] === 'https://good.supersdk.com/superapi',
    'TC-045: successful retry URL is recorded');

  // TC-021: multiple failed routes retain a retry without exposing project identity.
  _storage['supersdk_last_success_base_url'] = 'https://bad.supersdk.com/superapi';
  fetchCalls = [];
  fetchQueue = [
    { ok: false, status: 503, json: function() { return Promise.resolve({ code: 'UNAVAILABLE' }); } },
    { error: new Error('route failed for testapp1') }
  ];
  await SDK.reportEvent('all_routes_fail', {});
  failedFlush = await SDK.flush();
  assert(failedFlush.retrying === 1, 'TC-021: failed routes schedule one retry');
  assert(JSON.stringify(SDK.getDeliveryState()).indexOf('testapp1') === -1,
    'TC-021: delivery state never exposes spid or exception details');
  _storage['supersdk_last_success_base_url'] = 'https://good.supersdk.com/superapi';
  await SDK.setAnalyticsConsent('denied');
  await SDK.setAnalyticsConsent('granted');

  // TC-046: reportEvent prefers the recorded successful URL on the next request
  fetchCalls = [];
  fetchQueue = [{ ok: true, status: 200, json: function() { return Promise.resolve({ code: 'SUCCESS' }); } }];
  await SDK.reportEvent('prefer_last_success', {});
  await SDK.flush();
  assert(fetchCalls.length === 1, 'TC-046: reportEvent succeeds with first preferred base URL');
  assert(fetchCalls[0].url === 'https://good.supersdk.com/superapi/v2/reportEvent',
    'TC-046: recorded successful URL is preferred');
  fetchQueue = [];

  // =============== Section 6: Ungradable APIs ===============
  console.log('\n=== Ungradable API Tests ===');

  var notInAppMsg = 'Not in app environment';

  // TC-027: callHostMethod
  await assertRejects(SDK.callHostMethod('test', {}), notInAppMsg, 'TC-027: callHostMethod rejects');

  // TC-028: requestShortUrl
  await assertRejects(SDK.requestShortUrl('https://example.com'), notInAppMsg, 'TC-028: requestShortUrl rejects');

  // TC-040: requestShortUrlWithHtml
  await assertRejects(SDK.requestShortUrlWithHtml('<html>test</html>'), notInAppMsg, 'TC-040: requestShortUrlWithHtml rejects');

  // TC-029: fileExists
  await assertRejects(SDK.fileExists('test.txt'), notInAppMsg, 'TC-029: fileExists rejects');

  // TC-031: getAttribution
  await assertRejects(SDK.getAttribution(), notInAppMsg, 'TC-031: getAttribution rejects');

  // TC-030: downloadFile
  let downloadFailError = null;
  SDK.downloadFile({
    url: 'https://example.com/f.zip',
    savePath: 'f.zip',
    onFail: function(err) { downloadFailError = err; }
  });
  assert(downloadFailError && downloadFailError.error.includes(notInAppMsg),
    'TC-030: downloadFile onFail with Not in app environment');

  // TC-043: downloadWithCache rejects outside app
  await assertRejects(
    SDK.downloadWithCache('https://example.com/f.zip', '', 60, ''),
    notInAppMsg,
    'TC-043: downloadWithCache rejects'
  );

  // TC-044: downloadWithCache raw bridge args and success payload
  let lastDownloadWithCacheArgs = null;
  global.appbridge = {
    downloadWithCache: function(callbackId, fileUrl, fileMd5, cacheTts, fileCacheKey) {
      lastDownloadWithCacheArgs = [callbackId, fileUrl, fileMd5, cacheTts, fileCacheKey];
      setTimeout(function() {
        global.JSBridge.subscribeHandler('ASYNC_CALLBACK', callbackId, {
          code: 'SUCCESS',
          data: {
            filePath: '/tmp/supersdk/download_cache/a.bin',
            cacheHit: true,
            cacheKey: fileCacheKey
          }
        });
      }, 0);
    }
  };
  const cached = await SDK.downloadWithCache(
    'https://example.com/f.zip?t=1',
    'd41d8cd98f00b204e9800998ecf8427e',
    60,
    'asset-f'
  );
  assert(lastDownloadWithCacheArgs && lastDownloadWithCacheArgs[1] === 'https://example.com/f.zip?t=1',
    'TC-044: downloadWithCache passes fileUrl as second raw arg');
  assert(lastDownloadWithCacheArgs && lastDownloadWithCacheArgs[2] === 'd41d8cd98f00b204e9800998ecf8427e',
    'TC-044: downloadWithCache passes fileMd5 as third raw arg');
  assert(lastDownloadWithCacheArgs && lastDownloadWithCacheArgs[3] === 60,
    'TC-044: downloadWithCache passes cacheTts as fourth raw arg');
  assert(lastDownloadWithCacheArgs && lastDownloadWithCacheArgs[4] === 'asset-f',
    'TC-044: downloadWithCache passes fileCacheKey as fifth raw arg');
  assert(cached.filePath === '/tmp/supersdk/download_cache/a.bin' && cached.cacheHit === true && cached.cacheKey === 'asset-f',
    'TC-044: downloadWithCache resolves native success payload');
  delete global.appbridge;

  // TC-041: zipDir (TC references zipFiles but code has zipDir)
  await assertRejects(SDK.zipDir('a.txt', 'out.zip'), notInAppMsg, 'TC-041: zipDir rejects');

  // TC-032: nativeBlock.create
  await assertRejects(
    SDK.nativeBlock.create({ blockId: 'b1', blockType: 'ad' }),
    notInAppMsg,
    'TC-032: nativeBlock.create rejects'
  );

  // Additional file ops
  await assertRejects(SDK.getFileMd5('test'), notInAppMsg, 'getFileMd5 rejects');
  await assertRejects(SDK.deleteFile('test'), notInAppMsg, 'deleteFile rejects');
  await assertRejects(SDK.moveFile('a', 'b'), notInAppMsg, 'moveFile rejects');
  await assertRejects(SDK.createDir('test'), notInAppMsg, 'createDir rejects');
  await assertRejects(SDK.listDir('test'), notInAppMsg, 'listDir rejects');
  await assertRejects(SDK.readFile('test'), notInAppMsg, 'readFile rejects');
  await assertRejects(SDK.writeFile('test', 'data'), notInAppMsg, 'writeFile rejects');
  await assertRejects(SDK.unzipFile('a.zip', 'dest'), notInAppMsg, 'unzipFile rejects');

  // =============== Section 6.5: Pay API · SDK-F036 namespace + SDK-F038 v0.3 哑管道 ===============
  console.log('\n=== SDK-F036/F038 v0.3 · Pay API Tests ===');

  // T-005 (AC-4) · 老顶层 7 API 全部消失
  ['purchase','queryProducts','acknowledgePurchase','consumePurchase',
   'restorePurchases','getPayProviders','registerPayProvider'].forEach(function(k) {
    assert(SDK[k] === undefined,
      'T-005 (AC-4): SuperSDK.' + k + ' is undefined (legacy API removed)');
  });

  // TC-3 (F038 AC-2) · namespace 恰 4 个 method · 无 createAndPay / queryOrder
  assert(typeof SDK.pay === 'object' && SDK.pay !== null, 'TC-3: SuperSDK.pay is object');
  var payKeys = Object.keys(SDK.pay).sort();
  var expectedKeys = ['getProviders', 'purchase', 'registerProvider', 'restorePurchases'].sort();
  assert(JSON.stringify(payKeys) === JSON.stringify(expectedKeys),
    'TC-3: SuperSDK.pay namespace exposes exactly 4 methods · got [' + payKeys.join(',') + ']');
  expectedKeys.forEach(function(k) {
    assert(typeof SDK.pay[k] === 'function', 'TC-3: SuperSDK.pay.' + k + ' is function');
  });
  // TC-3 · v0.3 不新增公共方法(无 createAndPay · 无 queryOrder)
  assert(SDK.pay.createAndPay === undefined, 'TC-3 (F038 AC-2): SuperSDK.pay.createAndPay is undefined');
  assert(SDK.pay.queryOrder === undefined, 'TC-3 (F038 AC-2): SuperSDK.pay.queryOrder is undefined');

  // T-006 + T-017 (AC-5) · invalid payConfig + err.detail 字段
  //   v0.3 哑管道:SDK 仅校验 payConfig/payParams 是对象 · 不再校验 productId(那是 provider 的事)
  var invalidInputs = [
    { input: undefined,            detailMatch: 'payConfig must be object' },
    { input: null,                 detailMatch: 'payConfig must be object' },
    { input: 'string',             detailMatch: 'payConfig must be object' },
    { input: 123,                  detailMatch: 'payConfig must be object' },
    { input: [],                   detailMatch: 'payConfig must be object' },
    { input: {},                   detailMatch: 'payParams must be object' },
    { input: { provider: 'x' },    detailMatch: 'payParams must be object' },
    { input: { payParams: 'x' },   detailMatch: 'payParams must be object' },
    { input: { payParams: null },  detailMatch: 'payParams must be object' },
    { input: { payParams: [] },    detailMatch: 'payParams must be object' }
  ];
  for (var i = 0; i < invalidInputs.length; i++) {
    var tc = invalidInputs[i];
    var caught = null;
    try { await SDK.pay.purchase(tc.input); }
    catch (e) { caught = e; }
    var ok = caught
      && caught.message === 'INVALID_PARAMS'
      && typeof caught.detail === 'string'
      && caught.detail.indexOf(tc.detailMatch) >= 0;
    var inputStr = (typeof tc.input === 'undefined') ? 'undefined' : String(JSON.stringify(tc.input)).slice(0, 50);
    assert(ok, 'T-006/T-017 (AC-5): pay.purchase(' + inputStr +
      ') rejects INVALID_PARAMS with detail "' + tc.detailMatch + '" · got ' +
      (caught ? caught.message + ' / detail=' + caught.detail : 'no error'));
  }

  // T-008 (AC-5) · 多 provider + 不传 provider → PROVIDER_REQUIRED
  // 先 register 一个 JS provider(v0.3:含 pay)· mock appbridge 返回多个 native providers
  SDK.pay.registerProvider('alipay_t008', { pay: function() { return Promise.resolve({ status: 'finished' }); } });
  global.appbridge = {
    getPayProviders: function(callbackId) {
      setTimeout(function() {
        global.JSBridge.subscribeHandler('ASYNC_CALLBACK', callbackId,
          { code: 'SUCCESS', data: { providers: ['google_play', 'apple'] } });
      }, 0);
    }
  };
  var t008caught = null;
  try { await SDK.pay.purchase({ payParams: { productId: 'sku_1' } }); }
  catch (e) { t008caught = e; }
  assert(t008caught && t008caught.message === 'PROVIDER_REQUIRED',
    'T-008 (AC-5): multi providers no provider rejects PROVIDER_REQUIRED · got ' +
    (t008caught ? t008caught.message : 'no error'));
  delete global.appbridge;

  // ---------------------------------------------------------------------------
  // SDK-F038 v0.3 哑管道(createOrder→pay · resolve PayResult3State)
  //   purchase: json = createOrder(payParams) → pay(json) → 三态
  //   内置 IAP 走 appbridge.nativePay(provider, JSON.stringify(json), cbId)
  //   mock nativePay 经 ASYNC_CALLBACK { code:'SUCCESS', data:{ status, orderToken? } } 投三态
  //   SDK 是哑管道:不解析 json 任何字段 · 原样透传
  // ---------------------------------------------------------------------------

  // helper:mock appbridge.nativePay · 记录入参(provider/jsonString)· 按给定三态 data 投递
  function mockNativePay(threeStateData) {
    var calls = [];
    global.appbridge = {
      nativePay: function(provider, jsonString, cbId) {
        calls.push({ provider: provider, jsonString: jsonString });
        setTimeout(function() {
          global.JSBridge.subscribeHandler('ASYNC_CALLBACK', cbId, { code: 'SUCCESS', data: threeStateData });
        }, 0);
      }
    };
    return calls;
  }

  // TC-1 (F038 AC-1) · 三方 provider(createOrder + pay)编排
  //   createOrder 收 payParams · pay 收 createOrder 产出的 json(原样透传)
  var tc1CreateOrderArg = null;
  var tc1PayArg = null;
  var tc1Json = { orderToken: 'ot_tc1', amount: 100, sku: 'p1' };
  SDK.pay.registerProvider('biz', {
    createOrder: function(payParams) {
      tc1CreateOrderArg = payParams;
      return Promise.resolve(tc1Json);
    },
    pay: function(json) {
      tc1PayArg = json;
      return Promise.resolve({ status: 'finished', orderToken: json.orderToken });
    }
  });
  var tc1Result = await SDK.pay.purchase({ provider: 'biz', payParams: { productId: 'p1', biz: 'x' } });
  assert(tc1CreateOrderArg && tc1CreateOrderArg.productId === 'p1' && tc1CreateOrderArg.biz === 'x',
    'TC-1 (AC-1): createOrder invoked with original payParams · got ' + JSON.stringify(tc1CreateOrderArg));
  assert(tc1PayArg === tc1Json,
    'TC-1 (AC-1): pay receives the exact json object produced by createOrder (passthrough · same reference)');
  assert(tc1Result && tc1Result.status === 'finished' && tc1Result.orderToken === 'ot_tc1',
    'TC-1 (AC-1): purchase resolves three-state from provider.pay · got ' + JSON.stringify(tc1Result));

  // TC-4 (哑管道 · F038 AC-1) · createOrder 返回任意 json → SDK 一字未改透传
  //   ① 三方 pay 收到 deepEqual 完全相同对象;② 内置 IAP nativePay 收到 JSON.stringify(完全相同)
  var arbitraryJson = { foo: 1, nested: { x: 2 }, arr: [3, 4], s: 'keep' };

  // ①三方 pay:对象引用一致 + deepEqual
  var tc4PayArg = null;
  SDK.pay.registerProvider('biz_dumb', {
    createOrder: function() { return arbitraryJson; },
    pay: function(json) { tc4PayArg = json; return Promise.resolve({ status: 'finished' }); }
  });
  await SDK.pay.purchase({ provider: 'biz_dumb', payParams: { anything: true } });
  assert(tc4PayArg === arbitraryJson,
    'TC-4 (哑管道): JS provider.pay receives same object reference (SDK untouched)');
  assert(JSON.stringify(tc4PayArg) === JSON.stringify(arbitraryJson),
    'TC-4 (哑管道): JS provider.pay receives deepEqual json · got ' + JSON.stringify(tc4PayArg));

  // ②内置 IAP nativePay:JSON.stringify 完全相同
  var tc4NativeCalls = mockNativePay({ status: 'finished' });
  SDK.pay.registerProvider('google_play_dumb', {
    createOrder: function() { return arbitraryJson; }
  });
  await SDK.pay.purchase({ provider: 'google_play_dumb', payParams: { anything: true } });
  assert(tc4NativeCalls.length === 1,
    'TC-4 (哑管道): nativePay invoked once for IAP override');
  assert(tc4NativeCalls[0].jsonString === JSON.stringify(arbitraryJson),
    'TC-4 (哑管道): nativePay receives JSON.stringify of identical json · got ' + tc4NativeCalls[0].jsonString);
  delete global.appbridge;

  // TC-5 (通用 JSB + SDK_TOO_OLD) · 内置 IAP 走 appbridge.nativePay(3 参)
  var tc5Calls = mockNativePay({ status: 'finished', orderToken: 'ot_tc5' });
  // provider 'google_play' 仅 createOrder(无 pay)→ 内置 IAP
  SDK.pay.registerProvider('google_play', {
    createOrder: function(payParams) { return { sku: payParams.productId, orderToken: 'ot_tc5' }; }
  });
  var tc5Result = await SDK.pay.purchase({ provider: 'google_play', payParams: { productId: 'sku_5' } });
  assert(tc5Calls.length === 1 && tc5Calls[0].provider === 'google_play',
    'TC-5: IAP routes to appbridge.nativePay with provider name · got ' + JSON.stringify(tc5Calls[0] && tc5Calls[0].provider));
  assert(tc5Calls[0].jsonString === JSON.stringify({ sku: 'sku_5', orderToken: 'ot_tc5' }),
    'TC-5: nativePay 2nd arg is JSON string of produced json · got ' + tc5Calls[0].jsonString);
  assert(tc5Result && tc5Result.status === 'finished',
    'TC-5: IAP resolves three-state · got ' + JSON.stringify(tc5Result));
  delete global.appbridge;

  // TC-5 · 删 nativePay(老 SDK 仅有别的方法)→ purchase **reject** SDK_TOO_OLD(不静默 fallback)
  //   生产 bug 已修:_nativePay 的"无法开始"reject(SDK_TOO_OLD/NOT_IN_APP)现穿透到调用方 ·
  //   不再被 _runProvider 吞成 create 三态。
  var tc5LegacyCalled = false;
  global.appbridge = {
    purchase: function() { tc5LegacyCalled = true; }  // 老方法存在但无 nativePay
  };
  var tc5OldCaught = null;
  try {
    await SDK.pay.purchase({ provider: 'google_play', payParams: { productId: 'sku_old' } });
  } catch (e) { tc5OldCaught = e; }
  assert(tc5OldCaught instanceof Error && tc5OldCaught.message === 'SDK_TOO_OLD',
    'TC-5: old SDK without nativePay → purchase REJECTS Error SDK_TOO_OLD · got ' +
    (tc5OldCaught ? tc5OldCaught.message : 'no error / resolved'));
  assert(tc5LegacyCalled === false,
    'TC-5: legacy appbridge.purchase NOT silently called');
  delete global.appbridge;

  // TC-5b · 无 appbridge(非端环境)· 内置 IAP → purchase **reject** NOT_IN_APP
  delete global.appbridge;
  var tc5NoAppCaught = null;
  try {
    await SDK.pay.purchase({ provider: 'google_play', payParams: { productId: 'sku_noapp' } });
  } catch (e) { tc5NoAppCaught = e; }
  assert(tc5NoAppCaught instanceof Error && tc5NoAppCaught.message === 'NOT_IN_APP',
    'TC-5b: no appbridge → IAP purchase REJECTS Error NOT_IN_APP · got ' +
    (tc5NoAppCaught ? tc5NoAppCaught.message : 'no error / resolved'));

  // TC-9 风格 (F038 AC-5) · finished 三态不含凭证字段(凭证不出 Native)
  var tc9Calls = mockNativePay({ status: 'finished', orderToken: 'ot_tc9' });
  var tc9Result = await SDK.pay.purchase({ provider: 'google_play', payParams: { productId: 'sku_tc9' } });
  assert(tc9Result && tc9Result.status === 'finished',
    'TC-9: finished three-state · got ' + JSON.stringify(tc9Result));
  assert(tc9Result.purchaseToken === undefined
    && tc9Result.signature === undefined
    && tc9Result.originalJson === undefined,
    'TC-9: finished result excludes purchaseToken/signature/originalJson · got ' + JSON.stringify(tc9Result));
  assert(tc9Calls.length === 1, 'TC-9: nativePay invoked once');
  delete global.appbridge;

  // 三态覆盖 · cancelled / pay-error(Native 经 SUCCESS data 通道投递)
  mockNativePay({ status: 'cancelled', orderToken: 'ot_cancel' });
  var cancelResult = await SDK.pay.purchase({ provider: 'google_play', payParams: { productId: 'sku_cancel' } });
  assert(cancelResult && cancelResult.status === 'cancelled',
    'v0.3 native cancelled three-state · got ' + JSON.stringify(cancelResult));
  delete global.appbridge;

  mockNativePay({ status: 'error', phase: 'pay', code: 'BILLING_UNAVAILABLE' });
  var payErrResult = await SDK.pay.purchase({ provider: 'google_play', payParams: { productId: 'sku_err' } });
  assert(payErrResult && payErrResult.status === 'error' && payErrResult.phase === 'pay'
    && payErrResult.code === 'BILLING_UNAVAILABLE',
    'v0.3 native pay-error three-state · got ' + JSON.stringify(payErrResult));
  delete global.appbridge;

  // 三方 reg.pay throw/reject → 归一化为 pay error 三态(已开始的终态 resolve · 不 reject)
  // ① reg.pay throw
  SDK.pay.registerProvider('biz_pay_throw', {
    pay: function() { throw new Error('pay boom'); }
  });
  var bizPayThrowResult = await SDK.pay.purchase({ provider: 'biz_pay_throw', payParams: { productId: 'p' } });
  assert(bizPayThrowResult && bizPayThrowResult.status === 'error' && bizPayThrowResult.phase === 'pay',
    'third-party reg.pay throw → resolve {status:error, phase:pay} · got ' + JSON.stringify(bizPayThrowResult));

  // ② reg.pay reject
  SDK.pay.registerProvider('biz_pay_reject', {
    pay: function() { return Promise.reject(new Error('pay rejected')); }
  });
  var bizPayRejectResult = await SDK.pay.purchase({ provider: 'biz_pay_reject', payParams: { productId: 'p' } });
  assert(bizPayRejectResult && bizPayRejectResult.status === 'error' && bizPayRejectResult.phase === 'pay',
    'third-party reg.pay reject → resolve {status:error, phase:pay} · got ' + JSON.stringify(bizPayRejectResult));

  // TC-11 (create error) · createOrder reject → resolve {status:error, phase:create} · 不调 pay/nativePay
  // ① 三方 provider:pay 不应被调用
  var tc11PayCalled = false;
  SDK.pay.registerProvider('biz_create_fail', {
    createOrder: function() { return Promise.reject(new Error('create failed')); },
    pay: function() { tc11PayCalled = true; return Promise.resolve({ status: 'finished' }); }
  });
  var tc11Result = await SDK.pay.purchase({ provider: 'biz_create_fail', payParams: { productId: 'p' } });
  assert(tc11Result && tc11Result.status === 'error' && tc11Result.phase === 'create',
    'TC-11: createOrder reject → resolve {status:error, phase:create} · got ' + JSON.stringify(tc11Result));
  assert(tc11PayCalled === false,
    'TC-11: provider.pay NOT called when createOrder rejects');

  // ② 内置 IAP:createOrder throw → nativePay 不应被调用
  var tc11NativeCalled = false;
  global.appbridge = {
    nativePay: function() { tc11NativeCalled = true; }
  };
  SDK.pay.registerProvider('google_play_create_fail', {
    createOrder: function() { throw new Error('create boom'); }
  });
  var tc11IapResult = await SDK.pay.purchase({ provider: 'google_play_create_fail', payParams: { productId: 'p' } });
  assert(tc11IapResult && tc11IapResult.status === 'error' && tc11IapResult.phase === 'create',
    'TC-11: IAP createOrder throw → resolve {status:error, phase:create} · got ' + JSON.stringify(tc11IapResult));
  assert(tc11NativeCalled === false,
    'TC-11: appbridge.nativePay NOT called when createOrder throws');
  delete global.appbridge;

  // TC-16 (三方通道契约) · provider.pay 自返三态(与 IAP 一致 resolve 三态)
  var tc16PayArg = null;
  SDK.pay.registerProvider('stripe', {
    createOrder: function(payParams) { return { orderToken: 'ot_tc16', sku: payParams.productId }; },
    pay: function(json) {
      tc16PayArg = json;
      return Promise.resolve({ status: 'finished', orderToken: json.orderToken });
    }
  });
  var tc16Result = await SDK.pay.purchase({ provider: 'stripe', payParams: { productId: 'sku_tc16' } });
  assert(tc16PayArg && tc16PayArg.orderToken === 'ot_tc16' && tc16PayArg.sku === 'sku_tc16',
    'TC-16: provider.pay receives createOrder json · got ' + JSON.stringify(tc16PayArg));
  assert(tc16Result && tc16Result.status === 'finished' && tc16Result.orderToken === 'ot_tc16',
    'TC-16: third-party provider.pay self-returns three-state finished · got ' + JSON.stringify(tc16Result));

  // TC-16b · provider 无 createOrder(仅 pay)→ createOrder 缺省为 identity · pay 收 payParams 原样
  var tc16bPayArg = null;
  var tc16bParams = { productId: 'sku_x', biz: 7 };
  SDK.pay.registerProvider('wechat', {
    pay: function(json) { tc16bPayArg = json; return Promise.resolve({ status: 'finished' }); }
  });
  await SDK.pay.purchase({ provider: 'wechat', payParams: tc16bParams });
  assert(tc16bPayArg === tc16bParams,
    'TC-16b: no createOrder → identity · pay receives payParams as-is (same reference)');

  // TC-18 (破坏式) · purchase 不再 resolve PurchaseResult 旧字段(无 orderId/purchaseToken/signature)
  mockNativePay({ status: 'finished', orderToken: 'ot_tc18' });
  var tc18Result = await SDK.pay.purchase({ provider: 'google_play', payParams: { productId: 'sku_tc18' } });
  assert(tc18Result && typeof tc18Result.status === 'string',
    'TC-18: purchase resolves PayResult3State (has status) · got ' + JSON.stringify(tc18Result));
  assert(tc18Result.orderId === undefined
    && tc18Result.purchaseToken === undefined
    && tc18Result.signature === undefined
    && tc18Result.originalJson === undefined,
    'TC-18 (破坏式): legacy PurchaseResult fields absent (orderId/purchaseToken/signature/originalJson) · got ' + JSON.stringify(tc18Result));
  delete global.appbridge;

  // T-013 (AC-8) · inline 并发守门(_webInlineInProgress · 仍在 JS 层)
  //   v0.3 inline = payConfig.pay 函数;第一笔 pay 挂起(unresolved)· 第二笔应 reject PURCHASE_IN_PROGRESS
  var inlineHang = new Promise(function() {});
  var firstInlinePromise = SDK.pay.purchase({
    payParams: { productId: 'sku_lock' },
    pay: function() { return inlineHang; }
  });
  var t013caught = null;
  try {
    await SDK.pay.purchase({
      payParams: { productId: 'sku_lock2' },
      pay: function() { return Promise.resolve({ status: 'finished' }); }
    });
  } catch (e) { t013caught = e; }
  assert(t013caught && t013caught.message === 'PURCHASE_IN_PROGRESS',
    'T-013 (AC-8): inline concurrent purchase rejects PURCHASE_IN_PROGRESS · got ' +
    (t013caught ? t013caught.message : 'no error'));
  // 防 Node 进程退出时 unhandled rejection
  firstInlinePromise.catch(function() {});

  // T-015 (AC-7) · restorePurchases · known provider 未实现 → NOT_SUPPORTED
  global.appbridge = {
    restorePurchases: function(provider, cbId) {
      setTimeout(function() {
        global.JSBridge.subscribeHandler('ASYNC_CALLBACK', cbId,
          { code: 'NOT_SUPPORTED', message: 'PayService default impl' });
      }, 0);
    }
  };
  var t015caught = null;
  try { await SDK.pay.restorePurchases({ provider: 'google' }); }
  catch (e) { t015caught = e; }
  assert(t015caught && t015caught.message === 'NOT_SUPPORTED',
    'T-015 (AC-7): restorePurchases known provider no impl returns NOT_SUPPORTED · got ' +
    (t015caught ? t015caught.message : 'no error'));

  // T-016 (AC-5) · restorePurchases · unknown provider → PROVIDER_NOT_FOUND
  global.appbridge = {
    restorePurchases: function(provider, cbId) {
      setTimeout(function() {
        global.JSBridge.subscribeHandler('ASYNC_CALLBACK', cbId,
          { code: 'PROVIDER_NOT_FOUND', message: 'No provider named ' + provider });
      }, 0);
    }
  };
  var t016caught = null;
  try { await SDK.pay.restorePurchases({ provider: 'unknown_xyz' }); }
  catch (e) { t016caught = e; }
  assert(t016caught && t016caught.message === 'PROVIDER_NOT_FOUND',
    'T-016 (AC-5): restorePurchases unknown provider returns PROVIDER_NOT_FOUND · got ' +
    (t016caught ? t016caught.message : 'no error'));
  delete global.appbridge;

  // =============== Section 7: Rewarded Interstitial Ads ===============
  console.log('\n=== Rewarded Interstitial Ad Tests ===');

  var rewardedInterstitialArgs = null;
  global.appbridge = {
    showRewardedInterstitialAd: function(config, callbackId) {
      rewardedInterstitialArgs = [JSON.parse(config), callbackId];
      setTimeout(function() {
        global.JSBridge.subscribeHandler('ASYNC_CALLBACK', callbackId, {
          code: 'SUCCESS',
          data: { dismissed: true, rewarded: true }
        });
      }, 0);
    }
  };
  var rewardedInterstitialResult = await SDK.showRewardedInterstitialAd({
    adUnitId: 'ri-test',
    adSource: 'ADMOB'
  });
  assert(rewardedInterstitialArgs && rewardedInterstitialArgs[0].adUnitId === 'ri-test',
    'Ad: showRewardedInterstitialAd forwards adUnitId');
  assert(rewardedInterstitialResult.dismissed === true && rewardedInterstitialResult.rewarded === true,
    'Ad: showRewardedInterstitialAd resolves terminal result');

  global.appbridge = {};
  var unsupportedRewardedInterstitial = null;
  try {
    await SDK.showRewardedInterstitialAd({ adUnitId: 'ri-test' });
  } catch (e) {
    unsupportedRewardedInterstitial = e;
  }
  assert(unsupportedRewardedInterstitial
      && unsupportedRewardedInterstitial.message === 'NOT_SUPPORTED',
    'Ad: old or unsupported native bridge rejects NOT_SUPPORTED immediately');
  delete global.appbridge;

  // =============== Section 8: Broadcast ===============
  console.log('\n=== Broadcast Tests ===');

  // TC-033: subscribe works in browser
  var unsub = SDK.subscribe('testEvent', function() {});
  assert(typeof unsub === 'function', 'TC-033: subscribe returns unsubscribe function');

  // TC-034: publish doesn't throw
  captureConsole();
  var publishError = null;
  try { SDK.publish('testEvent', { data: 1 }); } catch(e) { publishError = e; }
  restoreConsole();
  assert(publishError === null, 'TC-034: publish does not throw');

  // =============== Section 9: isFallbackMode ===============
  console.log('\n=== Fallback Mode Tests ===');

  // TC-037 already tested above
  // TC-039: non-app without init - can't easily test since we already called init

  // TC-038: in-app returns false
  global.appbridge = {};
  assert(SDK.isFallbackMode() === false, 'TC-038: isFallbackMode returns false in app');

  // TC-002: initFallback ignored in app
  SDK.initFallback({ spid: 'ab12cd34', appName: 'Override' });
  // In app, getAppName would call appbridge - we just verify initFallback didn't crash
  assert(true, 'TC-002: initFallback in app does not throw');
  delete global.appbridge;

  // =============== Section 10: reportEvent without init ===============
  console.log('\n=== ReportEvent without init Tests ===');

  // A fresh module instance rejects before fetch until init commits an identity.
  var uninitializedSDK = SDK.createSuperSDK({ target: {} });
  await assertRejects(
    Promise.resolve().then(function() { return uninitializedSDK.reportEvent('test', {}); }),
    'has not been initialized',
    'TC-024/TC-025: reportEvent without init rejects'
  );

  // =============== Summary ===============
  console.log('\n================================');
  console.log('Results:', passed, 'passed,', failed, 'failed');
  console.log('================================');

  if (failed > 0) {
    process.exit(1);
  }
  // 显式 exit · 防 SDK-F036 测试遗留的 _nativePurchase 190s timeout 让 Node 进程 hang
  // (应对 external review F036 P2 finding)
  process.exit(0);
}

runTests().catch(function(e) {
  console.error('Test runner error:', e);
  process.exit(1);
});
