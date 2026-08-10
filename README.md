# @supersdk/jssdk

SuperSDK is one JavaScript runtime for ordinary browser projects and SuperSDK App containers. Browser projects can read public settings and report consented analytics; Hybrid projects keep the existing JSBridge API.

## Install

```bash
npm install @supersdk/jssdk
```

## Browser module

```js
import SuperSDK from '@supersdk/jssdk';

SuperSDK.init({
  spid: 'ab12cd34',
  environment: 'prod',
  analyticsConsent: 'denied'
});

const settings = await SuperSDK.getHostSettings('homepage');

await SuperSDK.setAnalyticsConsent('granted');
const queued = await SuperSDK.reportEvent('page_open', { page: 'home' });
const delivery = await SuperSDK.flush();
```

`reportEvent()` resolves after a bounded local enqueue. Use `flush()`, `getDeliveryState()` or `onDiagnostic()` to observe delivery. Analytics consent defaults to `denied`; settings remain available while analytics is denied.

Settings failures reject `SuperSDKError` with stable codes: `INVALID_ARGUMENT`, `RATE_LIMITED`, `UNAVAILABLE`, `TIMEOUT` or `NETWORK_ERROR`. A transient failure returns an in-page last-known-good value when one exists.

## Isolated instances

```js
import { createSuperSDK } from '@supersdk/jssdk';

const sdk = createSuperSDK();
sdk.init({ spid: 'ab12cd34' });
```

## Traditional global entry

```html
<script src="./node_modules/@supersdk/jssdk/dist/supersdk.js"></script>
<script>
  SuperSDK.init({ spid: 'ab12cd34' });
</script>
```

Bundlers may explicitly import `@supersdk/jssdk/global`. The root ESM/CommonJS entry never installs `SuperSDK` or `JSBridge` on the global object.

`initFallback(config)` remains a compatibility alias of `init(config)`. Existing `addEventCommonParam(key, value)` remains supported; Web projects may also call `addEventCommonParams(object)`.

## Native-only methods

Payment, native login, ads, file access, offline packages, native blocks, app navigation and host-defined methods still require a SuperSDK App container. Importing this package does not emulate those capabilities in a browser.

## Privacy and trust

Browser analytics data is anonymous/untrusted input and must not be used for authentication, billing or security decisions. Denying or revoking analytics removes SDK-owned persistent identity and pending browser events. Diagnostics never include event parameters, settings bodies, URL query/hash, request headers, spid or device ID values.

## Support

- Node: 18+
- Browser build target: ES2020
- Runtime dependencies: none
- License: MIT
