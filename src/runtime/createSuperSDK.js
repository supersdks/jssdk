import { createLegacyRuntime } from './legacy-runtime.js';
import { normalizeConfig } from '../core/config.js';
import { createDiagnostics } from '../core/diagnostics.js';
import { SuperSDKError } from '../core/errors.js';
import { createSettingsClient } from '../web/settings.js';
import { createConsentManager } from '../analytics/consent.js';
import { createMutationGate, createOutbox } from '../analytics/outbox.js';
import { createReporter } from '../analytics/reporter.js';

export const SDK_VERSION = '1.0.0';

export function createSuperSDK(options = {}) {
  const target = options.target || globalThis;
  const storage = options.storage ?? safeProperty(target, 'localStorage');
  const indexedDBLike = options.indexedDB ?? safeProperty(target, 'indexedDB');
  const cryptoLike = options.crypto ?? safeProperty(target, 'crypto');
  const targetFetch = safeProperty(target, 'fetch');
  const fetchImpl = options.fetch ?? (typeof targetFetch === 'function' ? targetFetch.bind(target) : undefined);
  const diagnostics = createDiagnostics();
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
  const settings = createSettingsClient({
    getConfig,
    fetchImpl,
    diagnostics,
    cryptoLike,
    now: options.now
  });
  const reporter = createReporter({
    target,
    getConfig,
    fetchImpl,
    diagnostics,
    outbox,
    consent,
    gate,
    cryptoLike,
    storage,
    random: options.random,
    now: options.now
  });
  const legacy = createLegacyRuntime(target);
  const legacyInitFallback = legacy.initFallback.bind(legacy);
  const legacyGetEnv = legacy.getEnv.bind(legacy);
  const legacyGetHostSettings = legacy.getHostSettings.bind(legacy);
  const legacyGetHostSettingsByKey = legacy.getHostSettingsByKey.bind(legacy);
  const legacyReportEvent = legacy.reportEvent.bind(legacy);
  const legacyAddEventCommonParam = legacy.addEventCommonParam.bind(legacy);

  function init(input) {
    const runtimeIsNative = Boolean(target.appbridge);
    const previous = lastRuntimeWasNative === null || lastRuntimeWasNative === runtimeIsNative ? config : null;
    const candidate = normalizeConfig(input, previous);
    config = candidate;
    lastRuntimeWasNative = runtimeIsNative;
    consent.configure(candidate.analyticsConsent, candidate.deviceId).catch(() => undefined);
    legacyInitFallback(candidate);
    if (target.appbridge) legacy.__installLegacyBridge();
    else reporter.ensureActiveFlush();
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

  function getHostSettings(configName, params) {
    return target.appbridge ? legacyGetHostSettings(configName) : settings.getHostSettings(configName, params);
  }

  function getHostSettingsByKey(key, configName, params) {
    return target.appbridge ? legacyGetHostSettingsByKey(key, configName) : settings.getHostSettingsByKey(key, configName, params);
  }

  function reportEvent(name, params) {
    return target.appbridge ? legacyReportEvent(name, params) : reporter.reportEvent(name, params);
  }

  function addEventCommonParam(key, value) {
    if (target.appbridge) return legacyAddEventCommonParam(key, value);
    return reporter.addEventCommonParam(key, value);
  }

  function addEventCommonParams(values) {
    if (target.appbridge) {
      if (!values || Object.prototype.toString.call(values) !== '[object Object]') throw new SuperSDKError('INVALID_ARGUMENT');
      for (const [key, value] of Object.entries(values)) legacyAddEventCommonParam(key, value);
      return;
    }
    return reporter.addEventCommonParams(values);
  }

  const sdk = Object.assign(legacy, {
    init,
    initFallback: init,
    getEnv,
    getHostSettings,
    getHostSettingsByKey,
    clearSettingsCache: settings.clear,
    setAnalyticsConsent: consent.set,
    getAnalyticsConsent: consent.get,
    reportEvent,
    flush: (options) => target.appbridge
      ? Promise.resolve({ attempted: 0, sent: 0, discarded: 0, retrying: 0, pending: 0, reason: 'native_transport' })
      : reporter.flush(options),
    getDeliveryState: reporter.getDeliveryState,
    addEventCommonParam,
    addEventCommonParams,
    onDiagnostic: diagnostics.subscribe,
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
