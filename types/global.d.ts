export * from './index.js';
export { default } from './index.js';

import type { SuperSDKInstance } from './index.js';

declare global {
  interface Window {
    SuperSDK: SuperSDKInstance;
    JSBridge: {
      subscribeHandler(eventType: string, eventKey: string, data: unknown): void;
      onBackPressed(): boolean;
    };
  }
}
