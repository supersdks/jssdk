/**
 * Legacy JSBridge runtime, mechanically extracted from supersdk.js.
 * Keep bridge wrappers behavior-compatible; public Web behavior is composed outside.
 */
export function createLegacyRuntime(global) {
  'use strict';

  global = global || {};

  // 回调管理
  const callbackMap = {};
  const broadcastListeners = {};
  const systemListeners = {};

  // 返回键拦截回调
  let _backPressedCallback = null;

  // 降级配置（initFallback 写入）
  const DEFAULT_API_BASE_URL = 'https://api.supersdk.com/superapi';
  const LAST_SUCCESS_BASE_URL_KEY = 'supersdk_last_success_base_url';
  const SPID_PATTERN = /^[a-z0-9]{8}$/;
  const ENVIRONMENT_PATTERN = /^[a-z0-9]{1,10}$/;
  let _fallbackConfig = null;
  let _deviceId = null;

  // JS 层支付 Provider 注册表（Web 收银台等非 Native IAP · F036 起 inline 用 '_inline' key 临时挂载）
  const _payProviders = {};

  // Web inline 并发守门(SDK-F036 AC-8)· Native IAP 走 PayBridge purchaseInProgress
  let _webInlineInProgress = false;

  // SDK-F036 · 统一 INVALID_PARAMS reject helper(应对 external CR-2 · err.detail 字段保证)
  function _invalidParams(detail) {
    var err = new Error('INVALID_PARAMS');
    err.detail = detail;
    return Promise.reject(err);
  }

  // SDK-F036 · 统一 Error 构造 helper(message + detail 一体)
  function _makeError(code, detail) {
    var err = new Error(code);
    err.detail = detail || '';
    return err;
  }

  // 生成 UUID v4
  function _generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // 获取或创建 deviceId（优先 localStorage 持久化）
  function _getOrCreateDeviceId() {
    if (_deviceId) return _deviceId;

    try {
      var stored = localStorage.getItem('supersdk_device_id');
      if (stored) {
        _deviceId = stored;
        return _deviceId;
      }
    } catch (e) {
      // 无痕模式或 localStorage 不可用
    }

    _deviceId = _generateUUID();

    try {
      localStorage.setItem('supersdk_device_id', _deviceId);
    } catch (e) {
      // 退化为内存存储
    }

    return _deviceId;
  }

  function _normalizeBaseUrl(baseUrl) {
    if (typeof baseUrl !== 'string') return '';
    return baseUrl.trim().replace(/\/+$/, '');
  }

  function _normalizeLegacyBaseUrl(baseUrl) {
    var normalized = _normalizeBaseUrl(baseUrl);
    if (normalized && !/\/superapi$/.test(normalized)) {
      return normalized + '/superapi';
    }
    return normalized;
  }

  function _dedupe(values) {
    var seen = {};
    var result = [];
    values.forEach(function(value) {
      if (!seen[value]) {
        seen[value] = true;
        result.push(value);
      }
    });
    return result;
  }

  function _collectFallbackBaseUrls(fc) {
    if (!fc) return [DEFAULT_API_BASE_URL];

    var source;
    var legacyBaseUrl = false;
    if (Object.prototype.hasOwnProperty.call(fc, 'baseUrls')) {
      source = fc.baseUrls;
    } else if (Object.prototype.hasOwnProperty.call(fc, 'baseApi')) {
      source = fc.baseApi;
    } else if (Object.prototype.hasOwnProperty.call(fc, 'baseAPI')) {
      source = fc.baseAPI;
    } else if (Object.prototype.hasOwnProperty.call(fc, 'baseUrl')) {
      source = fc.baseUrl;
      legacyBaseUrl = true;
    } else {
      source = DEFAULT_API_BASE_URL;
    }

    var rawUrls = Array.isArray(source) ? source : [source];
    var normalizer = legacyBaseUrl ? _normalizeLegacyBaseUrl : _normalizeBaseUrl;
    return _dedupe(rawUrls.map(normalizer).filter(function(url) { return !!url; }));
  }

  function _readLastSuccessfulBaseUrl() {
    try {
      return localStorage.getItem(LAST_SUCCESS_BASE_URL_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function _recordSuccessfulBaseUrl(baseUrl) {
    var normalized = _normalizeBaseUrl(baseUrl);
    if (!normalized) return;
    try {
      localStorage.setItem(LAST_SUCCESS_BASE_URL_KEY, normalized);
    } catch (e) {
      // localStorage 不可用时仅退化为本次随机/fallback。
    }
  }

  function _shuffle(values) {
    var result = values.slice();
    for (var i = result.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = result[i];
      result[i] = result[j];
      result[j] = tmp;
    }
    return result;
  }

  function _getOrderedFallbackBaseUrls(fc) {
    var candidates = _collectFallbackBaseUrls(fc);
    var last = _normalizeBaseUrl(_readLastSuccessfulBaseUrl());
    var index = candidates.indexOf(last);
    if (index >= 0) {
      candidates.splice(index, 1);
      return [last].concat(_shuffle(candidates));
    }
    return _shuffle(candidates);
  }

  function _buildApiUrl(baseUrl, path) {
    var normalizedBaseUrl = _normalizeBaseUrl(baseUrl);
    var normalizedPath = path.charAt(0) === '/' ? path : '/' + path;
    if (/\/superapi$/.test(normalizedBaseUrl) && normalizedPath.indexOf('/superapi') === 0) {
      normalizedPath = normalizedPath.substring('/superapi'.length);
    }
    return normalizedBaseUrl + normalizedPath;
  }

  function _isPlainObject(value) {
    return Object.prototype.toString.call(value) === '[object Object]';
  }

  function _throwFallbackConfigError(ErrorType, field, rule) {
    console.error('[SuperSDK] initFallback invalid ' + field + ': ' + rule);
    throw new ErrorType('initFallback ' + field + ' ' + rule);
  }

  function _buildValidatedFallbackConfig(config) {
    if (!_isPlainObject(config)) {
      _throwFallbackConfigError(TypeError, 'config', 'must be a plain object');
    }
    if (Object.prototype.hasOwnProperty.call(config, 'aid')) {
      _throwFallbackConfigError(TypeError, 'aid', 'is unsupported; use spid');
    }
    if (!Object.prototype.hasOwnProperty.call(config, 'spid')) {
      _throwFallbackConfigError(TypeError, 'spid', 'is required');
    }

    var candidate = Object.assign({
      baseUrl: DEFAULT_API_BASE_URL,
      spid: '',
      environment: 'prod',
      appName: '',
      appIcon: '',
      deviceId: ''
    }, _fallbackConfig || {}, config);

    if (typeof candidate.spid !== 'string' || !SPID_PATTERN.test(candidate.spid)) {
      _throwFallbackConfigError(RangeError, 'spid', 'must match ^[a-z0-9]{8}$');
    }
    if (typeof candidate.environment !== 'string' || !ENVIRONMENT_PATTERN.test(candidate.environment)) {
      _throwFallbackConfigError(RangeError, 'environment', 'must match ^[a-z0-9]{1,10}$');
    }
    return candidate;
  }

  function _sanitizedReportRoute(url) {
    try {
      var parsed = new URL(url);
      return parsed.host + parsed.pathname;
    } catch (e) {
      return 'invalid-route';
    }
  }

  function _logReportFailure(level, url, attempt, total, outcome) {
    var message = '[SuperSDK] reportEvent ' + level
      + ' request=reportEvent attempt=' + attempt + '/' + total
      + ' route=' + _sanitizedReportRoute(url)
      + ' outcome=' + outcome;
    if (level === 'WARN') {
      console.warn(message);
    } else {
      console.error(message);
    }
  }

  // 通过 fetch 直接上报事件到服务端
  function _reportEventViaFetch(eventName, params) {
    var fc = _fallbackConfig || {};
    var baseUrls = _getOrderedFallbackBaseUrls(fc);
    if (baseUrls.length === 0 || !fc.spid) {
      return Promise.reject(new Error('reportEvent requires SuperSDK.initFallback() with baseUrl/baseUrls and spid'));
    }

    var payload = {
      basic_data: {
        device_id: fc.deviceId || _getOrCreateDeviceId(),
        os_type: 'web',
        host_spid: fc.spid,
        env: fc.environment,
        source: 'web_fallback'
      },
      events: [{
        event_name: eventName,
        // 自建 super-ea-collector 要求 event_param 为 JSON 对象（非字符串/数组/Date）。
        // plain-object guard：排除 Array/Date/null/字符串/数字 等 → 一律落 {}（与 Android/iOS 对齐）。
        event_param: (Object.prototype.toString.call(params) === '[object Object]') ? params : {},
        client_ts_ms: Date.now()
      }]
    };

    function send(index) {
      var baseUrl = baseUrls[index];
      var url = _buildApiUrl(baseUrl, '/v2/reportEvent');
      var attempt = index + 1;
      var total = baseUrls.length;
      return fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Aid': fc.spid,
          'X-Super-API-ENV': fc.environment
        },
        body: JSON.stringify(payload)
      }).then(function(resp) {
        if (resp.ok) {
          _recordSuccessfulBaseUrl(baseUrl);
          return;
        }
        if (index + 1 < baseUrls.length) {
          _logReportFailure('WARN', url, attempt, total, 'http_' + resp.status);
          return send(index + 1);
        }
        _logReportFailure('ERROR', url, attempt, total, 'http_' + resp.status);
      }, function() {
        if (index + 1 < baseUrls.length) {
          _logReportFailure('WARN', url, attempt, total, 'network_error');
          return send(index + 1);
        }
        _logReportFailure('ERROR', url, attempt, total, 'network_error');
      });
    }

    return send(0);
  }

  // 生成唯一回调 ID
  function generateCallbackId() {
    return 'cb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  // 注册回调
  function registerCallback(callbackId, callback, timeout) {
    callbackMap[callbackId] = callback;

    // 超时处理
    if (timeout > 0) {
      setTimeout(() => {
        if (callbackMap[callbackId]) {
          callbackMap[callbackId]({
            code: 'TIMEOUT',
            message: '请求超时'
          });
          delete callbackMap[callbackId];
        }
      }, timeout);
    }
  }

  // 订阅处理器 - 供原生调用。工厂创建时保持局部，显式安装时才写 global。
  const JSBridge = {
    subscribeHandler: function(eventType, eventKey, data) {
      if (eventType === 'ASYNC_CALLBACK') {
        const callback = callbackMap[eventKey];
        if (callback) {
          // 调用回调，由回调处理函数决定是否删除（如下载进度需要多次回调）
          callback(data);
          // 对于非持续性回调，在这里删除；持续性回调（如下载）由回调内部处理删除
        }
      } else if (eventType === 'BROADCAST') {
        const listeners = broadcastListeners[eventKey] || [];
        listeners.forEach(fn => {
          try {
            fn(data);
          } catch (e) {
            console.error('Broadcast listener error:', e);
          }
        });
      } else if (eventType === 'SYSTEM') {
        const listeners = systemListeners[eventKey] || [];
        listeners.forEach(fn => {
          try {
            fn(data);
          } catch (e) {
            console.error('System listener error:', e);
          }
        });
      }
    },

    /**
     * 返回键拦截处理，由 Native 调用
     * @returns {boolean} true 表示前端已处理（拦截），false 表示未处理
     */
    onBackPressed: function() {
      if (_backPressedCallback) {
        try {
          return _backPressedCallback() === true;
        } catch (e) {
          console.error('onBackPressed callback error:', e);
          return false;
        }
      }
      return false;
    }
  };

  function installBridge() {
    global.JSBridge = JSBridge;
    // 通知 Native 端 JSBridge 已就绪，可以 flush 缓冲的消息。
    if (global.appbridge && global.appbridge.onJSBridgeReady) {
      global.appbridge.onJSBridgeReady();
    }
    return JSBridge;
  }

  // SDK 对象
  const SDK = {
    /**
     * 初始化非端环境降级配置
     * 配置总是先校验；端内（有 appbridge）时合法配置随后被忽略
     * 多次调用采用 merge 语义，只更新本次传入的字段
     * @param {Object} config
     * @param {string} [config.baseUrl] - 服务端地址（兼容旧字段）
     * @param {string[]} [config.baseUrls] - 服务端地址列表，优先于 baseUrl
     * @param {string|string[]} [config.baseApi] - 服务端地址或地址列表，优先级同 baseUrls
     * @param {string} config.spid - 控制台签发的 8 位项目标识
     * @param {string} [config.environment='prod'] - 项目环境
     * @param {string} [config.appName] - 应用名称
     * @param {string} [config.appIcon] - 应用图标 Base64
     * @param {string} [config.deviceId] - 设备标识，不传则自动生成
     */
    initFallback: function(config) {
      var candidate = _buildValidatedFallbackConfig(config);
      if (global.appbridge) {
        return;
      }

      _fallbackConfig = candidate;
      if (candidate.deviceId) {
        _deviceId = candidate.deviceId;
      }
    },

    /**
     * 是否处于降级模式
     * @returns {boolean} 非端环境且已调用 initFallback 时返回 true
     */
    isFallbackMode: function() {
      return !global.appbridge && _fallbackConfig !== null;
    },

    /**
     * 获取环境信息
     * @returns {Promise<Object>}
     */
    getEnv: function() {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          if (_fallbackConfig) {
            resolve({
              spid: _fallbackConfig.spid,
              environment: _fallbackConfig.environment,
              appName: _fallbackConfig.appName,
              deviceId: _fallbackConfig.deviceId || _getOrCreateDeviceId(),
              os: 'web',
              appVersion: '',
              sdkVersion: '',
              statusBarHeight: 0,
              navigationBarHeight: 0
            });
          } else {
            resolve({
              os: 'web',
              appVersion: '',
              sdkVersion: '',
              statusBarHeight: 0,
              navigationBarHeight: 0
            });
          }
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data);
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 5000);
        global.appbridge.getEnvAsync(callbackId);
      });
    },

    /**
     * 获取宿主 App 名称
     * @returns {Promise<string>}
     */
    getAppName: function() {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          resolve(_fallbackConfig ? _fallbackConfig.appName : '');
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data.appName);
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 5000);
        global.appbridge.getAppNameAsync(callbackId);
      });
    },

    /**
     * 获取宿主 App 图标（Base64 格式）
     * @returns {Promise<string>} data:image/png;base64,... 格式
     */
    getAppIcon: function() {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          resolve(_fallbackConfig ? _fallbackConfig.appIcon : '');
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data.base64);
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 5000);
        global.appbridge.getAppIconBase64Async(callbackId);
      });
    },

    /**
     * 获取宿主配置
     * @param {string} [configName] - 配置名称，不传则请求不带 configName
     * @returns {Promise<Object>}
     */
    getHostSettings: function(configName) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          resolve({});
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data);
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 5000);
        var normalizedConfigName = (typeof configName === 'string' && configName.trim()) ? configName.trim() : '';
        if (normalizedConfigName && typeof global.appbridge.getHostSettingsByConfigNameAsync === 'function') {
          global.appbridge.getHostSettingsByConfigNameAsync(normalizedConfigName, callbackId);
        } else {
          global.appbridge.getHostSettingsAsync(callbackId);
        }
      });
    },

    /**
     * 根据 key 获取宿主配置
     * @param {string} key
     * @param {string} [configName] - 配置名称，不传则请求不带 configName
     * @returns {Promise<Object>}
     */
    getHostSettingsByKey: function(key, configName) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          resolve(null);
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data);
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 5000);
        var normalizedConfigName = (typeof configName === 'string' && configName.trim()) ? configName.trim() : '';
        if (normalizedConfigName && typeof global.appbridge.getHostSettingsByConfigNameAndKeyAsync === 'function') {
          global.appbridge.getHostSettingsByConfigNameAndKeyAsync(normalizedConfigName, key, callbackId);
        } else {
          global.appbridge.getHostSettingsByKeyAsync(key, callbackId);
        }
      });
    },

    /**
     * 分享内容
     * @param {string} content
     */
    share: function(content) {
      if (!global.appbridge) {
        console.log('[SuperSDK Share]:', content);
        return;
      }
      global.appbridge.share(content);
    },

    /**
     * 生成短链
     * @param {string} url - 原始长链接
     * @param {string} [baseUrl] - 自定义短链前缀，如 "https://s.a.com/"，不传使用默认值
     * @returns {Promise<string>} 短链字符串，如 "https://s.supersdk.com/AbCd12"
     */
    requestShortUrl: function(url, baseUrl) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        if (!url) {
          reject(new Error('URL is required'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data.shortUrl);
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 10000);
        var params = { url: url, callbackId: callbackId };
        if (baseUrl) { params.baseUrl = baseUrl; }
        global.appbridge.requestShortUrl(JSON.stringify(params));
      });
    },

    /**
     * 通过 HTML 内容生成短链
     * 访问生成的短链时直接渲染 HTML 内容，不做 302 跳转
     * @param {string} html - HTML 内容
     * @param {string} [baseUrl] - 自定义短链前缀，如 "https://s.a.com/"，不传使用默认值
     * @returns {Promise<string>} 短链字符串，如 "https://s.supersdk.com/AbCd12"
     */
    requestShortUrlWithHtml: function(html, baseUrl) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        if (!html) {
          reject(new Error('HTML content is required'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data.shortUrl);
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 10000);
        var params = { html: html, callbackId: callbackId };
        if (baseUrl) { params.baseUrl = baseUrl; }
        global.appbridge.requestShortUrlWithHtml(JSON.stringify(params));
      });
    },

    /**
     * 在新页面打开 URL
     * @param {string} url
     * @param {Object} options
     * @param {boolean} [options.showTitleBar=true]
     */
    openPage: function(url, options) {
      if (!global.appbridge) {
        global.open(url, '_blank');
        return;
      }
      const config = JSON.stringify(options || { showTitleBar: true });
      global.appbridge.openPage(url, config);
    },

    /**
     * 使用系统方式打开 URL
     * @param {string} url
     */
    openExternal: function(url) {
      if (!global.appbridge) {
        global.open(url, '_blank');
        return;
      }
      global.appbridge.openExternal(url);
    },

    /**
     * 使用浏览器打开 URL
     * @param {string} url
     */
    openWithBrowser: function(url) {
      if (!global.appbridge) {
        global.open(url, '_blank');
        return;
      }
      global.appbridge.openWithBrowser(url);
    },


    /**
     * 关闭当前页面
     * 由上层容器实现，TAB 页面调用无效果
     */
    closePage: function() {
      if (!global.appbridge) {
        try { global.close(); } catch(e) {}
        if (!global.closed) { history.back(); }
        return;
      }
      global.appbridge.closePage();
    },

    /**
     * 广播消息到其他 WebView
     * @param {string} eventKey - 事件标识
     * @param {Object} data - 消息数据
     * @param {string} [targetWebviewId='*'] - 目标 WebView ID，'*' 表示广播到所有
     */
    publish: function(eventKey, data, targetWebviewId) {
      if (!global.appbridge) {
        console.warn('appbridge not available');
        return;
      }
      const target = targetWebviewId || '*';
      const content = JSON.stringify(data || {});
      global.appbridge.publishToWebView(target, eventKey, content);
    },

    /**
     * 监听广播消息
     * @param {string} eventKey - 事件标识
     * @param {Function} callback - 回调函数
     * @returns {Function} 取消监听的函数
     */
    subscribe: function(eventKey, callback) {
      if (!broadcastListeners[eventKey]) {
        broadcastListeners[eventKey] = [];
      }
      broadcastListeners[eventKey].push(callback);

      // 返回取消监听函数
      return function unsubscribe() {
        const index = broadcastListeners[eventKey].indexOf(callback);
        if (index > -1) {
          broadcastListeners[eventKey].splice(index, 1);
        }
      };
    },

    /**
     * 检查是否在 App 环境中
     * @returns {boolean}
     */
    isInApp: function() {
      return !!global.appbridge;
    },

    /**
     * 获取安全区域信息（从 UserAgent 解析）
     * @returns {{top: number, bottom: number}} 安全区域高度（像素）
     */
    getSafeArea: function() {
      var ua = navigator.userAgent;
      var top = 0;
      var bottom = 0;

      var topMatch = ua.match(/SafeAreaTop\/(\d+)/);
      if (topMatch) {
        top = parseInt(topMatch[1], 10);
      }

      var bottomMatch = ua.match(/SafeAreaBottom\/(\d+)/);
      if (bottomMatch) {
        bottom = parseInt(bottomMatch[1], 10);
      }

      return { top: top, bottom: bottom };
    },

    /**
     * 监听页面进入前台事件
     * @param {Function} callback - 回调函数，参数为 { triggerFrom: 'window'|'view'|'activity' }
     * @returns {Function} 取消监听的函数
     */
    onForeground: function(callback) {
      if (!systemListeners['onEnterForeground']) {
        systemListeners['onEnterForeground'] = [];
      }
      systemListeners['onEnterForeground'].push(callback);

      return function unsubscribe() {
        const index = systemListeners['onEnterForeground'].indexOf(callback);
        if (index > -1) {
          systemListeners['onEnterForeground'].splice(index, 1);
        }
      };
    },

    /**
     * 监听页面进入后台事件
     * @param {Function} callback - 回调函数，参数为 { triggerFrom: 'window'|'view'|'activity' }
     * @returns {Function} 取消监听的函数
     */
    onBackground: function(callback) {
      if (!systemListeners['onEnterBackground']) {
        systemListeners['onEnterBackground'] = [];
      }
      systemListeners['onEnterBackground'].push(callback);

      return function unsubscribe() {
        const index = systemListeners['onEnterBackground'].indexOf(callback);
        if (index > -1) {
          systemListeners['onEnterBackground'].splice(index, 1);
        }
      };
    },

    /**
     * 监听返回键事件
     * 同一时间只有一个监听器生效，后注册的覆盖前面的
     * @param {Function} callback - 返回 true 拦截返回，返回 false 或无返回值不拦截
     */
    onBackPressed: function(callback) {
      _backPressedCallback = (callback && typeof callback === 'function') ? callback : null;
    },

    /**
     * 取消返回键监听，恢复默认返回行为
     */
    offBackPressed: function() {
      _backPressedCallback = null;
    },

    /**
     * 下载文件
     * @param {Object} options - 下载配置
     * @param {string} options.url - 文件下载地址
     * @param {string} options.savePath - 保存路径（相对于 SDK 文件存储目录）
     * @param {Object} [options.headers] - 请求头
     * @param {Function} [options.onStart] - 开始下载回调
     * @param {Function} [options.onProgress] - 进度回调，参数为 { progress, downloadedBytes, totalBytes }
     * @param {Function} [options.onSuccess] - 成功回调，参数为 { filePath, downloadedBytes, totalBytes }
     * @param {Function} [options.onFail] - 失败回调，参数为 { error }
     * @returns {Function} 取消下载的函数
     */
    downloadFile: function(options) {
      if (!global.appbridge) {
        if (options.onFail) {
          options.onFail({ error: 'Not in app environment. This API requires native app support.' });
        }
        return function() {};
      }

      const callbackId = generateCallbackId();
      const headersStr = options.headers ? JSON.stringify(options.headers) : '';

      // 注册回调处理
      registerCallback(callbackId, (result) => {
        if (result.code === 'SUCCESS' && result.data) {
          const data = result.data;
          switch (data.status) {
            case 'START':
              if (options.onStart) options.onStart();
              break;
            case 'PROGRESS':
              if (options.onProgress) {
                options.onProgress({
                  progress: data.progress,
                  downloadedBytes: data.downloadedBytes,
                  totalBytes: data.totalBytes
                });
              }
              break;
            case 'SUCCESS':
              if (options.onSuccess) {
                options.onSuccess({
                  filePath: data.filePath,
                  downloadedBytes: data.downloadedBytes,
                  totalBytes: data.totalBytes
                });
              }
              delete callbackMap[callbackId];
              break;
            case 'FAIL':
              if (options.onFail) {
                options.onFail({ error: data.error });
              }
              delete callbackMap[callbackId];
              break;
          }
        }
      }, 0); // 不设置超时，下载可能持续较长时间

      global.appbridge.downloadFile(callbackId, options.url, headersStr, options.savePath);

      // 返回取消函数
      return function cancel() {
        global.appbridge.cancelDownload(callbackId);
      };
    },

    /**
     * 下载文件并按缓存策略复用本地文件
     * @param {string} fileUrl - 文件下载地址
     * @param {string} [fileMd5] - 文件 MD5，传空时跳过校验
     * @param {number} [cacheTts] - 缓存有效期（秒），<= 0 时强制重新下载
     * @param {string} [fileCacheKey] - 自定义缓存 key，传空时使用去掉 query 的 fileUrl
     * @returns {Promise<{filePath: string, cacheHit: boolean, cacheKey: string}>}
     */
    downloadWithCache: function(fileUrl, fileMd5, cacheTts, fileCacheKey) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }

        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data);
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 0);

        global.appbridge.downloadWithCache(
          callbackId,
          fileUrl,
          fileMd5 || '',
          cacheTts || 0,
          fileCacheKey || ''
        );
      });
    },

    // ==================== 文件操作 ====================

    /**
     * 检查文件是否存在
     * @param {string} path - 相对路径
     * @returns {Promise<{exists: boolean, isFile: boolean, isDirectory: boolean}>}
     */
    fileExists: function(path) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data);
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 5000);
        global.appbridge.fileExists(path, callbackId);
      });
    },

    /**
     * 获取文件 MD5
     * @param {string} path - 相对路径
     * @returns {Promise<{md5: string}>}
     */
    getFileMd5: function(path) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data);
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 30000); // 大文件可能需要更长时间
        global.appbridge.getFileMd5(path, callbackId);
      });
    },

    /**
     * 删除文件或目录
     * @param {string} path - 相对路径
     * @returns {Promise<void>}
     */
    deleteFile: function(path) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve();
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 10000);
        global.appbridge.deleteFile(path, callbackId);
      });
    },

    /**
     * 移动文件
     * @param {string} srcPath - 源路径
     * @param {string} destPath - 目标路径
     * @returns {Promise<void>}
     */
    moveFile: function(srcPath, destPath) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve();
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 10000);
        global.appbridge.moveFile(srcPath, destPath, callbackId);
      });
    },

    /**
     * 创建目录
     * @param {string} path - 相对路径
     * @returns {Promise<void>}
     */
    createDir: function(path) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve();
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 5000);
        global.appbridge.createDir(path, callbackId);
      });
    },

    /**
     * 列出目录内容
     * @param {string} path - 相对路径
     * @returns {Promise<{files: Array<{name: string, isFile: boolean, isDirectory: boolean, size: number, lastModified: number}>}>}
     */
    listDir: function(path) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data);
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 10000);
        global.appbridge.listDir(path, callbackId);
      });
    },

    /**
     * 读取文件内容（文本）
     * @param {string} path - 相对路径
     * @returns {Promise<{content: string}>}
     */
    readFile: function(path) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data);
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 30000);
        global.appbridge.readFile(path, callbackId);
      });
    },

    /**
     * 写入文件内容（文本）
     * @param {string} path - 相对路径
     * @param {string} content - 文件内容
     * @returns {Promise<void>}
     */
    writeFile: function(path, content) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve();
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 30000);
        global.appbridge.writeFile(path, content, callbackId);
      });
    },

    // ==================== ZIP 压缩与解压 ====================

    /**
     * 解压 ZIP 文件
     * @param {string} zipPath - ZIP 文件路径
     * @param {string} destPath - 解压目标目录
     * @returns {Promise<void>}
     */
    unzipFile: function(zipPath, destPath) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve();
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 60000); // 解压可能需要较长时间
        global.appbridge.unzipFile(zipPath, destPath, callbackId);
      });
    },

    /**
     * 压缩目录为 ZIP 文件
     * @param {string} sourcePath - 源目录路径
     * @param {string} zipPath - 生成的 ZIP 文件路径
     * @returns {Promise<void>}
     */
    zipDir: function(sourcePath, zipPath) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve();
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 60000); // 压缩可能需要较长时间
        global.appbridge.zipDir(sourcePath, zipPath, callbackId);
      });
    },

    /**
     * 打开浏览器页面
     * @param {string} url - URL
     * @param {string} title - 标题
     */
    openBrowser: function(url, title) {
      if (!global.appbridge) {
        global.open(url, '_blank');
        return;
      }
      global.appbridge.openBrowser(url, title || '');
    },

    /**
     * 显示 Toast 提示
     * @param {string} message - 消息内容
     */
    showToast: function(message) {
      if (!global.appbridge) {
        console.log('[SuperSDK Toast]:', message);
        return;
      }
      global.appbridge.showToast(message);
    },

    /**
     * 设置状态栏深色/浅色模式（同步 · 无返回）
     * 非端环境（无 appbridge）下为 no-op，不抛错。
     * @param {boolean} isDark - true = 深色背景（状态栏图标显示为白色）；false = 浅色背景（图标黑色）
     */
    setStatusBarDarkMode: function(isDark) {
      if (!global.appbridge || !global.appbridge.setStatusBarDarkMode) {
        return;
      }
      global.appbridge.setStatusBarDarkMode(!!isDark);
    },

    /**
     * 唤起软键盘（同步 · 无返回）
     * Android 为空实现（WebView 中 JS focus() 即可触发键盘）；iOS 转发到 Native 处理。
     * 非端环境（无 appbridge）下为 no-op，不抛错。
     * @param {string} [selector] - 目标输入框的 CSS 选择器（可选，iOS 使用）
     */
    showKeyboard: function(selector) {
      if (!global.appbridge || !global.appbridge.showKeyboard) {
        return;
      }
      global.appbridge.showKeyboard(selector || '');
    },

    /**
     * 上报事件
     * @param {string} eventName - 事件名称
     * @param {Object} [params] - 事件参数
     * @returns {Promise<void>}
     */
    reportEvent: function(eventName, params) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          _reportEventViaFetch(eventName, params).then(resolve).catch(reject);
          return;
        }
        const callbackId = generateCallbackId();
        const paramsStr = params ? JSON.stringify(params) : '';
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data);
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 5000);
        global.appbridge.reportEvent(callbackId, eventName, paramsStr);
      });
    },

    /**
     * 设置埋点公共参数（同步 · 无返回）
     * 设置后，本 WebView 后续所有 reportEvent 上报都会自动带上该公共参数。
     * 非端环境（无 appbridge）下为 no-op，不抛错。
     * @param {string} key - 公共参数键
     * @param {string} value - 公共参数值（非字符串会被转为字符串，null/undefined 转为空串）
     */
    addEventCommonParam: function(key, value) {
      if (!global.appbridge || !global.appbridge.addEventCommonParam) {
        return;
      }
      global.appbridge.addEventCommonParam(key, value == null ? '' : String(value));
    },

    // ==================== Host Method ====================

    /**
     * 调用宿主方法（通用接口）
     * @param {string} methodName - 方法名
     * @param {Object} params - 参数
     * @returns {Promise<Object>}
     */
    callHostMethod: function(methodName, params) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        const callbackId = generateCallbackId();
        const paramsStr = params ? JSON.stringify(params) : '';
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data);
          } else {
            reject(new Error(result.message || result.code));
          }
        });
        global.appbridge.callHostMethod(methodName, paramsStr, callbackId);
      });
    },

    // ==================== 登录 ====================

    /**
     * 获取支持的三方登录方式
     * @returns {Promise<string[]>} Provider 名称列表，如 ['google', 'apple']
     */
    getAuthProviders: function() {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data.providers || []);
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 5000);
        global.appbridge.getAuthProviders(callbackId);
      });
    },

    /**
     * 触发三方登录
     * @param {Object} options
     * @param {string} options.provider - 登录方式（如 'google', 'apple'）
     * @returns {Promise<Object>} 三方凭证 {provider, token, authorizationCode, email, displayName, ...}
     * @throws {Error} 用户取消时 message 为 'CANCELLED'
     */
    requestLogin: function(options) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        if (!options || !options.provider) {
          reject(new Error('options.provider is required'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data);
          } else {
            var err = new Error(result.code || 'ERROR');
            err.detail = result.message;
            reject(err);
          }
        }, 60000);
        global.appbridge.requestLogin(options.provider, callbackId);
      });
    },

    // ==================== 支付 (pay namespace · SDK-F036 重构) ====================
    //
    // F036 破坏式重构 · 顶层老 7 API 全部删除:
    //   purchase / queryProducts / acknowledgePurchase / consumePurchase /
    //   restorePurchases / getPayProviders / registerPayProvider
    // 新挂载 SuperSDK.pay namespace · 含 4 个 API:
    //   pay.purchase(payConfig) — 唯一支付入口(新 payConfig 形态)
    //   pay.getProviders()      — 探测宿主能力
    //   pay.registerProvider(name, provider) — 注册 Web 收银台(checkout 入参变为 payParams)
    //   pay.restorePurchases(options) — 客户端 restore · provider 可选实现
    //
    // payParams reserved keys:productId / accountId(SDK 读它们路由 Native IAP)
    // 其他 payParams 字段:Web 路径 checkout(payParams) 全透传 · Native 不传(无 JSON payload 通道)
    //
    // 下沉业务后端:queryProducts / acknowledgePurchase / consumePurchase
    //   业务方走 Google Play Server API / App Store Server API 自行处理
    pay: {
      /**
       * 注册 JS 层支付 Provider(Web 收银台等非 Native IAP)
       *
       * @param {string} name - Provider 名称(如 'alipay', 'wechat', 'stripe')
       * @param {Object} provider
       * @param {Function} provider.checkout - 创建订单 · 接收 payParams 完整对象 · 返回 { payUrl, orderToken }
       * @param {Function} provider.queryStatus - 查询订单状态 · 接收 orderToken · 返回含 status 字段对象
       * @param {number} [provider.pollInterval=5000] - 轮询间隔 ms
       * @param {number} [provider.maxPolls=6] - 最大轮询次数
       *
       * @example
       * SuperSDK.pay.registerProvider('alipay', {
       *   checkout: async (payParams) => {
       *     // payParams.productId / payParams.tradeType / payParams.extras 等业务字段都在
       *     const res = await myApi.checkout(payParams.productId, { trade_type: payParams.tradeType });
       *     return { payUrl: res.pay_url, orderToken: res.order_token };
       *   },
       *   queryStatus: async (orderToken) => {
       *     const res = await myApi.getOrder(orderToken);
       *     return res;
       *   }
       * });
       */
      registerProvider: function(name, provider) {
        if (!name || typeof name !== 'string') {
          throw new Error('Provider name is required');
        }
        // F038 v0.3 哑管道:provider = 两个方法 { createOrder?, pay? }。
        //  - 三方(Web 收银台):业务实现 pay(自行 checkout+轮询·返三态)· 可附 createOrder
        //  - 内置 IAP override(如 'google_play'):仅 createOrder(无 pay · pay 走 SDK 内置原生)
        if (!provider || typeof provider !== 'object') {
          throw new Error('Provider must be an object');
        }
        if (typeof provider.pay !== 'function' && typeof provider.createOrder !== 'function') {
          throw new Error('Provider must have a pay or createOrder function');
        }
        _payProviders[name] = provider;
      },

      /**
       * 探测宿主支持的支付方式列表(合并 JS 注册的 + Native 注册的)
       * @returns {Promise<string[]>}
       */
      getProviders: function() {
        var jsProviders = Object.keys(_payProviders).filter(function(n) { return n !== '_inline'; });

        if (!global.appbridge) {
          return Promise.resolve(jsProviders);
        }

        return new Promise(function(resolve, reject) {
          var callbackId = generateCallbackId();
          registerCallback(callbackId, function(result) {
            delete callbackMap[callbackId];
            var nativeProviders = (result.code === 'SUCCESS' && result.data && result.data.providers) || [];
            var all = jsProviders.concat(nativeProviders.filter(function(p) {
              return jsProviders.indexOf(p) === -1;
            }));
            resolve(all);
          }, 5000);
          global.appbridge.getPayProviders(callbackId);
        });
      },

      /**
       * 发起购买(F038 v0.3 哑管道 · 单入口聚合 createOrder→pay)
       *
       * 🔴 SDK 是哑管道:仅按 provider 名路由 + 把 createOrder 产出的**不透明 JSON** 透传给 pay ·
       *    **不解析 json 任何字段**(productId/accountId/profileId 等由 provider 实现方自洽)。
       *
       *  - provider = 两个方法 { createOrder(payParams)→json, pay(json)→PayResult3State }
       *  - 内部:json = createOrder(payParams) → pay(json);公共面仅此入口(不新增 createAndPay)
       *  - 返回 **PayResult3State** { status:'finished'|'cancelled'|'error', orderToken?, phase?, code?, message? }
       *      finished = 流程结束·去查单(≠成功)· 不含凭证
       *  - reject 仅"无法开始":INVALID_PARAMS / NOT_IN_APP / SDK_TOO_OLD / PURCHASE_IN_PROGRESS
       *  - 已开始流程的终态(create/pay 失败、取消、结束)一律 resolve 三态
       *
       * @param {Object} payConfig
       * @param {string} [payConfig.provider] - 单 Provider 可省 · 多 Provider 必填
       * @param {Object} payConfig.payParams - createOrder 入参 · 必填(对象)
       * @param {Function} [payConfig.createOrder] - inline 模式 · (payParams)=>Promise<json>
       * @param {Function} [payConfig.pay] - inline 模式 · (json)=>Promise<PayResult3State>(有此则走 inline JS provider)
       * @returns {Promise<Object>} PayResult3State
       *
       * 路由:① payConfig.pay 函数 → inline JS provider;② provider 注册且含 pay → 三方 JS;
       *       ③ 其余(未注册 / 仅 createOrder override) → 内置 Native IAP pay;④ 不传 provider → 自动选
       */
      purchase: function(payConfig) {
        // ① 输入校验:SDK 仅校验 payConfig/payParams 是对象(不碰 productId 等业务字段 · 哑管道)
        if (!payConfig || typeof payConfig !== 'object' || Array.isArray(payConfig)) {
          return _invalidParams('payConfig must be object');
        }
        if (!payConfig.payParams || typeof payConfig.payParams !== 'object' || Array.isArray(payConfig.payParams)) {
          return _invalidParams('payParams must be object');
        }

        var self = SDK;
        var providerName = payConfig.provider || '';
        var payParams = payConfig.payParams;

        // inline 模式(外层 pay 函数)
        if (typeof payConfig.pay === 'function') {
          if (_webInlineInProgress) {
            return Promise.reject(_makeError('PURCHASE_IN_PROGRESS', 'Another inline purchase in progress'));
          }
          _webInlineInProgress = true;
          _payProviders['_inline'] = { createOrder: payConfig.createOrder, pay: payConfig.pay };
          return self._runProvider('_inline', _payProviders['_inline'], payParams).finally(function() {
            _webInlineInProgress = false;
            delete _payProviders['_inline'];
          });
        }

        // 明确 provider
        if (providerName) {
          return self._runProvider(providerName, _payProviders[providerName] || null, payParams);
        }

        // 未指定 provider → 自动选择
        return SDK.pay.getProviders().then(function(allProviders) {
          if (allProviders.length === 0) {
            throw _makeError('NO_PROVIDER', 'No payment provider available');
          }
          if (allProviders.length > 1) {
            throw _makeError('PROVIDER_REQUIRED', 'Multiple providers available: ' + allProviders.join(', '));
          }
          var auto = allProviders[0];
          return self._runProvider(auto, _payProviders[auto] || null, payParams);
        });
      },

      /**
       * 恢复购买(客户端 · 仅 Native IAP · provider 可选实现)
       *
       * provider 未实现 restorePurchases 时 reject Error('NOT_SUPPORTED')·
       * 业务方按需 fallback 到业务后端 /api/pay/my-purchases。
       *
       * @param {Object} [options]
       * @param {string} [options.provider] - 单 Provider 时可省 · 多 Provider 必填
       * @returns {Promise<Object[]>}
       */
      restorePurchases: function(options) {
        return new Promise(function(resolve, reject) {
          if (!global.appbridge) {
            reject(_makeError('NOT_IN_APP', 'Not in app environment. This API requires native app support.'));
            return;
          }
          var provider = (options && options.provider) || '';
          var callbackId = generateCallbackId();
          registerCallback(callbackId, function(result) {
            delete callbackMap[callbackId];
            if (result.code === 'SUCCESS') {
              resolve((result.data && result.data.purchases) || []);
            } else {
              reject(_makeError(result.code || 'ERROR', result.message));
            }
          }, 30000);
          global.appbridge.restorePurchases(provider, callbackId);
        });
      }
    },

    /**
     * 归一化 pay 返回值为 PayResult3State(防御:业务 pay 返回缺 status)
     * @private
     */
    _normalize3State: function(r) {
      if (r && typeof r === 'object' && typeof r.status === 'string') return r;
      return { status: 'finished' };  // 业务 pay 未返标准三态 · 兜底当 finished(去查单)
    },

    /**
     * 统一执行 provider:createOrder(payParams)→json → pay(json)→三态(哑管道核心)
     *  - createOrder 缺省 = identity(payParams 原样作 json · 内置 IAP 纯参数场景)
     *  - reg.pay 为函数 → 三方 JS pay;否则 → 内置 Native IAP pay(_nativePay)
     *  - createOrder reject/throw(发生在 JSSDK 内)→ resolve {status:error,phase:create}(不 reject 给调用方)
     *  - SDK **不读 json 任何字段** · 原样透传
     * @private
     */
    _runProvider: function(name, reg, payParams) {
      var self = SDK;
      var createOrder = (reg && typeof reg.createOrder === 'function')
        ? reg.createOrder
        : function(p) { return p; };  // identity

      return new Promise(function(resolve, reject) {
        Promise.resolve()
          .then(function() { return createOrder(payParams); })
          .then(
            function(json) {
              // createOrder 成功 → pay 步骤
              var payStep;
              if (reg && typeof reg.pay === 'function') {
                // 三方 JS provider:业务 pay 自行 checkout+轮询 · 返三态;
                // 业务 pay throw/reject → 归一化为 pay error 三态(已开始的终态用 resolve)
                payStep = Promise.resolve()
                  .then(function() { return reg.pay(json); })
                  .then(self._normalize3State)
                  .catch(function(e) {
                    return { status: 'error', phase: 'pay', code: (e && e.code) || 'PAY_FAILED', message: (e && e.message) || 'pay failed' };
                  });
              } else {
                // 内置 Native IAP pay:终态 resolve 三态;NOT_IN_APP/SDK_TOO_OLD(无法开始)reject 穿透
                payStep = self._nativePay(name, json);
              }
              payStep.then(resolve, reject);  // 🔴 pay 的 reject(仅"无法开始")穿透 · 不降级 create
            },
            function(createErr) {
              // createOrder 失败 → create error 三态(CR-3:在 JSSDK 内捕获 · 不 reject 给调用方)
              resolve({ status: 'error', phase: 'create', code: (createErr && createErr.code) || 'CREATE_FAILED', message: (createErr && createErr.message) || 'createOrder failed' });
            }
          );
      });
    },

    /**
     * 内置 Native IAP pay(私有 · 通用管道)
     *  appbridge.nativePay(provider, JSON.stringify(json), callbackId) → 三态
     *  SDK **不解析 json** · 原样 JSON.stringify 透传;字段由原生 provider.pay 自读
     *  reject 仅 NOT_IN_APP / SDK_TOO_OLD(无法开始);终态 resolve 三态
     * @private
     */
    _nativePay: function(provider, json) {
      if (!global.appbridge) {
        return Promise.reject(_makeError('NOT_IN_APP', 'Not in app environment. This API requires native app support.'));
      }
      // 破坏式(Q2=A):老 SDK 无 nativePay → 明确 SDK_TOO_OLD · 不静默 fallback
      if (typeof global.appbridge.nativePay !== 'function') {
        return Promise.reject(_makeError('SDK_TOO_OLD',
          'SuperSDK native too old for unified pay (F038) · requires appbridge.nativePay · please upgrade SDK'));
      }
      return new Promise(function(resolve) {
        var callbackId = generateCallbackId();
        var jsonString;
        try {
          jsonString = JSON.stringify(json || {});
        } catch (e) {
          resolve({ status: 'error', phase: 'create', code: 'INVALID_JSON', message: 'createOrder produced non-serializable json' });
          return;
        }
        registerCallback(callbackId, function(result) {
          delete callbackMap[callbackId];
          // Native(PayBridge 守门)经 SUCCESS data 通道投递白名单三态;凭证不出 Native
          if (result.code === 'SUCCESS' && result.data && result.data.status) {
            resolve(result.data);
          } else {
            resolve({ status: 'error', phase: 'pay', code: result.code || 'ERROR', message: result.message });
          }
        }, 190000);
        global.appbridge.nativePay(provider, jsonString, callbackId);
      });
    },

    // ==================== 广告 ====================

    /**
     * 展示激励视频广告
     * @param {Object} options
     * @param {string} options.adUnitId - 广告单元 ID
     * @param {string} [options.adSource='ADMOB'] - 广告来源 ('ADMOB' | 'APPLOVIN')
     * @returns {Promise<{dismissed: boolean, rewarded: boolean}>}
     */
    showRewardAd: function(options) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        if (!options || !options.adUnitId) {
          reject(new Error('options.adUnitId is required'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data);
          } else {
            var err = new Error(result.code || 'ERROR');
            err.detail = result.message;
            reject(err);
          }
        }, 120000);
        global.appbridge.showRewardAd(JSON.stringify(options), callbackId);
      });
    },

    /**
     * 展示激励插屏广告。调用前业务必须先展示奖励说明和可跳过的 intro。
     * @param {Object} options
     * @param {string} options.adUnitId - 广告单元 ID
     * @param {string} [options.adSource='ADMOB'] - 广告来源
     * @returns {Promise<{dismissed: boolean, rewarded: boolean}>}
     */
    showRewardedInterstitialAd: function(options) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        if (!options || !options.adUnitId) {
          reject(new Error('options.adUnitId is required'));
          return;
        }
        if (typeof global.appbridge.showRewardedInterstitialAd !== 'function') {
          var unsupported = new Error('NOT_SUPPORTED');
          unsupported.detail = 'Native bridge does not support rewarded interstitial ads';
          reject(unsupported);
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data);
          } else {
            var err = new Error(result.code || 'ERROR');
            err.detail = result.message;
            reject(err);
          }
        }, 120000);
        global.appbridge.showRewardedInterstitialAd(JSON.stringify(options), callbackId);
      });
    },

    /**
     * 展示插屏广告
     * @param {Object} options
     * @param {string} options.adUnitId - 广告单元 ID
     * @param {string} [options.adSource='ADMOB'] - 广告来源 ('ADMOB' | 'APPLOVIN')
     * @returns {Promise<{dismissed: boolean, rewarded: boolean}>}
     */
    showInterstitialAd: function(options) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        if (!options || !options.adUnitId) {
          reject(new Error('options.adUnitId is required'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data);
          } else {
            var err = new Error(result.code || 'ERROR');
            err.detail = result.message;
            reject(err);
          }
        }, 60000);
        global.appbridge.showInterstitialAd(JSON.stringify(options), callbackId);
      });
    },

    /**
     * 展示 Banner 广告
     * @param {Object} options
     * @param {string} options.adUnitId - 广告单元 ID
     * @param {string} [options.adSource='ADMOB'] - 广告来源 ('ADMOB' | 'APPLOVIN')
     * @param {string} [options.position='bottom'] - 位置 ('top' | 'bottom')
     * @returns {Promise<{adId: string}>} 返回 adId 用于后续 hideBannerAd
     */
    showBannerAd: function(options) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        if (!options || !options.adUnitId) {
          reject(new Error('options.adUnitId is required'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data);
          } else {
            var err = new Error(result.code || 'ERROR');
            err.detail = result.message;
            reject(err);
          }
        }, 30000);
        global.appbridge.showBannerAd(JSON.stringify(options), callbackId);
      });
    },

    /**
     * 隐藏 Banner 广告
     * @param {string} adId - showBannerAd 返回的 adId
     * @returns {Promise<void>}
     */
    hideBannerAd: function(adId) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        if (!adId) {
          reject(new Error('adId is required'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve();
          } else {
            var err = new Error(result.code || 'ERROR');
            err.detail = result.message;
            reject(err);
          }
        }, 5000);
        global.appbridge.hideBannerAd(adId, callbackId);
      });
    },

    // ==================== 归因 ====================

    /**
     * 获取归因数据
     * @param {boolean} [onlyFirst=false] - 是否只获取首次归因（跳过网络请求）
     * @returns {Promise<{first: Object|null, current: Object|null}>} 归因数据
     *   - first: 首次归因（从缓存读取），无则为 null
     *   - current: 当前归因（网络请求），onlyFirst=true 时为 undefined
     */
    getAttribution: function(onlyFirst) {
      return new Promise((resolve, reject) => {
        if (!global.appbridge) {
          reject(new Error('Not in app environment. This API requires native app support.'));
          return;
        }
        const callbackId = generateCallbackId();
        registerCallback(callbackId, (result) => {
          delete callbackMap[callbackId];
          if (result.code === 'SUCCESS') {
            resolve(result.data);
          } else {
            reject(new Error(result.message || result.code));
          }
        }, 30000); // 归因请求可能需要较长时间
        global.appbridge.getAttribution(callbackId, onlyFirst ? true : false);
      });
    },

    // ==================== Native Block ====================

    /**
     * Native Block 模块
     * 提供 H5 与 Native View 的"伪同层渲染"能力
     */
    nativeBlock: {
      _blocks: {},  // blockId -> { element, config }
      _scrollListenerBound: false,

      /**
       * 初始化 - 扫描静态 native-block 并注册
       * 建议在 DOMContentLoaded 后调用
       */
      init: function() {
        var self = this;
        document.querySelectorAll('native-block').forEach(function(el) {
          self._initElement(el);
        });
        this._bindScrollListener();
        window.addEventListener('beforeunload', function() {
          self.destroyAll();
        });
      },

      /**
       * 动态创建 native-block
       * @param {Object} options 配置选项
       * @param {string} options.blockId 唯一标识（必填）
       * @param {string} options.blockType 组件类型（必填，如 "ad-banner"）
       * @param {Object} [options.config] 传递给宿主的配置
       * @param {HTMLElement} [options.container] 插入到哪个容器，默认 document.body
       * @param {Object} [options.style] CSS 样式对象
       * @returns {Promise<{blockId: string, element: HTMLElement, destroy: Function}>}
       */
      create: function(options) {
        var self = this;
        return new Promise(function(resolve, reject) {
          if (!options || !options.blockId || !options.blockType) {
            reject(new Error('blockId and blockType are required'));
            return;
          }

          // 1. 创建占位 element
          var el = document.createElement('native-block');
          el.setAttribute('block-id', options.blockId);
          el.setAttribute('block-type', options.blockType);
          if (options.style) {
            Object.keys(options.style).forEach(function(key) {
              el.style[key] = options.style[key];
            });
          }

          // 2. 插入 DOM
          var container = options.container || document.body;
          container.appendChild(el);

          // 3. 注册到 Native
          self._createBlock(options.blockId, options.blockType, options.config || {})
            .then(function() {
              self._blocks[options.blockId] = { element: el, config: options };
              self._updatePosition(options.blockId);
              resolve({
                blockId: options.blockId,
                element: el,
                destroy: function() {
                  self.destroy(options.blockId);
                }
              });
            })
            .catch(reject);
        });
      },

      /**
       * 调用 Native 创建 Block
       * @private
       */
      _createBlock: function(blockId, blockType, config) {
        return new Promise(function(resolve, reject) {
          if (!global.appbridge) {
            reject(new Error('Not in app environment. This API requires native app support.'));
            return;
          }
          var callbackId = generateCallbackId();
          registerCallback(callbackId, function(result) {
            delete callbackMap[callbackId];
            if (result.code === 'SUCCESS') {
              resolve(result.data);
            } else {
              reject(new Error(result.message || result.code));
            }
          }, 10000);
          global.appbridge.createNativeBlock(blockId, blockType, JSON.stringify(config), callbackId);
        });
      },

      /**
       * 初始化静态 element
       * @private
       */
      _initElement: function(el) {
        var self = this;
        var blockId = el.getAttribute('block-id');
        var blockType = el.getAttribute('block-type');
        var configAttr = el.getAttribute('block-config');
        var config = {};
        if (configAttr) {
          try {
            config = JSON.parse(configAttr);
          } catch (e) {
            console.error('Native block config parse error:', e);
          }
        }

        if (!blockId || !blockType) {
          console.error('Native block missing block-id or block-type');
          return;
        }

        this._createBlock(blockId, blockType, config).then(function() {
          self._blocks[blockId] = { element: el, config: { blockId: blockId, blockType: blockType, config: config } };
          self._updatePosition(blockId);
        }).catch(function(e) {
          console.error('Native block create failed:', e);
        });
      },

      /**
       * 绑定滚动监听
       * @private
       */
      _bindScrollListener: function() {
        if (this._scrollListenerBound) return;
        this._scrollListenerBound = true;

        var self = this;
        var ticking = false;
        window.addEventListener('scroll', function() {
          if (!ticking) {
            requestAnimationFrame(function() {
              self.updatePositions();
              ticking = false;
            });
            ticking = true;
          }
        }, { passive: true });

        // 也监听 resize 事件
        window.addEventListener('resize', function() {
          if (!ticking) {
            requestAnimationFrame(function() {
              self.updatePositions();
              ticking = false;
            });
            ticking = true;
          }
        }, { passive: true });
      },

      /**
       * 更新所有 Block 的位置
       */
      updatePositions: function() {
        var self = this;
        Object.keys(this._blocks).forEach(function(id) {
          self._updatePosition(id);
        });
      },

      /**
       * 更新单个 Block 的位置
       * @private
       */
      _updatePosition: function(blockId) {
        var block = this._blocks[blockId];
        if (!block || !block.element) return;
        if (!global.appbridge) return;

        var rect = block.element.getBoundingClientRect();
        var pos = {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          visible: rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth
        };
        global.appbridge.updateNativeBlockPosition(blockId, JSON.stringify(pos));
      },

      /**
       * 销毁单个 Block
       * @param {string} blockId 唯一标识
       */
      destroy: function(blockId) {
        var block = this._blocks[blockId];
        if (block) {
          if (global.appbridge) {
            global.appbridge.destroyNativeBlock(blockId);
          }
          if (block.element && block.element.parentNode) {
            block.element.parentNode.removeChild(block.element);
          }
          delete this._blocks[blockId];
        }
      },

      /**
       * 销毁所有 Block
       */
      destroyAll: function() {
        var self = this;
        Object.keys(this._blocks).forEach(function(id) {
          self.destroy(id);
        });
        if (global.appbridge) {
          global.appbridge.destroyAllNativeBlocks();
        }
      }
    }
  };

  Object.defineProperty(SDK, '__legacyBridge', {
    configurable: false,
    enumerable: false,
    value: JSBridge
  });
  Object.defineProperty(SDK, '__installLegacyBridge', {
    configurable: false,
    enumerable: false,
    value: installBridge
  });
  return SDK;
}
