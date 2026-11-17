export type BridgeStatus = 'absent' | 'legacy' | 'negotiated' | 'incompatible' | 'degraded';
export type BridgeMethodKind = 'request' | 'command' | 'stream';
export type JsonWire = string;

export interface BridgeState {
  readonly status: BridgeStatus;
  readonly generation: number;
  readonly protocolVersion: Readonly<{ major: number; minor: number }> | null;
  readonly container: Readonly<{ platform: 'android' | 'ios'; sdkVersion: string }> | null;
  readonly reasonCode: string | null;
  readonly disposed: boolean;
}

export interface BridgeMethodContract<A extends readonly unknown[], R, K extends BridgeMethodKind, P = never> {
  readonly args: A;
  readonly result: R;
  readonly kind: K;
  readonly progress: P;
}

type Request<A extends readonly unknown[], R = unknown> = BridgeMethodContract<A, R, 'request'>;
type Command<A extends readonly unknown[]> = BridgeMethodContract<A, void, 'command'>;
type Stream<A extends readonly unknown[], P = unknown, R = unknown> = BridgeMethodContract<A, R, 'stream', P>;

export interface BridgeMethodMap {
  addEventCommonParam: Command<[key: string, value: string]>;
  callHostMethod: Request<[methodName: string, paramsJson: JsonWire]>;
  cancelDownload: Command<[callbackId: string]>;
  closePage: Command<[]>;
  createDir: Request<[path: string], void>;
  createNativeBlock: Request<[blockId: string, blockType: string, configJson: JsonWire]>;
  deleteFile: Request<[path: string], void>;
  destroyAllNativeBlocks: Command<[]>;
  destroyNativeBlock: Command<[blockId: string]>;
  downloadFile: Stream<[url: string, headersJson: JsonWire, savePath: string], { status: 'START' | 'PROGRESS'; progress?: number; downloadedBytes?: number; totalBytes?: number }, { status: 'SUCCESS'; filePath: string; downloadedBytes?: number; totalBytes?: number }>;
  downloadWithCache: Request<[fileUrl: string, fileMd5?: string, cacheTts?: number, fileCacheKey?: string]>;
  fileExists: Request<[path: string], { exists: boolean; isFile: boolean; isDirectory: boolean }>;
  getAppIcon: Request<[], { base64: string }>;
  getAppName: Request<[], { appName: string }>;
  getAttribution: Request<[onlyFirst?: boolean]>;
  getAuthProviders: Request<[], { providers: string[] }>;
  getEnv: Request<[], Record<string, unknown>>;
  getFileMd5: Request<[path: string], { md5: string }>;
  getHostSettings: Request<[]>;
  getHostSettingsByConfigNameAndKey: Request<[configName: string, key: string]>;
  getHostSettingsByConfigName: Request<[configName: string]>;
  getHostSettingsByKey: Request<[key: string]>;
  getPayProviders: Request<[]>;
  hideBannerAd: Request<[adId: string], void>;
  listDir: Request<[path: string], { files: unknown[] }>;
  moveFile: Request<[srcPath: string, destPath: string], void>;
  nativePay: Request<[provider: string, paramsJson: JsonWire]>;
  onJSBridgeReady: Command<[]>;
  openBrowser: Command<[url: string, title?: string]>;
  openExternal: Command<[url: string]>;
  openPage: Command<[url: string, configJson: JsonWire]>;
  openWithBrowser: Command<[url: string]>;
  publishToWebView: Command<[target: string, event: string, jsonContent: JsonWire]>;
  pushGetStatus: Request<[], PushStatusWire>;
  pushRequestPermission: Request<[], { permission: PushPermission }>;
  pushSetTags: Request<[tagsJson: JsonWire], Record<string, never>>;
  pushSetUserId: Request<[userId?: string], Record<string, never>>;
  querySubscriptionOffers: Request<[provider: string, productIdsJson: JsonWire]>;
  readFile: Request<[path: string], { content: string }>;
  reportEvent: Request<[eventName: string, paramsJson: JsonWire]>;
  requestLogin: Request<[provider: string]>;
  requestShortUrl: Request<[paramsJson: JsonWire], { shortUrl: string }>;
  requestShortUrlWithHtml: Request<[paramsJson: JsonWire], { shortUrl: string }>;
  restorePurchases: Request<[provider?: string]>;
  setStatusBarDarkMode: Command<[isDark: boolean]>;
  share: Command<[content: string]>;
  showBannerAd: Request<[optionsJson: JsonWire]>;
  showInterstitialAd: Request<[optionsJson: JsonWire]>;
  showKeyboard: Command<[selector?: string]>;
  showRewardAd: Request<[optionsJson: JsonWire]>;
  showRewardedInterstitialAd: Request<[optionsJson: JsonWire]>;
  showToast: Command<[message: string]>;
  submitFeedback: Request<[paramsJson: JsonWire], { feedbackId: number }>;
  unzipFile: Request<[zipPath: string, destPath: string], void>;
  updateNativeBlockPosition: Command<[blockId: string, positionJson: JsonWire]>;
  writeFile: Request<[path: string, content: string], void>;
  zipDir: Request<[sourcePath: string, zipPath: string], void>;
}

