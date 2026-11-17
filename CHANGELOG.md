# Changelog

## 3.0.1-SNAPSHOT - 2026-11-18

- First npm publication since `1.0.0` (dist-tag `next`). Carries everything previously shipped only as a vendored `supersdk.js` in the 2.x line. No runtime change from `3.0.0-SNAPSHOT` other than the reported `sdkVersion`.

## 3.0.0-SNAPSHOT - 2026-11-18 (not published to npm)

- Version line unified with the Android and iOS SDKs: all three now share one three-segment version taken from the monorepo's `vars.properties` (`SDK_VERSION`), starting at `3.0.0`. Test builds are published to the `next` dist-tag as `x.y.z-SNAPSHOT`; every release, test or stable, takes the next patch number.
- No runtime behaviour change from `2.8.0` other than the reported `sdkVersion`.

## 2.8.0 - 2026-11-17

- Experiment emergency stop (WS-12-S5). Keys listed in the `emergency_stopped` of an accepted full assign response (not `not_modified`, not one dropped for a lower `rules_version`; applied after `live_vids` pruning, same as Android / iOS) leave the page's freeze table and read as not participating (`reason: 'paused'`, the caller's default payload) for the rest of the page session, with no exposure; their vids leave the exposed set, so later events' `exp_vids` and `getRequestHeaders()` / `appendVidsToUrl()` / `fetch()` no longer carry them (the same outcome as `live_vids` pruning). One diagnostic per key (`experiment` / `EMERGENCY_STOPPED`, `state: 'frozen' | 'unread'`, `discarded`). A key that is assigned again later in the same page (experiment resumed) stays stopped until the next page session.
- In-app delegated mode: when native answers a mirrored or frozen key as not participating with `reason: 'paused'` (through `getExperiment` or a `refresh()` / `getAllExperiments` reload), the page's entry adopts that value and its vid leaves the mirrored exposed set; other changes to a frozen key still keep the page's frozen value.
- `rollout` results (unchanged, now covered by tests): participating, never exposed, never in `exp_vids` or the request vids.

## 2.7.0 - 2026-11-17

- Server-side experiments (WS-12-S6). Assign results now keep both `client` and `server` experiments; `getAll()` items carry `type`. `get(key)` on a `server` experiment returns not-participating with `reason: 'unknown'`, without freezing or exposing (diagnostic `experiment` / `SERVER_EXPERIMENT_READ`, once per key).
- New synchronous `SuperSDK.experiment.getRequestHeaders()` → `{ 'X-Super-AB-Vids': '<vids>' }` (`{}` when the exposed set is empty), `appendVidsToUrl(url)` (sets / overwrites `super_ab_vids`, keeps other params, hash and relative form; unchanged when empty) and `fetch(input, init?)` (global `fetch` with the header merged; SDK value wins over a same-name caller header; works with `Headers`, arrays, plain objects and `Request` input). Each call first treats every assigned `server` experiment in the loaded namespaces as read: frozen for the session, `$exp_exposure` reported once (usual dedupe), vid added to the exposed set (the same set as `exp_vids`).
- Web-path SDK requests to the platform that are already CORS-preflighted JSON POSTs (assign, analytics upload, monitoring, feedback) carry `X-Super-AB-Vids` with the current exposed set only (omitted when empty); they never trigger the server-experiment side effect. The CORS-simple settings GET does not carry it (no extra preflight).
- In-app delegated mode: `getAllExperiments` items gain `type` / `exposed`; the three methods compute the value synchronously from the mirror (empty before `ready()`, native not called) and call the new shared JSB method `getExperimentRequestVids(callbackId, paramsJson)` → `{ vids }` asynchronously so native freezes and exposes (`source: "h5"`), adopting native's set (`experiment_native` / `NATIVE_RESULT_MISMATCH` on mismatch). The method is optional: containers without it get the mirror-only value (`REQUEST_VIDS_UNSUPPORTED` once). Bridge protocol now has 63 methods.

## 2.6.0 - 2026-11-17

- In-app `SuperSDK.experiment` delegates to native (WS-12-S2) when the container declares the five new shared JSB methods `experimentReady`, `getAllExperiments`, `getExperiment`, `exposeExperiment` and `setExperimentAttributes` (all `(callbackId, paramsJson)` requests; bridge protocol now has 62 methods). In that mode native fetches, freezes (shared with native code and other WebViews) and reports `$exp_exposure` with `source: "h5"`; the JSSDK sends no assign request, reports no exposure and attaches no `exp_vids` (native stamps it on events created from H5 `reportEvent`). `ready()` mirrors native results via `experimentReady` + `getAllExperiments`; `get()` stays synchronous, reads the mirror and asks native asynchronously, adopting native's frozen value (diagnostic `experiment_native` / `NATIVE_RESULT_MISMATCH` when they differ); a read before `ready()` returns `no_result` and stays frozen for the page without notifying native; `refresh()` re-reads native's results. Older containers keep the 2.5.0 web path.

## 2.5.0 - 2026-11-17

