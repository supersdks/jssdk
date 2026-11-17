# JSBridge 技术文档

本文档说明 JSBridge 的底层通信机制，面向需要了解 Native 与 JS 交互原理的开发者。

## 2.0 协议入口

2.0 在历史 wrapper 之外提供 `sdk.bridge`。容器通过同步、无副作用的保留方法 `getBridgeManifest()` 返回 v1 manifest；该方法不属于业务 methods，不能从 `supports/request/command` 调用。IDL 和正反向量分别随包发布在 `protocol/v1.json` 与 `protocol/golden-vectors.json`，运行时数据/校验器从 `@supersdk/jssdk/protocol` 导入。

```js
const state = await SuperSDK.bridge.ready();
if (state.status === 'negotiated' && SuperSDK.bridge.supports('getEnv')) {
  const env = await SuperSDK.bridge.request('getEnv', []);
}
```

状态固定为 `absent / legacy / negotiated / incompatible / degraded`。bootstrap 存在但读取、大小、JSON 或签名校验失败时进入 `degraded`，不会静默回退。`request` 默认 deadline 为 5000ms，`openStream` 默认 300000ms；二者支持 AbortSignal。`command` 只表达同步派发已接受，在下一 microtask 完成，不创建 native ack timer。

同一个 target 上的多个 SDK instance 共享 owner 隔离的 callback hub。已认领 callback 只进入所属 owner，事件按订阅投递，返回键按 owner 后进先出；未认领消息才委托安装前的 foreign handler。`dispose()` 清除本 owner 的 pending/listener，最后 owner 仅在全局对象仍为当前 hub 时恢复原 handler。

错误 envelope 的 `code` 缺失、非字符串或空串统一为 `PROTOCOL_MISMATCH`；已登记 code 按公开 registry 映射；任意未知非空 provider code 统一为 `BRIDGE_ERROR` 和 `nativeCode: "UNKNOWN"`。诊断只记录有界 method/event/state/outcome/error class，不记录参数、结果、路径、URL、message 或 stack。

## 架构概述

```
┌─────────────────────────────────────────────────────────┐
│                      Web 页面                            │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐ │
│  │  SuperSDK   │    │  JSBridge   │    │   业务代码   │ │
│  └──────┬──────┘    └──────┬──────┘    └─────────────┘ │
│         │                  │                            │
│         ▼                  ▼                            │
│  ┌─────────────────────────────────────────────────────┤
│  │              window.appbridge                        │
│  │         (Native 注入的 JS 接口)                      │
│  └─────────────────────────────────────────────────────┤
└─────────────────────────────────────────────────────────┘
                          │
                          │ @JavascriptInterface
                          ▼
┌─────────────────────────────────────────────────────────┐
│                      Android                             │
│  ┌──────────────────────────────────────────────────┐  │
│  │                  SuperWebview.java                │  │
│  │  - WebView 配置与初始化                           │  │
│  │  - URL 拦截处理                                   │  │
│  │  - 生命周期管理                                   │  │
│  │  - WebView 间通信 (broadcastToAll, sendToWebview) │  │
│  │  - 异步回调 (asyncCallbackSuccess/Fail)          │  │
│  └──────────────────────────────────────────────────┘  │
│                          │                              │
│                          │ 注入                         │
│                          ▼                              │
│  ┌──────────────────────────────────────────────────┐  │
│  │                   AppBridge.java                  │  │
│  │  - 环境与配置 JSB                                 │  │
│  │  - 页面导航 JSB                                   │  │
│  │  - 分享 JSB                                       │  │
│  │  - WebView 通信 JSB                               │  │
│  │  - 文件下载 JSB                                   │  │
│  │  - 文件操作 JSB                                   │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## 文件结构

```
app/src/main/java/com/asuper/android/webview/
├── SuperWebview.java           # WebView 核心类
├── AppBridge.java              # JSB 门面类，委托给各模块
└── bridge/                     # JSB 功能模块
    ├── BaseBridge.java         # 基类，提供通用功能
    ├── EnvBridge.java          # 环境与配置
    ├── NavigationBridge.java   # 页面导航
    ├── ShareBridge.java        # 分享
    ├── WebViewBridge.java      # WebView 间通信
    ├── DownloadBridge.java     # 文件下载
    └── FileBridge.java         # 文件操作
