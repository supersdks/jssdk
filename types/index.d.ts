export type AnalyticsConsent = 'denied' | 'granted';

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
  | 'NETWORK_ERROR' | 'PROTOCOL_MISMATCH' | 'UNSUPPORTED';

export class SuperSDKError extends Error {
  readonly code: SuperSDKErrorCode;
  readonly retryable: boolean;
  readonly cause?: unknown;
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

export interface SuperSDKInstance {
  readonly sdkVersion: string;
  init(config: InitConfig): void;
  initFallback(config: InitConfig): void;
  isFallbackMode(): boolean;
  isInApp(): boolean;
  getEnv(): Promise<Record<string, unknown> & { deviceId?: string }>;
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
  flush(options?: { keepalive?: boolean }): Promise<FlushSummary>;
  getDeliveryState(): DeliveryState;
  onDiagnostic(listener: (diagnostic: Diagnostic) => void): () => void;
  installGlobal(): SuperSDKInstance;

  callHostMethod(methodName: string, params?: Record<string, unknown>): Promise<unknown>;
  getAuthProviders(): Promise<string[]>;
  requestLogin(provider: string, params?: Record<string, unknown>): Promise<unknown>;
  getAttribution(): Promise<unknown>;
  share(content: string): void;
  openPage(url: string, title?: string): void;
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

  fileExists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<unknown>;
  deleteFile(path: string): Promise<unknown>;
  createDir(path: string): Promise<unknown>;
  listDir(path: string): Promise<unknown[]>;
  moveFile(source: string, destination: string): Promise<unknown>;
  unzipFile(source: string, destination: string): Promise<unknown>;
  zipDir(source: string, destination: string): Promise<unknown>;
  getFileMd5(path: string): Promise<string>;
  downloadFile(url: string, destination?: string): Promise<unknown>;
  downloadWithCache(url: string, options?: Record<string, unknown>): Promise<unknown>;

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
}

export function createSuperSDK(options?: CreateSuperSDKOptions): SuperSDKInstance;
export function installGlobal(target?: typeof globalThis | Record<string, unknown>): SuperSDKInstance;
export const SDK_VERSION: string;

declare const SuperSDK: SuperSDKInstance;
export default SuperSDK;
