import { createLegacyRuntime } from './legacy-runtime.js';
import { normalizeConfig, validateEnvironment } from '../core/config.js';
import { createDiagnostics } from '../core/diagnostics.js';
import { SuperSDKError, sdkError } from '../core/errors.js';
import { createSettingsClient } from '../web/settings.js';
import { createFeedbackClient } from '../web/feedback.js';
import { createConsentManager } from '../analytics/consent.js';
import { createMutationGate, createOutbox } from '../analytics/outbox.js';
import { createReporter } from '../analytics/reporter.js';
import { createBridgeOwner } from '../bridge/callback-hub.js';
import { createBridgeTransport } from '../bridge/transport.js';
import { createMonitoringController } from '../monitoring/controller.js';
import { decodeSuEnc, getSuEncCapabilities } from '../suenc/codec.js';
import { createExperimentClient } from '../experiment/client.js';
import { createNativeExperimentClient, EXPERIMENT_BRIDGE_METHODS } from '../experiment/native.js';
import { appendVidsParam, vidsHeaders, withPlatformVids, withVidsHeader } from '../experiment/request-vids.js';
import { isPlainObject } from '../core/utils.js';
import { LIMITS } from '../core/limits.js';

export const SDK_VERSION = '3.0.1-SNAPSHOT';