```

### SuperWebview.java

WebView 核心类，职责：
- WebView 配置初始化
- URL 拦截与处理
- 生命周期事件分发
- WebView 注册表管理
- JS 回调调度 (`callSubscribeHandler`)
- 异步回调辅助方法 (`asyncCallbackSuccess/Fail`)

### AppBridge.java

JSB 门面类，职责：
- 所有 `@JavascriptInterface` 标注的方法入口
- 将请求委托给对应的功能模块

### bridge/ 模块

| 模块 | 职责 |
|------|------|
| BaseBridge | 基类，提供 Context、WebView 弱引用、MainHandler |
| EnvBridge | 环境信息、配置获取 |
| NavigationBridge | 页面打开、关闭、外部跳转 |
| ShareBridge | 系统分享 |
| WebViewBridge | WebView 间消息广播 |
| DownloadBridge | 文件下载、缓存下载、取消下载 |
| FileBridge | 文件增删改查操作 |

## 通信机制

### 1. JS 调用 Native

通过 `window.appbridge` 对象直接调用 Native 方法：

```javascript
// 同步调用
appbridge.share(content);

// 异步调用（需要 callbackId）
appbridge.getEnvAsync(callbackId);
```

### 2. Native 调用 JS

Native 通过 `evaluateJavascript` 调用 JS 的 `JSBridge.subscribeHandler`：

```java
// SuperWebview.java
public void callSubscribeHandler(String eventType, String eventKey, String jsonData) {
    APool.executeUI(() -> {
        String js = "JSBridge.subscribeHandler(\"" + eventType + "\",\"" + eventKey + "\"," + jsonData + ")";
        evaluateJavascript(js, null);
    });
}
```

## 事件类型

| 常量 | 值 | 说明 |
|------|------|------|
| EVENT_TYPE_ASYNC_CALLBACK | "ASYNC_CALLBACK" | 异步方法的回调响应 |
| EVENT_TYPE_BROADCAST | "BROADCAST" | WebView 间的广播消息 |
| EVENT_TYPE_SYSTEM | "SYSTEM" | 系统级事件（生命周期等） |

## subscribeHandler 协议

Native 调用 JS 的统一入口：

```javascript
JSBridge.subscribeHandler(eventType, eventKey, data)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| eventType | string | 事件类型：ASYNC_CALLBACK / BROADCAST / SYSTEM |
| eventKey | string | 事件标识：回调ID / 事件名 / 系统事件名 |
| data | object | JSON 格式的数据 |

### 异步回调响应格式

成功：
```json
{
  "code": "SUCCESS",
  "message": "",
  "data": { ... }
}
```

失败：
```json
{
  "code": "ERROR_CODE",
  "message": "错误信息"
}
```

### 系统事件格式

```json
{
  "triggerFrom": "window" | "view" | "activity"
}
```

## Native 接口列表 (AppBridge.java)

### 环境与配置

| 方法 | 参数 | 说明 |
|------|------|------|
| getEnvAsync | callbackId | 获取环境信息 |
| getSettingsAsync | callbackId | 获取所有配置 |
| getSettingsByKeyAsync | key, callbackId | 根据 key 获取配置 |

### 页面导航

| 方法 | 参数 | 说明 |
|------|------|------|
| openPage | url, config | 打开新 WebView 页面 |
| openExternal | url | 系统方式打开 URL |
| openWithBrowser | url | 浏览器打开 URL |
| closePage | - | 关闭当前页面 |

### 分享

| 方法 | 参数 | 说明 |
|------|------|------|
| share | content | 分享文本内容 |

### WebView 间通信

| 方法 | 参数 | 说明 |
|------|------|------|
| publishToWebView | targetId, eventKey, jsonContent | 广播消息到其他 WebView |

### 文件下载

| 方法 | 参数 | 说明 |
|------|------|------|
| downloadFile | callbackId, url, headers, savePath | 下载文件（支持进度回调） |
| downloadWithCache | callbackId, fileUrl, fileMd5, cacheTts, fileCacheKey | 下载并缓存文件，命中缓存直接返回本地路径 |
| cancelDownload | callbackId | 取消下载任务 |

