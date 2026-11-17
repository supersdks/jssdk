# @supersdk/jssdk

SuperSDK is one JavaScript runtime for ordinary browser projects and SuperSDK App containers. Browser projects can read public settings and report consented analytics; Hybrid projects keep the existing JSBridge API.

Version 2.0 adds a negotiated, typed low-level bridge without changing the observable runtime behavior of the legacy wrappers. Existing 1.x applications can stay pinned to 1.x while migrating TypeScript declarations.

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

## Frontend monitoring

Monitoring is disabled by default and uses consent independent from analytics. It works in ordinary browser projects without calling `init()` when envelopes are consumed locally:

```js
const unsubscribe = SuperSDK.monitoring.onEnvelope((envelope) => {
  // supersdk.monitoring.v1 contains bounded metadata only.
  console.log(envelope.signal, envelope.summary.count);
});

SuperSDK.monitoring.setConsent({ errors: 'granted', performance: 'granted' });
SuperSDK.monitoring.start();

const snapshot = SuperSDK.monitoring.getSnapshot();

SuperSDK.monitoring.stop();
unsubscribe();
```

Without an explicit remote adapter, monitoring never sends network requests. A custom adapter may be supplied with `start({ remoteAdapter })`; delivery is at most once, has a fixed five-second deadline and receives an `AbortSignal`. The built-in `{ kind: 'reportEventV2' }` adapter requires a valid prior `init()` and yields to pending analytics delivery. JSSDK remote delivery is blocked inside App containers because native business-queue state is not visible to JavaScript; local snapshots and subscribers continue to work.

The two monitoring categories default to `denied`. Revoking either category immediately removes its collectors and in-memory data without changing analytics consent, analytics identity or the business outbox. Envelopes expose only the generated `supersdk.monitoring.v1` allowlist: no raw error message, stack, URL, DOM/input, headers/body or JSB arguments/results. Protocol constants, types and validation are also exported from `@supersdk/jssdk/protocol`.

## Negotiated bridge

```js
import { createSuperSDK } from '@supersdk/jssdk';

const sdk = createSuperSDK({ target: window });
const state = await sdk.bridge.ready();
if (sdk.bridge.supports('getEnv')) {
  const environment = await sdk.bridge.request('getEnv', [], { timeoutMs: 5000 });
}

const stop = sdk.bridge.subscribe('system.onEnterForeground', (event) => {
  console.log(event.id);
});
stop();
sdk.bridge.dispose();
```

The five container states are `absent`, `legacy`, `negotiated`, `incompatible` and `degraded`. A declared but malformed bootstrap is `degraded`; it never silently falls back to legacy dispatch. `request()` and `openStream()` use native callback envelopes, while `command()` resolves after local synchronous dispatch and never waits for an invented acknowledgement.

Protocol data and the validator are exported from `@supersdk/jssdk/protocol`. Deterministic tests can use `createBridgeMock` from `@supersdk/jssdk/mock`. Application code cannot call the reserved `getBridgeManifest` bootstrap through `supports()`, `request()` or `command()`.

### 2.0 TypeScript migration

The 1.0 declarations disagreed with the already-published runtime in four places. Version 2.0 makes the declarations match the runtime bytes:

| API | 1.0 declaration | Runtime and 2.0 declaration |
| --- | --- | --- |
| `fileExists(path)` | `Promise<boolean>` | `Promise<{exists,isFile,isDirectory}>` |
| `readFile(path)` | `Promise<string>` | `Promise<{content:string}>` |
| `getFileMd5(path)` | `Promise<string>` | `Promise<{md5:string}>` |
| `downloadFile(...)` | URL arguments and `Promise` | options object and synchronous cancel function |

`listDir()` likewise resolves `{files:[...]}`, `downloadWithCache()` keeps its positional runtime arguments, `requestLogin()` accepts `{provider}`, and `openPage()` accepts an options object. These are intentional source-level type breaks in the 2.0 major; runtime wrapper wire and timing remain compatible with 1.0.

## Native-only methods

Payment, native login, ads, file access, offline packages, native blocks, app navigation and host-defined methods still require a SuperSDK App container. Importing this package does not emulate those capabilities in a browser.

Low-level bridge failures reject `SuperSDKError` with stable codes including `BRIDGE_ABSENT`, `BRIDGE_INCOMPATIBLE`, `BRIDGE_DEGRADED`, `BRIDGE_ERROR`, `CANCELLED`, `TIMEOUT` and `DISPOSED`. Unknown non-empty provider codes become `BRIDGE_ERROR` with `nativeCode: "UNKNOWN"`; malformed envelopes become `PROTOCOL_MISMATCH`.

## Privacy and trust

Browser analytics data is anonymous/untrusted input and must not be used for authentication, billing or security decisions. Denying or revoking analytics removes SDK-owned persistent identity and pending browser events. Diagnostics never include event parameters, settings bodies, URL query/hash, request headers, spid or device ID values.

## Support

- Node: 18+
- Browser build target: ES2020
- Runtime dependencies: none
- License: MIT