export function createSuperSDK(options = {}) {
  const target = options.target || globalThis;
  const storage = options.storage ?? safeProperty(target, 'localStorage');
  const indexedDBLike = options.indexedDB ?? safeProperty(target, 'indexedDB');
  const cryptoLike = options.crypto ?? safeProperty(target, 'crypto');
  const targetFetch = safeProperty(target, 'fetch');
  const fetchImpl = options.fetch ?? (typeof targetFetch === 'function' ? targetFetch.bind(target) : undefined);
  // WS-12-S6: every SDK request to the platform carries the CURRENT exposed vid set as
  // X-Super-AB-Vids (omitted when empty). It never treats server experiments as read — only the
  // explicit experiment.getRequestHeaders / appendVidsToUrl / fetch calls do. The platform's
  // CORS layer allows any request header (super-server CorsLayer::permissive()). Only requests
  // that are already preflighted (JSON POSTs with X-Aid: assign, analytics, monitoring, feedback)
  // use it; CORS-simple requests (settings GET) must not gain a preflight.
  const platformFetch = typeof fetchImpl === 'function'
    ? (input, init) => fetchImpl(input, withPlatformVids(init, currentExposedVids()))
    : undefined;
  const diagnostics = createDiagnostics({ sink: options.diagnosticSink });
  const bridgeOwner = createBridgeOwner(target, diagnostics, { random: options.random });
  const gate = createMutationGate();
  let config = null;
  let consent;
  let lastRuntimeWasNative = null;
  const getConfig = () => config;
  const outbox = createOutbox({
    getConfig,
    indexedDBLike,
    diagnostics,
    canPersist: () => consent?.get() === 'granted'
  });
  consent = createConsentManager({
    storage,
    outbox,
    gate,
    diagnostics,
    cryptoLike,
    random: options.random
  });
  // Settings is a CORS-simple GET (Accept only): a custom header would force a preflight on
  // every fetch, and the platform does not use the vids there. It stays without the header.
  const settings = createSettingsClient({
    getConfig,
    fetchImpl,
    diagnostics,
    cryptoLike,
    now: options.now
  });
  const feedback = createFeedbackClient({
    getConfig,
    fetchImpl: platformFetch,
    consent,
    diagnostics,
    sdkVersion: SDK_VERSION
  });
  const reporter = createReporter({
    target,
    getConfig,
    fetchImpl: platformFetch,
    diagnostics,
    outbox,
    consent,
    gate,
    cryptoLike,
    storage,
    random: options.random,
    now: options.now
  });
  const legacy = createLegacyRuntime(target, { bridgeOwner, diagnostics });
  const bridge = createBridgeTransport({
    target,
    owner: bridgeOwner,
    diagnostics,
    now: options.bridgeClock || options.now,
    setTimer: options.bridgeSetTimeout,
    clearTimer: options.bridgeClearTimeout,
    disposeLegacy: legacy.__disposeLegacyBridge
  });
  const monitoring = createMonitoringController({
    target, diagnostics, getConfig, fetchImpl: platformFetch, reporterBusy: reporter.monitoringBusy,
    cryptoLike, random: options.random, now: options.now, sdkVersion: SDK_VERSION,
    setTimer: options.monitoringSetTimeout, clearTimer: options.monitoringClearTimeout
  });
  const legacyInitFallback = legacy.initFallback.bind(legacy);
  const legacyGetEnv = legacy.getEnv.bind(legacy);
  const legacyGetHostSettings = legacy.getHostSettings.bind(legacy);
  const legacyGetHostSettingsByKey = legacy.getHostSettingsByKey.bind(legacy);
  const legacyReportEvent = legacy.reportEvent.bind(legacy);
  const legacySubmitFeedback = legacy.submitFeedback.bind(legacy);
  const legacyAddEventCommonParam = legacy.addEventCommonParam.bind(legacy);

  // WS-12 experiments. Web: assign over fetch (S1). In-app on a container that declares the
  // experiment JSB methods (S2): delegated to native (see experimentDelegated()). In-app on an
  // older container: the S1 web path with the subject from the native getEnv().
  let inAppSubject = null;
  const experimentSubject = {
    current() {
      if (target.appbridge) return inAppSubject || { status: 'pending' };
      if (!config) return { status: 'none', reason: 'not_configured' };
      if (consent.get() !== 'granted') return { status: 'none', reason: 'no_subject' };
      const deviceId = consent.getDeviceId() || config.deviceId || readStoredDeviceId();
      if (!deviceId) return { status: 'pending' };
      return {
        status: 'ready',
        spid: config.spid,
        environment: config.environment,
        deviceId,
        platform: 'web',
        language: browserLanguage()
      };
    },
    async resolve() {
      if (target.appbridge) {
        const env = await legacyGetEnv();
        const spid = typeof env?.spid === 'string' && env.spid ? env.spid : config?.spid;
        const environment = typeof env?.environment === 'string' && env.environment ? env.environment : (config?.environment || 'prod');
        const deviceId = typeof env?.deviceId === 'string' ? env.deviceId : '';
        inAppSubject = spid && deviceId
          ? {
              status: 'ready', spid, environment, deviceId,
              platform: typeof env?.os === 'string' && env.os ? env.os.toLowerCase() : 'web',
              appVersion: typeof env?.appVersion === 'string' ? env.appVersion : '',
              language: browserLanguage()
            }
          : { status: 'none', reason: 'no_subject' };
        return inAppSubject;
      }
      await consent.ready().catch(() => undefined);
      return experimentSubject.current();
    }
  };
  const experimentClient = createExperimentClient({
    target,
    storage,
    fetchImpl: platformFetch,
    diagnostics,
    subject: experimentSubject,
    getTransport: () => ({
      baseUrls: config ? config.baseUrls : ['https://api.supersdk.com/superapi'],
      timeoutMs: config ? config.settings.timeoutMs : LIMITS.settings.timeoutMs
    }),
    report: (name, params) => emitEvent(name, params, { source: 'web' }),
    now: options.now,
    setTimer: options.experimentSetTimeout,
    clearTimer: options.experimentClearTimeout,
    isSuspended: () => experimentDelegated()
  });
  const nativeExperiment = createNativeExperimentClient({
    bridge,
    diagnostics,
    setTimer: options.experimentSetTimeout,
    clearTimer: options.experimentClearTimeout
  });
  let experimentDelegationLatched = false;

  /**
   * True when the container declares all five experiment JSB methods (negotiated manifest, or
   * the functions on a legacy appbridge). Latched once true so a page never mixes paths.
   */
  function experimentDelegated() {
    if (experimentDelegationLatched) return true;
    if (!target.appbridge) return false;
    let supported = false;
    try { supported = EXPERIMENT_BRIDGE_METHODS.every((id) => bridge.supports(id)); } catch (_) { supported = false; }
    if (supported) experimentDelegationLatched = true;
    return supported;
  }

  const experimentApi = Object.freeze({
    ready: (options) => (experimentDelegated() ? nativeExperiment.api : experimentClient.api).ready(options),
    get: (key, options) => (experimentDelegated() ? nativeExperiment.api : experimentClient.api).get(key, options),
    expose: (key) => (experimentDelegated() ? nativeExperiment.api : experimentClient.api).expose(key),
    getAll: () => (experimentDelegated() ? nativeExperiment.api : experimentClient.api).getAll(),
    refresh: () => (experimentDelegated() ? nativeExperiment.api : experimentClient.api).refresh(),
    setAttributes: (map) => (experimentDelegated() ? nativeExperiment.api : experimentClient.api).setAttributes(map),
    getRequestHeaders: () => vidsHeaders(requestVids()),
    appendVidsToUrl,
    fetch: experimentFetch
  });

  /** Explicit request-vids use (WS-12-S6 §1): server-type experiments become read and exposed. */
  function requestVids() {
    return experimentDelegated() ? nativeExperiment.requestVids() : experimentClient.requestVids();
  }

  /** Platform requests: the exposed set as it is now, without the server-experiment side effect. */
  function currentExposedVids() {
    try {
      return experimentDelegated() ? nativeExperiment.currentVids() : experimentClient.vidsParam();
    } catch (_) {
      return '';
    }
  }

  function appendVidsToUrl(url) {
    let text = url;
    if (typeof URL === 'function' && url instanceof URL) text = url.href;
    if (typeof text !== 'string') throw sdkError('INVALID_ARGUMENT');
    return appendVidsParam(text, requestVids());
  }

  /** Thin `fetch` wrapper: same arguments, SDK header wins over a caller header of the same name. */
  function experimentFetch(input, init) {
    let vids;
    try { vids = requestVids(); } catch (error) { return Promise.reject(error); }
    const fetchFn = options.fetch ?? safeProperty(target, 'fetch');
    if (typeof fetchFn !== 'function') return Promise.reject(sdkError('UNSUPPORTED', { message: 'fetch is not available' }));
    const call = (...args) => (options.fetch ? fetchFn(...args) : fetchFn.call(target, ...args));
    if (!vids) return call(input, init);
    if (init !== undefined && init !== null && typeof init !== 'object') return call(input, init);
    const RequestImpl = safeProperty(target, 'Request') || globalThis.Request;
    const fromRequest = typeof RequestImpl === 'function' && input instanceof RequestImpl;
    const base = init && init.headers !== undefined ? init.headers : (fromRequest ? input.headers : undefined);
    const HeadersImpl = safeProperty(target, 'Headers') || globalThis.Headers;
    let headers;
    try { headers = withVidsHeader(base, vids, HeadersImpl); } catch (error) { return Promise.reject(error); }
    return call(input, { ...(init || {}), headers });
  }

  function readStoredDeviceId() {
    try { return storage?.getItem('supersdk_device_id') || ''; } catch (_) { return ''; }
  }

  function browserLanguage() {
    const language = safeProperty(target, 'navigator')?.language;
    return typeof language === 'string' ? language.slice(0, 35) : '';
  }

  function init(input) {
    const runtimeIsNative = Boolean(target.appbridge);
    const previous = lastRuntimeWasNative === null || lastRuntimeWasNative === runtimeIsNative ? config : null;
    const candidate = normalizeConfig(input, previous);
    config = candidate;
    lastRuntimeWasNative = runtimeIsNative;
    experimentClient.sync();
    consent.configure(candidate.analyticsConsent, candidate.deviceId).catch(() => undefined);
    legacyInitFallback(candidate);
    if (target.appbridge) legacy.__installLegacyBridge();
    else reporter.ensureActiveFlush();
    experimentClient.onSubjectMaybeChanged({ autoFetch: !target.appbridge });
  }

  function setAnalyticsConsent(next) {
    // Capture the current subject before a revocation wipes the device id, so its
    // experiment results and exposed set can be cleared with it.
    experimentClient.sync();
    const result = consent.set(next);
    experimentClient.onSubjectMaybeChanged({ autoFetch: !target.appbridge });
    return result;
  }

  function getEnv() {
    if (target.appbridge) return legacyGetEnv();
    if (!config) {
      return Promise.resolve({
        os: 'web', appVersion: '', sdkVersion: SDK_VERSION,
        statusBarHeight: 0, navigationBarHeight: 0, deviceId: ''
      });
    }
    return Promise.resolve({
      spid: config.spid,
      environment: config.environment,
      appName: config.appName,
      deviceId: consent.getDeviceId(),
      os: 'web',
      appVersion: '',
      sdkVersion: '',
      statusBarHeight: 0,
      navigationBarHeight: 0
    });
  }

  /**
   * 设置项目环境（web 降级模式生效；端内环境由原生宿主经 SuperSDK.setAPIEnvironment 控制）。
   * 换值后 settings 拉取与上报即用新值；settings 请求缓存 key 含环境维度，天然隔离无需清理。
   */
  async function setAPIEnvironment(environment) {
    if (target.appbridge) {
      throw sdkError('UNSUPPORTED', { message: 'in-app environment is controlled by the native host' });
    }
    validateEnvironment(environment);
    if (!config) throw sdkError('NOT_INITIALIZED');
    if (config.environment === environment) return;
    // 旧环境存量事件尽力冲走，再换值
    await reporter.flush().catch(() => undefined);
    const candidate = normalizeConfig({ environment }, config);
    config = candidate;
    legacyInitFallback(candidate);
    experimentClient.onSubjectMaybeChanged({ autoFetch: !target.appbridge });
  }

  /** 获取当前项目环境；端内透传原生值，web 未初始化时返回 "prod"。 */
  function getAPIEnvironment() {
    if (target.appbridge) {
      return legacyGetEnv().then((env) => {
        const value = env && typeof env.environment === 'string' ? env.environment : '';
        return value || 'prod';
      });
    }
    return Promise.resolve(config ? config.environment : 'prod');
  }

  function getHostSettings(configName, params) {
    return target.appbridge ? legacyGetHostSettings(configName) : settings.getHostSettings(configName, params);
  }

  function getHostSettingsByKey(key, configName, params) {
    return target.appbridge ? legacyGetHostSettingsByKey(key, configName) : settings.getHostSettingsByKey(key, configName, params);
  }

  function reportEvent(name, params) {
    return emitEvent(name, params, null);
  }

  /**
   * Every analytics event carries `exp_vids` = the exposed experiment vids at the moment the
   * event is created (snapshotted synchronously here, never at upload time). The key is
   * SDK-owned: caller-supplied `exp_vids` is dropped. When experiments are delegated to native,
   * every in-app event goes through the native reportEvent bridge and native stamps `exp_vids`
   * at event creation, so nothing is attached here.
   */
  function emitEvent(name, params, sdkExtra) {
    const vids = target.appbridge && experimentDelegated() ? '' : experimentClient.vidsParam();
    if (target.appbridge) {
      if (!vids && !sdkExtra && !(isPlainObject(params) && Object.prototype.hasOwnProperty.call(params, 'exp_vids'))) {
        return legacyReportEvent(name, params);
      }
      const merged = isPlainObject(params) ? { ...params } : {};
      delete merged.exp_vids;
      if (sdkExtra) Object.assign(merged, sdkExtra);
      if (vids) merged.exp_vids = vids;
      return legacyReportEvent(name, merged);
    }
    const sdkParams = { ...(sdkExtra || {}) };
    if (vids) sdkParams.exp_vids = vids;
    return reporter.reportEvent(name, params, { sdkParams });
  }

  /** 用户反馈：端内走 JSB（Native 填身份/设备字段），web 直连 /v2/feedback（CA-F260916-user-feedback）。 */
  function submitFeedback(params) {
    return target.appbridge ? legacySubmitFeedback(params) : feedback.submitFeedback(params);
  }

  function addEventCommonParam(key, value) {
    if (key === 'exp_vids') {
      diagnostics.emit('warn', { category: 'analytics_common_param', code: 'RESERVED_KEY' });
      return;
    }
    if (target.appbridge) return legacyAddEventCommonParam(key, value);
    return reporter.addEventCommonParam(key, value);
  }

  function addEventCommonParams(values) {
    if (target.appbridge) {
      if (!values || Object.prototype.toString.call(values) !== '[object Object]') throw new SuperSDKError('INVALID_ARGUMENT');
      for (const [key, value] of Object.entries(values)) addEventCommonParam(key, value);
      return;
    }
    return reporter.addEventCommonParams(values);
  }

  const sdk = Object.assign(legacy, {
    init,
    initFallback: init,
    getEnv,
    setAPIEnvironment,
    getAPIEnvironment,
    getHostSettings,
    getHostSettingsByKey,
    clearSettingsCache: settings.clear,
    setAnalyticsConsent,
    getAnalyticsConsent: consent.get,
    reportEvent,
    submitFeedback,
    flush: (options) => target.appbridge
      ? Promise.resolve({ attempted: 0, sent: 0, discarded: 0, retrying: 0, pending: 0, reason: 'native_transport' })
      : reporter.flush(options),
    getDeliveryState: reporter.getDeliveryState,
    addEventCommonParam,
    addEventCommonParams,
    onDiagnostic: diagnostics.subscribe,
    monitoring,
    experiment: experimentApi,
    bridge,
    // suenc 是本地纯函数能力（不经 JSBridge），端内端外一致同步返回
    getSuEncCapabilities,
    decodeSuEnc,
    sdkVersion: SDK_VERSION
  });

  Object.defineProperty(sdk, '__target', { enumerable: false, value: target });
  Object.defineProperty(sdk, '__diagnostics', { enumerable: false, value: diagnostics });
  Object.defineProperty(sdk, '__outbox', { enumerable: false, value: outbox });

  sdk.installGlobal = () => installInstanceGlobal(sdk, target);
  return sdk;
}

function safeProperty(target, key) {
  try { return target?.[key]; } catch (_) { return undefined; }
}

export function installInstanceGlobal(sdk, target) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) throw new SuperSDKError('INVALID_ARGUMENT');
  if (target.SuperSDK && target.SuperSDK !== sdk) {
    if (target.SuperSDK.sdkVersion !== SDK_VERSION) throw new Error('SuperSDK global version conflict');
    return target.SuperSDK;
  }
  target.SuperSDK = sdk;
  sdk.__installLegacyBridge();
  return sdk;
}