### 文件操作

| 方法 | 参数 | 说明 |
|------|------|------|
| fileExists | path, callbackId | 检查文件/目录是否存在 |
| getFileMd5 | path, callbackId | 获取文件 MD5 |
| deleteFile | path, callbackId | 删除文件或目录 |
| moveFile | srcPath, destPath, callbackId | 移动/重命名文件 |
| createDir | path, callbackId | 创建目录 |
| listDir | path, callbackId | 列出目录内容 |
| readFile | path, callbackId | 读取文本文件 |
| writeFile | path, content, callbackId | 写入文本文件 |

### ZIP 压缩与解压

| 方法 | 参数 | 说明 |
|------|------|------|
| unzipFile | zipPath, destPath, callbackId | 解压 ZIP 文件到目标目录 |
| zipDir | sourcePath, zipPath, callbackId | 将目录压缩为 ZIP 文件 |

### 广告（Android）

| 方法 | 参数 | 说明 |
|------|------|------|
| showRewardAd | config, callbackId | 加载并展示激励视频，终态返回 `{ dismissed, rewarded }` |
| showRewardedInterstitialAd | config, callbackId | 加载并展示激励插屏；业务调用前必须展示奖励说明和可跳过 intro |
| showInterstitialAd | config, callbackId | 加载并展示插屏广告 |
| showBannerAd | config, callbackId | 展示 Banner，成功返回 `adId` |
| hideBannerAd | adId, callbackId | 移除并销毁 Banner |

`config` 为 JSON 字符串，至少包含 `adUnitId`，可选 `adSource`（默认 `ADMOB`）。Rewarded Interstitial 当前仅 Android 支持；JSSDK 在旧桥或不支持平台立即返回 `NOT_SUPPORTED`。

### A/B 实验（双端 · WS-12-S2 / S6）

六个方法签名相同：`(callbackId, paramsJson)`，异步回调。原生与端内 H5 共用同一份结果、同一张冻结表与同一套曝光去重；H5 经 `getExperiment` / `exposeExperiment` 触发的 `$exp_exposure` 记 `source: "h5"`。

| 方法 | paramsJson | 成功回调 data |
|------|------------|---------------|
| experimentReady | `{ timeoutMs?, namespaces? }` | `{ ready }`（超时为 `false`） |
| getAllExperiments | `{}` | `{ experiments: [{ key, inExperiment, variant, vid, payload, reason, frozen, type, exposed }] }`（不冻结、不曝光；`type` 为 `client` / `server`，`exposed` 表示该 vid 在已曝光集合里，S6 起） |
| getExperiment | `{ key, expose?, default? }` | `{ inExperiment, variant, vid, payload, reason }`（冻结；`expose` 默认 `true`；服务端实验返回未参与 `reason: "unknown"`，不冻结不曝光） |
| getExperimentRequestVids | `{}` | `{ vids }`：已加载命名空间里命中的服务端实验视为已读取（冻结、曝光 `source: "h5"`、加入集合）后的已曝光集合，升序逗号分隔，空集合为 `""`（S6 起） |
| exposeExperiment | `{ key }` | `{}` |
| setExperimentAttributes | `{ attributes }`（键不带 `attr.` 前缀，值为字符串，`null` 删除） | `{}` |

JSSDK 只在容器同时声明前五个方法时委托原生（`bridge.supports`）；`getExperimentRequestVids` 可选，缺失时 JSSDK 只按 `getAllExperiments` 镜像计算请求头的值；端内 H5 经 `reportEvent` 上报的事件由原生在创建时写入 `exp_vids`，JSSDK 不再附带。

## Native 事件触发

### 系统事件

| 事件名 | 触发时机 | 数据 |
|------|------|------|
| onEnterForeground | WebView 变为可见 | { triggerFrom } |
| onEnterBackground | WebView 变为不可见 | { triggerFrom } |

### triggerFrom 来源

| 值 | 触发时机 |
|------|------|
| window | onWindowVisibilityChanged |
| view | setVisibility |
| activity | Activity onResume/onPause |

## WebView 注册表

SuperWebview 维护一个全局的 WebView 实例注册表，用于实现 WebView 间通信：