- Add the `SuperSDK.experiment` namespace (A/B experiments, WS-12-S1): `ready({ timeoutMs?, namespaces? })` (resolves when this page's first assign fetch settles or after `timeoutMs`, default 2000), synchronous `get(key, { expose?, default? })` → `{ inExperiment, variant, vid, payload, reason }`, `expose(key)`, `getAll()` (diagnostic: no freeze, no exposure), `refresh()` and `setAttributes(map)` (`attr.*`, debounced refetch). The SDK fetches the device's assignment list from `POST {baseUrl}/v2/experiments/assign` (base URL rotation + suenc decoding; `known_version` only when attributes and namespaces are unchanged since the last success; lower `rules_version` responses dropped; results older than `stale_after_sec` count as `no_result`), stores it in `localStorage` per spid + environment + device id, freezes each key on its first read for the page session, and reports `$exp_exposure` on read (deduped per session and per calendar day; `rollout` never exposed). Analytics consent gates everything: `denied` → no request and `reason: 'no_subject'`; revoking clears the stored results and exposed set. In-app the same web path is used with the device id from the native `getEnv()` (fetched on first experiment API use).
- Every analytics event now carries the SDK-owned `exp_vids` param (ascending, comma-joined exposed vids, at most 500) captured when the event is created, not when it is uploaded; the set is pruned with the assign response's `live_vids`. Caller-supplied `exp_vids` (event params or common params) is ignored. `protocol/experiment-v1.json` and `protocol/experiment-v1-golden.json` ship in the package.

## 2.4.0 - 2026-10-11

- Add the `SuperSDK.push` namespace: `getStatus()` (`{ supported, permission, registered, lastError?, lastOpened? }`; `lastOpened` is consumed by the first `getStatus()` that reads it), `requestPermission()` (interactive, 120s callback timeout), `setTags(tags)` / `setUserId(userId)` (`null` / empty clears; bounds are validated by the native container and surface as `INVALID_ARGUMENT`), and `onMessage(cb)` / `onOpened(cb)` as aliases of `subscribe('push.message' | 'push.opened')` returning an unsubscribe function. In the browser `getStatus()` resolves `{ supported: false }` and the other methods reject `NOT_SUPPORTED` without throwing synchronously; containers that answer `NOT_SUPPORTED` / `NOT_IMPLEMENTED` (unwired host, iOS stub) also yield `{ supported: false }` from `getStatus()` and `UNSUPPORTED` elsewhere. Android requires the optional `supersdk-push-firebase` module.
- Bridge protocol manifest grows to 57 methods (`pushGetStatus` / `pushRequestPermission` / `pushSetTags` / `pushSetUserId`) and 6 events (`push.message` / `push.opened`, BROADCAST); the native code registry maps `NO_ACTIVITY` to `UNAVAILABLE` (retryable). `protocol/push-v1.json` ships the Day-0 push HTTP contract fixture; `@supersdk/jssdk/protocol` typings gain `PushStatusWire` / `PushMessagePayload` / `PushOpenedPayload`.

## 2.3.0 - 2026-09-16

- Add `submitFeedback(params)` (`{ scene, subScene?, title, content, userId?, extra? }` → `{ feedbackId }`). In-app it calls the new shared JSB `submitFeedback(callbackId, paramsJson)` and the native container fills `spid / env / device_id / platform / versions` before posting to `/superapi/v2/feedback`; on the web runtime the SDK posts the snake_case wire body directly with `X-Aid` / `X-Super-API-ENV`, rotates base URLs only on transient failures, reads the envelope through the suenc-aware decoder and surfaces server business rejections as `INVALID_ARGUMENT` with `nativeCode`. Submissions are visible in the console under 业务运营 → 用户反馈.
- Bridge protocol manifest grows to 53 methods (`submitFeedback`); `@supersdk/jssdk/protocol` typings gain `FeedbackParams` / `FeedbackReceipt`.

## 2.2.0 - 2026-09-02

- Add `pay.querySubscriptionOffers(options)` (Google Play eligible subscription offers) on the shared JSB.

## 2.1.0 - 2026-08-15

- Add `setAPIEnvironment(environment)` / `getAPIEnvironment()`. In web fallback mode the setter validates `^[a-z0-9]{1,10}$`, flushes pending analytics under the old environment before switching, and subsequent settings fetches and event reports use the new value; settings request caching is already keyed by environment, so entries never leak across environments. In-app the setter rejects with `UNSUPPORTED` (the environment is controlled by the native host via `SuperSDK.setAPIEnvironment`) and the getter passes through the native value.

## 2.0.0 - 2026-08-10

- Add the versioned JSB IDL, golden vectors, deterministic generator and `protocol`/`mock` package exports.
- Add five-state bridge discovery plus typed request, local-dispatch command, stream, subscription, deadline, abort and dispose lifecycles.
- Add a target-scoped callback hub with owner isolation, foreign-handler delegation, identity-drift cleanup and compare-and-swap restoration.
- Map native errors through one public registry and restrict diagnostics to bounded metadata.
- Add opt-in frontend/container monitoring with independent consent, bounded local snapshots/subscribers, generated `supersdk.monitoring.v1` contracts and no implicit network delivery.
- Correct TypeScript declarations for file results, downloads, directory listing, login and navigation. These declaration corrections are the intentional 2.0 source break; legacy runtime wrappers remain behavior-compatible.
- Publish stable builds to the `candidate` tag first; promotion to `latest` is a separately approved exact-artifact workflow.

## 1.0.0 - 2026-08-09

- Publish environment-neutral ESM, CommonJS, TypeScript and explicit global entries.
- Add browser settings with stable errors, request coalescing and in-memory last-known-good fallback.
- Add consent-gated analytics with a bounded IndexedDB/memory outbox, 207 reconciliation and explicit flush diagnostics.
- Preserve the existing Hybrid `window.SuperSDK`, `window.JSBridge` and native wrapper surface.
