export type AnalyticsConsent = 'denied' | 'granted';

import type { BridgeEventMap, BridgeMethodMap, BridgeState, PushMessagePayload, PushOpenedPayload, PushPermission, PushStatusWire } from './protocol.js';
import type { MonitoringConsent, MonitoringEnvelopeV1 } from './monitoring-contract.js';
export * from './monitoring-contract.js';

export interface SettingsOptions {
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  maxValueBytes?: number;
  maxParamsBytes?: number;
  timeoutMs?: number;
}

export interface AnalyticsOptions {
  queueCapacity?: number;
  batchSize?: number;
  maxBatchBytes?: number;
  maxAgeMs?: number;
  maxRetries?: number;
  maxBackoffMs?: number;
  flushTimeoutMs?: number;
  flushIntervalMs?: number;
}

export interface InitConfig {
  spid: string;
  environment?: string;
  /** Compatibility alias for environment. */
  env?: string;
  baseUrl?: string;
  baseUrls?: string[];
  baseApi?: string | string[];
  baseAPI?: string | string[];
  appName?: string;
  appIcon?: string;
  deviceId?: string;
  analyticsConsent?: AnalyticsConsent;
  settings?: SettingsOptions;
  analytics?: AnalyticsOptions;
}

export type SuperSDKErrorCode =
  | 'INVALID_ARGUMENT' | 'NOT_INITIALIZED' | 'CONSENT_DENIED' | 'QUEUE_FULL'
  | 'PAYLOAD_TOO_LARGE' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'TIMEOUT'
  | 'NETWORK_ERROR' | 'PROTOCOL_MISMATCH' | 'UNSUPPORTED' | 'BRIDGE_ABSENT'
  | 'BRIDGE_INCOMPATIBLE' | 'BRIDGE_DEGRADED' | 'BRIDGE_ERROR' | 'CANCELLED' | 'DISPOSED'
  | 'MONITORING_START_FAILED' | 'MONITORING_TRANSPORT_NOT_CONFIGURED';

export class SuperSDKError extends Error {
  readonly code: SuperSDKErrorCode;
  readonly retryable: boolean;
  readonly nativeCode?: string;
  readonly reasonCode?: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
  readonly cause?: unknown;
}

export interface FeedbackParams {
  /** 反馈场景（必填 · ≤64 字符），如 'settings' / 'chat' */
  scene: string;
  /** 子场景（可选 · ≤64 字符） */
  subScene?: string;
  /** 标题（必填 · ≤200 字符） */
  title: string;
  /** 反馈内容（必填 · ≤5000 字符） */
  content: string;
  /** 业务用户 ID（可选 · ≤128 字符 · 由调用方提供） */
  userId?: string;
  /** 附加信息（可选 · JSON object · 序列化后 ≤4KB） */
  extra?: Record<string, unknown>;
}

export interface FeedbackReceipt {
  /** 服务端反馈记录 ID */
  feedbackId: number;
}

export interface QueuedEvent {
  readonly eventId: string;
  readonly queued: true;
}

export interface FlushSummary {
  readonly attempted: number;
  readonly sent: number;
  readonly discarded: number;
  readonly retrying: number;
  readonly pending: number;
  readonly reason?: string;
  readonly sessionId?: string;
  readonly pageId?: string;
  readonly requestId?: string;
  readonly api?: string;
  readonly event?: string;
  readonly state?: string;
  readonly outcome?: string;
  readonly latencyBucket?: string;
  readonly protocol?: string;
  readonly container?: string;
  readonly errorClass?: string;
}

export interface BridgeOperationOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

type MethodIdsOfKind<K extends BridgeMethodMap[keyof BridgeMethodMap]['kind']> = {
  [P in keyof BridgeMethodMap]: BridgeMethodMap[P]['kind'] extends K ? P : never
}[keyof BridgeMethodMap];

export interface BridgeStream<TProgress = unknown, TResult = unknown> {
  readonly completion: Promise<TResult>;
  onProgress(listener: (value: TProgress) => void): () => void;
  cancel(): void;
}

export interface BridgeClient {
  ready(options?: { force?: boolean }): Promise<BridgeState>;
  getBridgeState(): BridgeState;
  supports(id: keyof BridgeMethodMap | keyof BridgeEventMap): boolean;
  request<M extends MethodIdsOfKind<'request'>>(methodId: M, args: BridgeMethodMap[M]['args'], options?: BridgeOperationOptions): Promise<BridgeMethodMap[M]['result']>;
  command<M extends MethodIdsOfKind<'command'>>(methodId: M, args: BridgeMethodMap[M]['args'], options?: BridgeOperationOptions): Promise<void>;
  openStream<M extends MethodIdsOfKind<'stream'>>(methodId: M, args: BridgeMethodMap[M]['args'], options?: BridgeOperationOptions): BridgeStream<BridgeMethodMap[M]['progress'], BridgeMethodMap[M]['result']>;
  subscribe<E extends keyof BridgeEventMap>(eventId: E, listener: (event: BridgeEventMap[E]) => void): () => void;
  dispose(): void;
}