export interface BridgeEventEnvelope<T = unknown> { readonly type: string; readonly id: string; readonly data: T }
export interface BridgeEventMap {
  broadcast: BridgeEventEnvelope;
  webviewMessage: BridgeEventEnvelope;
  'system.onEnterForeground': BridgeEventEnvelope;
  'system.onEnterBackground': BridgeEventEnvelope;
  'push.message': BridgeEventEnvelope<PushMessagePayload>;
  'push.opened': BridgeEventEnvelope<PushOpenedPayload>;
}

export type PushPermission = 'granted' | 'denied' | 'prompt';

/** `push.message` 载荷（PushMessage.toJson · camelCase · data 为 FCM data 原键透传） */
export interface PushMessagePayload {
  readonly messageId?: string;
  readonly title?: string;
  readonly body?: string;
  readonly imageUrl?: string;
  readonly url?: string;
  readonly clickType?: 'open_app' | 'open_url';
  readonly data: Readonly<Record<string, string>>;
}

/** `push.opened` 载荷 / `getStatus().lastOpened`（verified=false 表示回执不可达的降级路径，url 为 intent 原值） */
export interface PushOpenedPayload {
  readonly messageId: string;
  readonly url?: string;
  readonly clickType: 'open_app' | 'open_url';
  readonly openedAt: number;
  readonly verified: boolean;
}

/** `pushGetStatus` 成功 data（Native PushStatus.toJson） */
export interface PushStatusWire {
  readonly supported: boolean;
  readonly permission?: PushPermission;
  readonly registered?: boolean;
  readonly lastError?: 'TOKEN_UNAVAILABLE' | 'NOT_FOUND' | 'INVALID_REQUEST' | 'RATE_LIMITED' | 'NETWORK_ERROR' | 'UNAVAILABLE';
  readonly lastOpened?: PushOpenedPayload;
}

export interface BridgeProtocolData {
  readonly schema: 'supersdk.jsb.idl';
  readonly protocolVersion: Readonly<{ major: number; minor: number }>;
  readonly methods: readonly Readonly<Record<string, unknown>>[];
  readonly events: readonly Readonly<Record<string, unknown>>[];
}

export const BRIDGE_PROTOCOL: BridgeProtocolData;
export const BRIDGE_GOLDEN_VECTORS: Readonly<Record<string, unknown>>;
export const BRIDGE_CONTRACT_SHA256: string;
export function getMethodDefinition(id: string): Readonly<Record<string, unknown>> | null;
export function getEventDefinition(id: string): Readonly<Record<string, unknown>> | null;
export function mapNativeErrorCode(nativeCode: unknown): Readonly<{ code: string; nativeCode?: string; retryable: boolean }>;
export class BridgeManifestError extends Error { readonly reasonCode: string }
export function validateBridgeManifest(input: string): Readonly<Record<string, unknown>>;
export * from './monitoring-contract.js';