```java
// SuperWebview.java
private static final Map<String, WeakReference<SuperWebview>> webviewRegistry = new ConcurrentHashMap<>();

// 注册
@Override
protected void onAttachedToWindow() {
    super.onAttachedToWindow();
    webviewRegistry.put(webviewId, new WeakReference<>(this));
}

// 注销
@Override
protected void onDetachedFromWindow() {
    super.onDetachedFromWindow();
    webviewRegistry.remove(webviewId);
}

// 广播到所有
static void broadcastToAll(String eventKey, String jsonContent) {
    for (Map.Entry<String, WeakReference<SuperWebview>> entry : webviewRegistry.entrySet()) {
        SuperWebview webview = entry.getValue().get();
        if (webview != null) {
            webview.callSubscribeHandler(EVENT_TYPE_BROADCAST, eventKey, jsonContent);
        }
    }
}

// 发送到指定 WebView
static void sendToWebview(String targetWebviewId, String eventKey, String jsonContent) {
    WeakReference<SuperWebview> ref = webviewRegistry.get(targetWebviewId);
    if (ref != null) {
        SuperWebview webview = ref.get();
        if (webview != null) {
            webview.callSubscribeHandler(EVENT_TYPE_BROADCAST, eventKey, jsonContent);
        }
    }
}
```

## 流程示例

### 异步调用流程

```
┌────────┐         ┌──────────┐         ┌────────────┐
│   JS   │         │AppBridge │         │   JS       │
└───┬────┘         └────┬─────┘         └─────┬──────┘
    │                   │                     │
    │ appbridge.getEnvAsync(callbackId)       │
    │──────────────────►│                     │
    │                   │                     │
    │                   │ 执行业务逻辑          │
    │                   │ webview.asyncCallbackSuccess()
    │                   │                     │
    │                   │ JSBridge.subscribeHandler(
    │                   │   "ASYNC_CALLBACK",
    │                   │   callbackId,
    │                   │   result)
    │                   │─────────────────────►│
    │                   │                     │
    │                   │                     │ 查找并执行回调
    │                   │                     │
```

### 广播流程

```
┌────────────┐      ┌──────────┐      ┌────────────┐
│ WebView A  │      │AppBridge │      │ WebView B  │
└─────┬──────┘      └────┬─────┘      └─────┬──────┘
      │                  │                  │
      │ publishToWebView("*", "event", data)│
      │─────────────────►│                  │
      │                  │                  │
      │                  │ SuperWebview.broadcastToAll()
      │                  │                  │
      │  subscribeHandler│  subscribeHandler│
      │◄─────────────────│─────────────────►│
      │                  │                  │
```

### 文件下载流程

```
┌────────┐         ┌──────────┐         ┌────────────┐
│   JS   │         │AppBridge │         │   JS       │
└───┬────┘         └────┬─────┘         └─────┬──────┘
    │                   │                     │
    │ downloadFile(callbackId, url, ...)      │
    │──────────────────►│                     │
    │                   │                     │
    │                   │ callback: START     │
    │                   │─────────────────────►
    │                   │                     │
    │                   │ callback: PROGRESS (每300ms)
    │                   │─────────────────────►
    │                   │                     │
    │                   │ callback: SUCCESS/FAIL
    │                   │─────────────────────►
    │                   │                     │
```

## 容器职责

### WebPageActivity

- 设置 `OnClosePageListener` → `this::finish`
- 在 `onResume` 调用 `dispatchActivityResume()`
- 在 `onPause` 调用 `dispatchActivityPause()`

### TabWebViewManager

- 仅负责 Tab 切换和 WebView 缓存管理
- 不设置 `OnClosePageListener`（closePage 无效果）
- 通过 `setVisibility` 触发可见性事件

## 安全考虑

1. **WeakReference**: AppBridge 持有 WebView 的弱引用，防止内存泄漏
2. **MainHandler**: 确保 UI 操作在主线程执行
3. **文件路径隔离**: 文件操作限制在 SDK 存储目录内
4. **参数校验**: Native 方法对参数进行校验
5. **包级访问**: `asyncCallbackSuccess/Fail` 等方法使用包级访问控制