export interface DeliveryState {
  readonly consent: AnalyticsConsent;
  readonly pending: number;
  readonly persistent: boolean;
  readonly lastOutcome: null | { sent: number; discarded: number; retrying: number; code: string };
}

export interface Diagnostic {
  readonly level: 'info' | 'warn' | 'error';
  readonly at: number;
  readonly category?: string;
  readonly code?: string;
  readonly pending?: number;
  readonly sent?: number;
  readonly discarded?: number;
  readonly retrying?: number;
  readonly persistent?: boolean;
  readonly reason?: string;
}

export interface SuEncCapabilities {
  readonly supported: boolean;
  readonly codecs: readonly string[];
}

export interface SubscriptionPricingPhase {
  readonly formattedPrice: string;
  readonly currencyCode: string;
  readonly priceAmountMicros: number;
  readonly billingPeriod: string;
  readonly billingCycleCount: number;
  readonly recurrenceMode: number;
}

export interface SubscriptionOffer {
  readonly productId: string;
  readonly basePlanId: string;
  readonly offerId: string | null;
  readonly offerTags: readonly string[];
  readonly title: string;
  readonly description: string;
  readonly pricingPhases: readonly SubscriptionPricingPhase[];
}

export interface PayResult3State {
  readonly status: 'finished' | 'cancelled' | 'error';
  readonly phase?: 'create' | 'pay';
  readonly code?: string;
  readonly message?: string;
  readonly orderToken?: string;
}

export interface PayConfig {
  provider?: string;
  payParams: Record<string, unknown>;
  createOrder?: (payParams: Record<string, unknown>) => unknown | Promise<unknown>;
  pay?: (json: unknown) => PayResult3State | Promise<PayResult3State>;
}

export interface PayProviderRegistration {
  createOrder?: (payParams: Record<string, unknown>) => unknown | Promise<unknown>;
  pay?: (json: unknown) => PayResult3State | Promise<PayResult3State>;
}

export interface PayNamespace {
  getProviders(): Promise<string[]>;
  querySubscriptionOffers(options: {
    provider?: string;
    productIds: readonly string[];
  }): Promise<SubscriptionOffer[]>;
  purchase(config: PayConfig): Promise<PayResult3State>;
  registerProvider(name: string, provider: PayProviderRegistration): void;
  restorePurchases(options?: { provider?: string }): Promise<Record<string, unknown>[]>;
}

export type PushStatus = PushStatusWire;
export type PushOpenedInfo = PushOpenedPayload;
export type PushMessage = PushMessagePayload;

/**
 * 推送命名空间（SDK-F261008030551 · Android `supersdk-push-firebase`）。
 * 浏览器（无 appbridge）：getStatus resolve `{supported:false}`，其余 reject `Error('NOT_SUPPORTED')`；
 * 宿主未接线：getStatus `{supported:false}`，其余 reject `UNSUPPORTED`；iOS 当前 reject `UNSUPPORTED`（stub）。
 * 端内错误为 `Error`，带 `code`（注册表归一后）/ `nativeCode` / `retryable` / `detail`。
 */
export interface PushNamespace {
  /** 状态快照；`lastOpened` 一次性字段，由首个读到它的 getStatus() 消费，不要在轮询里调用。 */
  getStatus(): Promise<PushStatus>;
  /** 申请通知权限（交互类 · 超时 120000ms）；无前台 Activity → `UNAVAILABLE`(retryable)。 */
  requestPermission(): Promise<{ permission: PushPermission }>;
  /** 设置标签；null / [] = 清空。边界（≤10 项 · 每项 ≤32 码点）由 Native 判定 → `INVALID_ARGUMENT`。 */
  setTags(tags: readonly string[] | null): Promise<void>;
  /** 设置业务用户 ID；null / '' = 清除。仅用于推送定向，不是身份认证凭据。≤128 码点由 Native 判定。 */
  setUserId(userId: string | null): Promise<void>;
  /** 前台收到推送（BROADCAST `push.message`）；只投递给事件发生时已存活且已订阅的 WebView。 */
  onMessage(callback: (message: PushMessage) => void): () => void;
  /** 推送点击（BROADCAST `push.opened`）；与 `getStatus().lastOpened` 按 messageId 去重兜底。 */
  onOpened(callback: (opened: PushOpenedInfo) => void): () => void;
}

/** 实验结果来源：参与（alloc/override/rollout）或未参与的原因。 */
export type ExperimentReason =
  | 'alloc' | 'override' | 'rollout'
  | 'unknown' | 'paused' | 'no_subject' | 'audience' | 'traffic' | 'not_loaded' | 'no_result'
  | (string & {});

export interface ExperimentResult<P extends Record<string, unknown> = Record<string, unknown>> {
  /** 参与实验（含 `rollout` 全量）时为 true。 */
  readonly inExperiment: boolean;
  /** 分组 key；未参与为 ''。 */
  readonly variant: string;
  /** 变体 ID（实验 × 轮次 × 分组）；未参与为 null。 */
  readonly vid: number | null;
  /** 分组参数；未参与时为 `options.default ?? {}`。 */
  readonly payload: P;
  readonly reason: ExperimentReason;
}

/** `getAll()` 的条目：`client` 用 `get(key)` 读取；`server` 由后端经请求头读取（`get` 对它返回未参与）。 */
export interface ExperimentListItem extends ExperimentResult {
  readonly type: 'client' | 'server';
}

export interface ExperimentGetOptions<P extends Record<string, unknown> = Record<string, unknown>> {
  /** false：只读取并冻结，不上报曝光；稍后用 `expose(key)` 补报。默认 true。 */
  expose?: boolean;
  /** 未参与时返回的 payload。 */
  default?: P;
}

export interface ExperimentReadyOptions {
  /** 最长等待毫秒数，到时也 resolve。默认 2000。 */
  timeoutMs?: number;
  /** 追加要加载的命名空间（`^[a-z][a-z0-9_]{1,31}$`，含 default 合计 ≤ 10）。 */
  namespaces?: readonly string[];
}

/**
 * A/B 实验（WS-12）。纯网页端自行调用 assign；首次读取即冻结到页面卸载；默认读取即曝光（每会话、每自然日各去重一次）。
 * 端内（2.6.0 起）：容器声明了实验 JSB 时委托原生——拉取、冻结（与原生代码及其他 WebView 共享）、曝光（source `h5`）
 * 与 `exp_vids` 均由原生完成；`get` 同步读取 `ready()`/`refresh()` 建立的镜像，`ready()` 之前读取返回 `no_result` 并冻结。
 * 旧容器（未声明这些方法）保持网页路径（设备 ID 取自端内环境）。
 */
export interface ExperimentNamespace {
  /** 等待本会话首个可用结果（拉取完成或失败）；超时也 resolve。未同意分析时立即 resolve。 */
  ready(options?: ExperimentReadyOptions): Promise<void>;
  /** 同步读取并冻结；默认同时上报 `$exp_exposure`。 */
  get<P extends Record<string, unknown> = Record<string, unknown>>(key: string, options?: ExperimentGetOptions<P>): ExperimentResult<P>;
  /** 为此前以 `expose:false` 读取的实验补报曝光；未参与或未读取过为无操作。 */
  expose(key: string): void;
  /** 诊断用：不冻结、不曝光；已冻结的 key 返回冻结值。每项带 `type`（2.7.0 起，含服务端实验）。 */
  getAll(): Record<string, ExperimentListItem>;
  /** 主动拉取；网络失败 reject（本地结果照常可用）。端内委托模式下为重新读取原生当前结果（原生自行调度拉取）。 */
  refresh(): Promise<void>;
  /** 设置自定义受众属性 `attr.*`（键可带或不带 `attr.` 前缀；null 删除），去抖后重拉。 */
  setAttributes(attributes: Record<string, string | number | boolean | null | undefined>): void;
  /**
   * 服务端实验（2.7.0 起）：返回 `{ 'X-Super-AB-Vids': '<已曝光 vid 升序逗号分隔>' }`，集合为空时返回 `{}`。
   * 副作用：已加载命名空间里本设备命中的服务端实验视为已读取（冻结到会话结束、曝光一次、加入已曝光集合）。
   * 端内委托时同步读镜像，`ready()` 之前返回 `{}`。
   */
  getRequestHeaders(): Partial<Record<'X-Super-AB-Vids', string>>;
  /** 返回加上 `super_ab_vids=<vids>` 的 URL（覆盖同名参数，保留其他参数与 hash；集合为空时原样返回）。副作用同 `getRequestHeaders`。 */
  appendVidsToUrl(url: string | URL): string;
  /** 全局 `fetch` 的薄封装：合并 `X-Super-AB-Vids` 后调用（同名头以 SDK 为准，不改 URL）。副作用同 `getRequestHeaders`。 */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface SuperSDKInstance {
  readonly sdkVersion: string;
  readonly experiment: ExperimentNamespace;
  readonly bridge: BridgeClient;
  readonly monitoring: MonitoringController;
  readonly pay: PayNamespace;
  readonly push: PushNamespace;
  init(config: InitConfig): void;
  initFallback(config: InitConfig): void;
  isFallbackMode(): boolean;
  isInApp(): boolean;
  getEnv(): Promise<Record<string, unknown> & { deviceId?: string }>;
  /**
   * 设置项目环境（web 降级模式生效；端内 reject UNSUPPORTED，环境由原生宿主控制）。
   * 非法值 reject INVALID_ARGUMENT；未初始化 reject NOT_INITIALIZED。
   */
  setAPIEnvironment(environment: string): Promise<void>;
  /** 获取当前项目环境；端内透传原生值，web 未初始化时返回 "prod"。 */
  getAPIEnvironment(): Promise<string>;
  getAppName(): Promise<string>;
  getAppIcon(): Promise<string>;
  getHostSettings<T = Record<string, unknown>>(configName?: string, params?: Record<string, unknown>): Promise<T>;
  getHostSettingsByKey<T = unknown>(key: string, configName?: string, params?: Record<string, unknown>): Promise<T | null>;
  clearSettingsCache(): void;
  setAnalyticsConsent(consent: AnalyticsConsent): Promise<void>;
  getAnalyticsConsent(): AnalyticsConsent;
  addEventCommonParam(key: string, value: unknown): void;
  addEventCommonParams(values: Record<string, unknown>): void;
  reportEvent(name: string, params?: Record<string, unknown>): Promise<QueuedEvent | unknown>;
  /**
   * 提交用户反馈（CA-F260916-user-feedback）。端内经 JSB 由 Native 补齐 spid/env/设备/版本后上报；
   * web 需先 `init()` 提供 baseUrls + spid。`userId` 由调用方按次传入（SDK 不维护用户身份）。
   * 校验失败抛 INVALID_ARGUMENT（web）/ INVALID_PARAMS（端内）。
   */
  submitFeedback(params: FeedbackParams): Promise<FeedbackReceipt>;
  flush(options?: { keepalive?: boolean }): Promise<FlushSummary>;
  getDeliveryState(): DeliveryState;
  onDiagnostic(listener: (diagnostic: Diagnostic) => void): () => void;
  /** 查询本运行时支持的 suenc 响应编码能力；据此决定是否发送 `suenc=1`。 */
  getSuEncCapabilities(): SuEncCapabilities;
  /**
   * 解码 suenc 响应体。`codec` 必须直接使用响应 `X-Su-Enc` header 的原始值，
   * 不接受自定义 table。未知 codec 抛 UNSUPPORTED_SUENC_CODEC，
   * 数据非法抛 SUENC_DECODE_FAILED，解码结果非合法 UTF-8 抛 SUENC_INVALID_UTF8。
   */
  decodeSuEnc(encodedData: string, codec: string): string;
  installGlobal(): SuperSDKInstance;

  callHostMethod(methodName: string, params?: Record<string, unknown>): Promise<unknown>;
  getAuthProviders(): Promise<string[]>;
  requestLogin(options: { provider: string }): Promise<unknown>;
  getAttribution(): Promise<unknown>;
  share(content: string): void;
  openPage(url: string, options?: { showTitleBar?: boolean }): void;
  openBrowser(url: string, title?: string): void;
  openExternal(url: string): void;
  openWithBrowser(url: string): void;
  closePage(): void;
  showToast(message: string): void;
  setStatusBarDarkMode(isDark: boolean): void;
  showKeyboard(selector?: string): void;
  requestShortUrl(url: string): Promise<string>;
  requestShortUrlWithHtml(html: string): Promise<string>;
  onBackPressed(callback: () => boolean): void;
  offBackPressed(): void;
  onForeground(callback: (data?: unknown) => void): void;
  onBackground(callback: (data?: unknown) => void): void;
  subscribe(event: string, callback: (data: unknown) => void): () => void;

  fileExists(path: string): Promise<{ exists: boolean; isFile: boolean; isDirectory: boolean }>;
  readFile(path: string): Promise<{ content: string }>;
  writeFile(path: string, content: string): Promise<unknown>;
  deleteFile(path: string): Promise<unknown>;
  createDir(path: string): Promise<unknown>;
  listDir(path: string): Promise<{ files: Array<{ name: string; isFile: boolean; isDirectory: boolean; size: number; lastModified: number }> }>;
  moveFile(source: string, destination: string): Promise<unknown>;
  unzipFile(source: string, destination: string): Promise<unknown>;
  zipDir(source: string, destination: string): Promise<unknown>;
  getFileMd5(path: string): Promise<{ md5: string }>;
  downloadFile(options: {
    url: string;
    savePath: string;
    headers?: Record<string, string>;
    onStart?: () => void;
    onProgress?: (progress: { progress: number; downloadedBytes: number; totalBytes: number }) => void;
    onSuccess?: (result: { filePath: string; downloadedBytes: number; totalBytes: number }) => void;
    onFail?: (result: { error: unknown }) => void;
  }): () => void;
  downloadWithCache(fileUrl: string, fileMd5?: string, cacheTts?: number, fileCacheKey?: string): Promise<{ filePath: string; cacheHit: boolean; cacheKey: string }>;

  showBannerAd(...args: unknown[]): Promise<unknown> | unknown;
  hideBannerAd(...args: unknown[]): Promise<unknown> | unknown;
  showInterstitialAd(...args: unknown[]): Promise<unknown>;
  showRewardAd(...args: unknown[]): Promise<unknown>;
  showRewardedInterstitialAd(...args: unknown[]): Promise<unknown>;
  publish(...args: unknown[]): unknown;
  getSafeArea(): Promise<unknown>;
  [nativeMethod: string]: unknown;
}

export interface CreateSuperSDKOptions {
  target?: typeof globalThis | Record<string, unknown>;
  fetch?: typeof globalThis.fetch;
  storage?: Storage;
  indexedDB?: IDBFactory;
  crypto?: Crypto;
  now?: () => number;
  random?: () => number;
  diagnosticSink?: (diagnostic: Diagnostic) => void;
  bridgeClock?: () => number;
  bridgeSetTimeout?: (handler: () => void, timeoutMs: number) => unknown;
  bridgeClearTimeout?: (timer: unknown) => void;
  monitoringSetTimeout?: (handler: () => void, timeoutMs: number) => unknown;
  monitoringClearTimeout?: (timer: unknown) => void;
}

export interface MonitoringBudgets { pageEnvelopes: number; sessionEnvelopes: number; bytesPerMinute: number; envelopeBytes: number; aggregationKeys: number; errorFingerprintsPerPage: number }
export interface MonitoringRemoteAdapter { deliver(envelope: MonitoringEnvelopeV1, context: { signal: AbortSignal }): void | Promise<void> }
export interface MonitoringStartOptions {
  budgets?: Partial<MonitoringBudgets>;
  sampleRates?: Partial<{ errors: number; performance: number }>;
  beforeSend?: (envelope: MonitoringEnvelopeV1) => MonitoringEnvelopeV1 | null;
  routeAdapter?: { subscribe(onRoute: () => void): () => void };
  remoteAdapter?: MonitoringRemoteAdapter | { kind: 'reportEventV2' };
}
export interface MonitoringState { readonly status: 'stopped'|'dormant'|'active'; readonly generation: number; readonly consent: MonitoringConsent; readonly runtimeSessionId: string|null; readonly activeCollectors: readonly string[]; readonly remoteStatus: 'disabled'|'ready'|'in_flight'|'blocked'|'degraded' }
export interface MonitoringSnapshot { readonly state: MonitoringState; readonly context: Readonly<Record<string, unknown>>|null; readonly aggregates: readonly Readonly<Record<string, unknown>>[]; readonly measurements: readonly Readonly<Record<string, unknown>>[]; readonly drops: Readonly<Record<string, number>>; readonly recent: readonly MonitoringEnvelopeV1[] }
export interface MonitoringController { start(options?: MonitoringStartOptions): MonitoringState; stop(): MonitoringState; getState(): MonitoringState; getSnapshot(): MonitoringSnapshot; onEnvelope(listener: (envelope: MonitoringEnvelopeV1) => void): () => void; setConsent(next: Partial<MonitoringConsent>): MonitoringConsent; getConsent(): MonitoringConsent }

export function createSuperSDK(options?: CreateSuperSDKOptions): SuperSDKInstance;
export function installGlobal(target?: typeof globalThis | Record<string, unknown>): SuperSDKInstance;
export const SDK_VERSION: string;

declare const SuperSDK: SuperSDKInstance;
export default SuperSDK;
