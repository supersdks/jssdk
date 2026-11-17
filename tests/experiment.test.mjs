import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSuperSDK } from '../src/index.js';
import { EXPERIMENT_CONTRACT } from '../src/experiment/contract.js';
import { createBridgeMock } from '../src/mock.js';
import { BRIDGE_PROTOCOL } from '../src/protocol.js';
import { EXPERIMENT_BRIDGE_METHODS } from '../src/experiment/native.js';
import { createTarget, memoryStorage, response, deferred, assertSDKError } from './helpers.mjs';

// WS-12-S1 · SuperSDK.experiment（docs/architecture/experiment-s1-impl-spec.md §5）。
// assign 由 fetch 路由假装服务端；事件经真实 reporter 入队后 flush，断言落到 /v2/reportEvent 的 event_param。

const packageRoot = resolve(import.meta.dirname, '..');
const DAY = 24 * 60 * 60 * 1000;
const SPID = 'ab12cd34';

function assignment(key, vid, extra = {}) {
  return {
    key, vid, run: 1, version: 3, type: 'client', namespace: 'default',
    variant: `v${vid}`, payload: { price: String(vid) }, layer_key: `l_${key}`, reason: 'alloc', ...extra
  };
}

function ok(data) {
  return response(200, { code: 'SUCCESS', data });
}

function body(rulesVersion, assignments, liveVids = assignments.map((item) => item.vid)) {
  return { rules_version: rulesVersion, not_modified: false, stale_after_sec: 604800, assignments, live_vids: liveVids, emergency_stopped: [] };
}

/**
 * assign: (requestBody, index) => Response | Promise<Response>. Events are captured from
 * /v2/reportEvent batches.
 */
function harness({ assign, storage = memoryStorage(), clock = { now: Date.parse('2026-11-17T10:00:00') }, consent = 'granted', diagnostics } = {}) {
  const assignRequests = [];
  const events = [];
  const target = createTarget(async (url, options) => {
    const payload = JSON.parse(options.body);
    if (url.endsWith('/v2/experiments/assign')) {
      assignRequests.push({ url, headers: options.headers, body: payload });
      return assign(payload, assignRequests.length);
    }
    events.push(...payload.events);
    return response(200, { code: 'SUCCESS' });
  }, storage);
  target.navigator = { userAgent: '', language: 'en-US' };
  const sdk = createSuperSDK({ target, now: () => clock.now, diagnosticSink: diagnostics });
  sdk.init({ spid: SPID, environment: 'prod', analyticsConsent: consent, deviceId: 'dev-1' });
  return { sdk, target, storage, clock, assignRequests, events };
}

/** Negotiated manifest of a container that does not declare `excluded` (an older container). */
function manifestWithout(excluded) {
  return {
    schema: BRIDGE_PROTOCOL.manifestSchema,
    protocolVersion: BRIDGE_PROTOCOL.protocolVersion,
    container: { platform: 'android', sdkVersion: 'old' },
    methods: BRIDGE_PROTOCOL.methods.filter(({ id }) => !excluded.includes(id)).map(({ id, kind, args, result }) => ({ id, kind, args, result })),
    events: BRIDGE_PROTOCOL.events.map(({ id, payload }) => ({ id, payload }))
  };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await new Promise(setImmediate);
}

async function flushEvents(h) {
  await settle();
  await h.sdk.flush();
  return h.events;
}

function experimentKeys(storage) {
  return Object.keys(storage.snapshot()).filter((key) => key.startsWith('supersdk_exp_v1'));
}

test('contract_constants_mirror_protocol_experiment_v1_json', async function contract_constants_mirror_protocol_experiment_v1_json() {
  const contract = JSON.parse(await readFile(resolve(packageRoot, 'protocol/experiment-v1.json'), 'utf8'));
  assert.equal(EXPERIMENT_CONTRACT.contract, contract.contract);
  assert.equal(EXPERIMENT_CONTRACT.defaultNamespace, contract.default_namespace);
  assert.equal(EXPERIMENT_CONTRACT.namespacePattern.source, contract.namespace_pattern);
  assert.equal(EXPERIMENT_CONTRACT.namespacesPerRequest, contract.limits.namespaces_per_request);
  assert.equal(EXPERIMENT_CONTRACT.customAttributesMax, contract.limits.custom_attributes_max);
  assert.equal(EXPERIMENT_CONTRACT.attributeKeyMaxChars, contract.limits.attribute_key_max_chars);
  assert.equal(EXPERIMENT_CONTRACT.attributeValueMaxChars, contract.limits.attribute_value_max_chars);
  assert.equal(EXPERIMENT_CONTRACT.customPrefix, contract.audience.custom_prefix);
  assert.equal(EXPERIMENT_CONTRACT.expVidsMax, contract.limits.exp_vids_max);
  assert.equal(EXPERIMENT_CONTRACT.staleAfterSec, contract.stale_after_sec);
  assert.equal(EXPERIMENT_CONTRACT.exposureEvent, contract.exposure_event);
  assert.equal(EXPERIMENT_CONTRACT.eventParam, contract.event_param);
  assert.equal(EXPERIMENT_CONTRACT.header, contract.header);
  assert.equal(EXPERIMENT_CONTRACT.queryParam, contract.query_param);
  assert.ok(contract.assign.ss_paths.includes('/superapi/v2/experiments/assign'));
});

test('assign_request_shape_and_first_fetch_on_configure', async function assign_request_shape_and_first_fetch_on_configure() {
  const h = harness({ assign: () => ok(body(1, [])) });
  await h.sdk.experiment.ready();
  assert.equal(h.assignRequests.length, 1);
  const [request] = h.assignRequests;
  assert.equal(request.url, 'https://api.supersdk.com/superapi/v2/experiments/assign');
  assert.equal(request.headers['X-Aid'], SPID);
  assert.equal(request.headers['X-Super-API-ENV'], 'prod');
  assert.deepEqual(request.body, {
    spid: SPID, env: 'prod', device_id: 'dev-1', namespaces: ['default'], side: 'client',
    attributes: { platform: 'web', language: 'en-US' }
  });
});

test('get_freezes_first_read_for_the_page_session_including_non_participation', async function get_freezes_first_read_for_the_page_session_including_non_participation() {
  const gate = deferred();
  let round = 0;
  const h = harness({
    assign: async () => {
      round += 1;
      if (round === 1) { await gate.promise; return ok(body(1, [assignment('paywall', 101), assignment('late', 301)])); }
      return ok(body(2, [assignment('paywall', 102, { variant: 'b' }), assignment('banner', 201), assignment('late', 301)]));
    }
  });
  // Read before any result arrived: default value, frozen for the session.
  const early = h.sdk.experiment.get('late', { default: { price: '9.9' } });
  assert.deepEqual({ ...early }, { inExperiment: false, variant: '', vid: null, payload: { price: '9.9' }, reason: 'no_result' });
  gate.resolve();
  await h.sdk.experiment.ready();

  const first = h.sdk.experiment.get('paywall');
  assert.deepEqual({ ...first }, { inExperiment: true, variant: 'v101', vid: 101, payload: { price: '101' }, reason: 'alloc' });
  assert.equal(h.sdk.experiment.get('late').reason, 'no_result', 'a key read before results arrived keeps its default');
  assert.equal(h.sdk.experiment.get('missing').reason, 'unknown');

  await h.sdk.experiment.refresh();
  assert.equal(h.sdk.experiment.get('paywall').variant, 'v101', 'frozen key ignores newer results');
  assert.equal(h.sdk.experiment.get('banner').vid, 201, 'unread key takes the newer result');
  assert.equal(h.sdk.experiment.get('missing').reason, 'unknown');
  // getAll is diagnostic: frozen keys report the frozen value, nothing is frozen by it.
  const all = h.sdk.experiment.getAll();
  assert.equal(all.paywall.vid, 101);
  assert.equal(all.late.reason, 'no_result');

  // The returned payload is a copy.
  first.payload.price = 'mutated';
  assert.equal(h.sdk.experiment.get('paywall').payload.price, '101');

  // A new page session (same storage) uses the stored newest results.
  const next = harness({ assign: () => new Promise(() => {}), storage: h.storage, clock: h.clock });
  assert.equal(next.sdk.experiment.get('paywall').vid, 102);
});

test('read_is_exposure_deduped_per_session_and_per_calendar_day', async function read_is_exposure_deduped_per_session_and_per_calendar_day() {
  const assign = () => ok(body(7, [assignment('paywall', 101)]));
  const h = harness({ assign });
  await h.sdk.experiment.ready();
  h.sdk.experiment.get('paywall');
  h.sdk.experiment.get('paywall');
  h.sdk.experiment.expose('paywall');
  const events = await flushEvents(h);
  const exposures = events.filter((event) => event.event_name === '$exp_exposure');
  assert.equal(exposures.length, 1);
  const param = exposures[0].event_param;
  assert.deepEqual({
    vid: param.vid, exp_key: param.exp_key, exp_run: param.exp_run, exp_version: param.exp_version,
    variant: param.variant, layer_key: param.layer_key, reason: param.reason, rules_version: param.rules_version, source: param.source
  }, {
    vid: 101, exp_key: 'paywall', exp_run: 1, exp_version: 3, variant: 'v101', layer_key: 'l_paywall',
    reason: 'alloc', rules_version: 7, source: 'web'
  });

  // Same day, new page session: the persisted day mark suppresses the exposure.
  const sameDay = harness({ assign, storage: h.storage, clock: h.clock });
  await sameDay.sdk.experiment.ready();
  sameDay.sdk.experiment.get('paywall');
  assert.equal((await flushEvents(sameDay)).filter((event) => event.event_name === '$exp_exposure').length, 0);

  // Next calendar day: exposed again once.
  h.clock.now += DAY;
  const nextDay = harness({ assign, storage: h.storage, clock: h.clock });
  await nextDay.sdk.experiment.ready();
  nextDay.sdk.experiment.get('paywall');
  nextDay.sdk.experiment.get('paywall');
  assert.equal((await flushEvents(nextDay)).filter((event) => event.event_name === '$exp_exposure').length, 1);
});

test('non_participation_and_rollout_never_expose', async function non_participation_and_rollout_never_expose() {
  const h = harness({ assign: () => ok(body(3, [assignment('winner', 501, { reason: 'rollout' })])) });
  await h.sdk.experiment.ready();
  const rolled = h.sdk.experiment.get('winner');
  assert.equal(rolled.inExperiment, true);
  assert.equal(rolled.reason, 'rollout');
  assert.equal(h.sdk.experiment.get('absent').inExperiment, false);
  await h.sdk.reportEvent('after');
  const events = await flushEvents(h);
  assert.equal(events.filter((event) => event.event_name === '$exp_exposure').length, 0);
  assert.equal(events.find((event) => event.event_name === 'after').event_param.exp_vids, undefined);
});

test('expose_false_reads_and_freezes_then_expose_reports_once', async function expose_false_reads_and_freezes_then_expose_reports_once() {
  let round = 0;
  const h = harness({
    assign: () => {
      round += 1;
      return ok(round === 1 ? body(1, [assignment('preload', 101)]) : body(2, [assignment('preload', 102)]));
    }
  });
  await h.sdk.experiment.ready();
  assert.equal(h.sdk.experiment.get('preload', { expose: false }).vid, 101);
  h.sdk.experiment.expose('never_read');
  assert.equal((await flushEvents(h)).length, 0, 'expose:false and unread keys report nothing');

  await h.sdk.experiment.refresh();
  h.sdk.experiment.expose('preload');
  h.sdk.experiment.expose('preload');
  const exposures = (await flushEvents(h)).filter((event) => event.event_name === '$exp_exposure');
  assert.equal(exposures.length, 1);
  assert.equal(exposures[0].event_param.vid, 101, 'the exposure is the frozen variant, not the newer result');
  assert.equal(exposures[0].event_param.rules_version, 1);
});

test('exp_vids_is_taken_at_event_creation_time_sorted_and_sdk_owned', async function exp_vids_is_taken_at_event_creation_time_sorted_and_sdk_owned() {
  const h = harness({ assign: () => ok(body(1, [assignment('b_exp', 205), assignment('a_exp', 101)])) });
  await h.sdk.experiment.ready();
  await h.sdk.reportEvent('before', { exp_vids: 'spoofed' });
  h.sdk.addEventCommonParam('exp_vids', 'spoofed');
  h.sdk.experiment.get('b_exp');
  const middle = h.sdk.reportEvent('middle');
  h.sdk.experiment.get('a_exp');
  await h.sdk.reportEvent('after', { exp_vids: 'spoofed' });
  await middle;
  const events = await flushEvents(h);
  const byName = (name) => events.filter((event) => event.event_name === name).map((event) => event.event_param.exp_vids);
  assert.deepEqual(byName('before'), [undefined], 'created before any exposure: no exp_vids, caller value dropped');
  assert.deepEqual(byName('middle'), ['205']);
  assert.deepEqual(byName('after'), ['101,205'], 'ascending, comma-joined');
  assert.deepEqual(byName('$exp_exposure'), [undefined, '205'], 'an exposure carries the set as it was before its own vid');
});

test('exp_vids_snapshot_survives_upload_after_a_later_exposure', async function exp_vids_snapshot_survives_upload_after_a_later_exposure() {
  const h = harness({ assign: () => ok(body(1, [assignment('paywall', 101)])) });
  await h.sdk.experiment.ready();
  await h.sdk.reportEvent('queued_early');
  h.sdk.experiment.get('paywall');
  const events = await flushEvents(h);
  assert.equal(events.find((event) => event.event_name === 'queued_early').event_param.exp_vids, undefined);
});

test('live_vids_prunes_only_entries_of_the_requested_namespaces', async function live_vids_prunes_only_entries_of_the_requested_namespaces() {
  const first = harness({
    assign: () => ok(body(1, [assignment('paywall', 101), assignment('checkout', 301, { namespace: 'pay' })]))
  });
  await first.sdk.experiment.ready({ namespaces: ['pay'] });
  assert.deepEqual(first.assignRequests.at(-1).body.namespaces, ['default', 'pay']);
  first.sdk.experiment.get('paywall');
  first.sdk.experiment.get('checkout');
  await first.sdk.reportEvent('both');

  // Next page only loads `default`; the server reports 101 as no longer live.
  const second = harness({ assign: () => ok(body(2, [], [])), storage: first.storage, clock: first.clock });
  await second.sdk.experiment.ready();
  await second.sdk.reportEvent('after_prune');
  assert.deepEqual((await flushEvents(first)).find((event) => event.event_name === 'both').event_param.exp_vids, '101,301');
  assert.equal((await flushEvents(second)).find((event) => event.event_name === 'after_prune').event_param.exp_vids, '301');
});

test('known_version_only_when_attributes_and_namespaces_unchanged_and_not_modified_refreshes_freshness', async function known_version_only_when_attributes_and_namespaces_unchanged_and_not_modified_refreshes_freshness() {
  const h = harness({
    assign: (request) => request.known_version === 4
      ? ok({ rules_version: 4, not_modified: true })
      : ok(body(4, [assignment('paywall', 101)]))
  });
  await h.sdk.experiment.ready();
  assert.equal(h.assignRequests[0].body.known_version, undefined);

  h.clock.now += 6 * DAY;
  await h.sdk.experiment.refresh();
  assert.equal(h.assignRequests[1].body.known_version, 4);
  h.clock.now += 2 * DAY;
  const next = harness({ assign: () => new Promise(() => {}), storage: h.storage, clock: h.clock });
  assert.equal(next.sdk.experiment.get('paywall').vid, 101, 'not_modified extended freshness past the original 7 days');

  h.sdk.experiment.setAttributes({ vip: '1', 'attr.tier': 2 });
  await h.sdk.experiment.refresh();
  const changed = h.assignRequests.at(-1).body;
  assert.equal(changed.known_version, undefined, 'attributes changed since last success');
  assert.deepEqual(changed.attributes, { platform: 'web', language: 'en-US', 'attr.tier': '2', 'attr.vip': '1' });
  await h.sdk.experiment.refresh();
  assert.equal(h.assignRequests.at(-1).body.known_version, 4);

  await h.sdk.experiment.ready({ namespaces: ['pay'] });
  assert.equal(h.assignRequests.at(-1).body.known_version, undefined, 'namespace set changed');

  assert.throws(() => h.sdk.experiment.setAttributes({ 'bad key': 'x' }), (error) => assertSDKError(error, 'INVALID_ARGUMENT', false));
  assert.throws(() => h.sdk.experiment.setAttributes({ obj: {} }), (error) => assertSDKError(error, 'INVALID_ARGUMENT', false));
  const many = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`k${index}`, 'v']));
  assert.throws(() => h.sdk.experiment.setAttributes(many), (error) => assertSDKError(error, 'INVALID_ARGUMENT', false));
});

test('responses_with_a_lower_rules_version_are_dropped', async function responses_with_a_lower_rules_version_are_dropped() {
  let round = 0;
  const h = harness({
    assign: () => {
      round += 1;
      return ok(round === 1 ? body(5, [assignment('paywall', 101)]) : body(4, [assignment('paywall', 999)]));
    }
  });
  await h.sdk.experiment.ready();
  await h.sdk.experiment.refresh();
  assert.equal(h.sdk.experiment.getAll().paywall.vid, 101);
  assert.equal(h.sdk.experiment.get('paywall').vid, 101);
});

test('results_older_than_stale_after_sec_count_as_no_result', async function results_older_than_stale_after_sec_count_as_no_result() {
  const h = harness({ assign: () => ok(body(1, [assignment('paywall', 101)])) });
  await h.sdk.experiment.ready();
  h.clock.now += 604800 * 1000 + 1000;
  const offline = harness({ assign: async () => { throw new TypeError('offline'); }, storage: h.storage, clock: h.clock });
  await offline.sdk.experiment.ready();
  const result = offline.sdk.experiment.get('paywall', { default: { price: 'default' } });
  assert.deepEqual({ ...result }, { inExperiment: false, variant: '', vid: null, payload: { price: 'default' }, reason: 'no_result' });
  assert.equal((await flushEvents(offline)).filter((event) => event.event_name === '$exp_exposure').length, 0);
});

test('network_failure_falls_back_to_local_results', async function network_failure_falls_back_to_local_results() {
  const h = harness({ assign: () => ok(body(1, [assignment('paywall', 101)])) });
  await h.sdk.experiment.ready();
  h.clock.now += DAY;
  const offline = harness({ assign: async () => { throw new TypeError('offline'); }, storage: h.storage, clock: h.clock });
  await offline.sdk.experiment.ready();
  assert.equal(offline.sdk.experiment.get('paywall').vid, 101);
  await assert.rejects(offline.sdk.experiment.refresh(), (error) => assertSDKError(error, 'NETWORK_ERROR', true));

  const limited = harness({ assign: () => response(200, { code: 'TOO_MANY_REQUESTS' }), storage: h.storage, clock: h.clock });
  await assert.rejects(limited.sdk.experiment.refresh(), (error) => assertSDKError(error, 'RATE_LIMITED', true));
  assert.equal(limited.sdk.experiment.get('paywall').vid, 101);
});

test('ready_resolves_on_timeout_when_assign_hangs', async function ready_resolves_on_timeout_when_assign_hangs() {
  const h = harness({ assign: () => new Promise(() => {}) });
  const started = Date.now();
  await h.sdk.experiment.ready({ timeoutMs: 30 });
  assert.ok(Date.now() - started < 1500);
  assert.equal(h.sdk.experiment.get('paywall').reason, 'no_result');
  await assert.rejects(h.sdk.experiment.ready({ timeoutMs: -1 }), (error) => assertSDKError(error, 'INVALID_ARGUMENT', false));
  await assert.rejects(h.sdk.experiment.ready({ namespaces: ['Bad'] }), (error) => assertSDKError(error, 'INVALID_ARGUMENT', false));
});

test('consent_denied_means_no_request_no_subject_and_revocation_clears_local_state', async function consent_denied_means_no_request_no_subject_and_revocation_clears_local_state() {
  const h = harness({ consent: 'denied', assign: () => ok(body(1, [assignment('paywall', 101)])) });
  await h.sdk.experiment.ready();
  await settle();
  assert.equal(h.assignRequests.length, 0);
  assert.equal(h.sdk.experiment.get('paywall').reason, 'no_subject');

  await h.sdk.setAnalyticsConsent('granted');
  await h.sdk.experiment.ready();
  assert.equal(h.assignRequests.length, 1, 'granting consent triggers the fetch');
  assert.equal(h.sdk.experiment.get('banner_unread').reason, 'unknown');
  assert.equal(experimentKeys(h.storage).length, 1);

  await h.sdk.setAnalyticsConsent('denied');
  assert.deepEqual(experimentKeys(h.storage), [], 'results and exposed set are wiped');
  assert.equal(h.sdk.experiment.get('paywall_after_revoke').reason, 'no_subject');
  assert.deepEqual({ ...h.sdk.experiment.getAll() }.paywall, undefined);
});

test('revocation_drops_the_exposed_set_from_future_events', async function revocation_drops_the_exposed_set_from_future_events() {
  const h = harness({ assign: () => ok(body(1, [assignment('paywall', 101)])) });
  await h.sdk.experiment.ready();
  h.sdk.experiment.get('paywall');
  await h.sdk.setAnalyticsConsent('denied');
  await h.sdk.setAnalyticsConsent('granted');
  await h.sdk.experiment.ready();
  await h.sdk.reportEvent('after_regrant');
  const event = (await flushEvents(h)).find((item) => item.event_name === 'after_regrant');
  assert.equal(event.event_param.exp_vids, undefined);
});

test('exposed_set_is_capped_at_500_with_a_diagnostic', async function exposed_set_is_capped_at_500_with_a_diagnostic() {
  const storage = memoryStorage();
  const key = `supersdk_exp_v1:${SPID}:prod:dev-1`;
  storage.setItem(key, JSON.stringify({
    v: 1, rulesVersion: 1, lastSuccessAt: Date.parse('2026-11-17T09:00:00'), staleAfterSec: 604800, fingerprint: '',
    results: {}, exposed: Array.from({ length: 500 }, (_, index) => ({ vid: 1000 + index, key: `k${index}`, run: 1, ns: 'default' })),
    day: { date: '', vids: [] }
  }));
  const diagnostics = [];
  const h = harness({ storage, diagnostics: (item) => diagnostics.push(item), assign: () => ok(body(2, [assignment('fresh', 9001)], [9001, ...Array.from({ length: 500 }, (_, index) => 1000 + index)])) });
  await h.sdk.experiment.ready();
  h.sdk.experiment.get('fresh');
  await h.sdk.reportEvent('after');
  const events = await flushEvents(h);
  assert.equal(events.filter((event) => event.event_name === '$exp_exposure').length, 1, 'the exposure is still reported');
  const vids = events.find((event) => event.event_name === 'after').event_param.exp_vids.split(',');
  assert.equal(vids.length, 500);
  assert.ok(!vids.includes('9001'));
  assert.ok(diagnostics.some((item) => item.category === 'experiment' && item.code === 'EXP_VIDS_LIMIT'));
});

test('environment_switch_uses_a_separate_store_and_refetches', async function environment_switch_uses_a_separate_store_and_refetches() {
  const h = harness({ assign: (request) => ok(body(1, request.env === 'prod' ? [assignment('paywall', 101)] : [])) });
  await h.sdk.experiment.ready();
  assert.equal(h.sdk.experiment.get('paywall').vid, 101);
  await h.sdk.setAPIEnvironment('staging');
  await h.sdk.experiment.ready();
  assert.equal(h.assignRequests.at(-1).body.env, 'staging');
  assert.equal(h.sdk.experiment.get('paywall').reason, 'unknown');
  assert.deepEqual(experimentKeys(h.storage).sort(), [`supersdk_exp_v1:${SPID}:prod:dev-1`, `supersdk_exp_v1:${SPID}:staging:dev-1`]);
});

test('in_app_container_without_experiment_methods_keeps_the_s1_web_assign_path', async function in_app_container_without_experiment_methods_keeps_the_s1_web_assign_path(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const assignRequests = [];
  const target = createTarget(async (url, options) => {
    assignRequests.push({ url, body: JSON.parse(options.body) });
    return ok(body(9, [assignment('paywall', 101)]));
  });
  const mock = createBridgeMock({ target, manifest: manifestWithout(EXPERIMENT_BRIDGE_METHODS) });
  mock.queueResult('getEnv', { code: 'SUCCESS', data: { spid: SPID, environment: 'prod', deviceId: 'native-device', os: 'Android', appVersion: '2.3.0' } });
  const sdk = createSuperSDK({ target, random: () => 0.5, experimentSetTimeout: () => 0, experimentClearTimeout: () => {} });
  sdk.installGlobal();
  sdk.init({ spid: SPID });
  assert.equal(mock.calls.filter((call) => call.methodId === 'getEnv').length, 0, 'in-app does not call getEnv until experiments are used');

  await sdk.experiment.ready();
  assert.equal(assignRequests.length, 1);
  assert.deepEqual(assignRequests[0].body.attributes, { platform: 'android', app_version: '2.3.0' });
  assert.equal(assignRequests[0].body.device_id, 'native-device');
  assert.equal(sdk.experiment.get('paywall').vid, 101);
  await settle();
  const reports = mock.calls.filter((call) => call.methodId === 'reportEvent');
  assert.equal(reports.length, 1);
  const [eventName, paramsJson] = reports[0].args.slice(1);
  assert.equal(eventName, '$exp_exposure');
  assert.equal(JSON.parse(paramsJson).source, 'web');
  assert.equal(JSON.parse(paramsJson).exp_vids, undefined);
});

test('visibility_refetches_only_after_ten_minutes_and_set_attributes_is_debounced', async function visibility_refetches_only_after_ten_minutes_and_set_attributes_is_debounced() {
  const timers = [];
  const clock = { now: Date.parse('2026-11-17T10:00:00') };
  const assignRequests = [];
  const target = createTarget(async (url, options) => {
    assignRequests.push(JSON.parse(options.body));
    return ok(body(1, []));
  });
  const listeners = new Map();
  target.addEventListener = (name, listener) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(listener);
  };
  const fire = (name) => { for (const listener of listeners.get(name) || []) listener(); };
  const sdk = createSuperSDK({
    target,
    now: () => clock.now,
    experimentSetTimeout: (handler, delay) => { const timer = { handler, delay, cleared: false }; timers.push(timer); return timer; },
    experimentClearTimeout: (timer) => { if (timer) timer.cleared = true; }
  });
  sdk.init({ spid: SPID, analyticsConsent: 'granted', deviceId: 'dev-1' });
  await sdk.experiment.ready();
  assert.equal(assignRequests.length, 1);

  clock.now += 9 * 60 * 1000;
  fire('visibilitychange');
  await settle();
  assert.equal(assignRequests.length, 1, 'visible again within 10 minutes: no fetch');
  clock.now += 2 * 60 * 1000;
  target.document.visibilityState = 'hidden';
  fire('visibilitychange');
  await settle();
  assert.equal(assignRequests.length, 1, 'hidden: no fetch');
  target.document.visibilityState = 'visible';
  fire('visibilitychange');
  await settle();
  assert.equal(assignRequests.length, 2, 'visible after >10 minutes: fetch');

  sdk.experiment.setAttributes({ vip: '1' });
  sdk.experiment.setAttributes({ vip: '2' });
  sdk.experiment.setAttributes({ vip: '2' });
  const pending = timers.filter((timer) => !timer.cleared && timer.delay === 500);
  assert.equal(pending.length, 1, 'debounced to a single pending fetch');
  pending[0].handler();
  await settle();
  assert.equal(assignRequests.length, 3);
  assert.equal(assignRequests[2].attributes['attr.vip'], '2');
});

test('keys_stored_for_a_namespace_this_page_has_not_loaded_report_not_loaded_without_freezing', async function keys_stored_for_a_namespace_this_page_has_not_loaded_report_not_loaded_without_freezing() {
  const assign = () => ok(body(1, [assignment('paywall', 101), assignment('checkout', 301, { namespace: 'pay' })]));
  const first = harness({ assign });
  await first.sdk.experiment.ready({ namespaces: ['pay'] });
  assert.equal(first.sdk.experiment.getAll().checkout.vid, 301);

  const second = harness({ assign, storage: first.storage, clock: first.clock });
  await second.sdk.experiment.ready();
  assert.equal(second.sdk.experiment.get('checkout').reason, 'not_loaded');
  assert.equal(second.sdk.experiment.getAll().checkout, undefined);
  await second.sdk.experiment.ready({ namespaces: ['pay'] });
  assert.equal(second.sdk.experiment.get('checkout').vid, 301, 'not_loaded was not frozen');
});

test('frozen_results_are_not_served_after_consent_revocation_or_for_a_new_device', async function frozen_results_are_not_served_after_consent_revocation_or_for_a_new_device() {
  const storage = memoryStorage();
  const h = harness({
    storage,
    assign: (request) => ok(body(1, request.device_id === 'device-1' ? [assignment('paywall', 101, { variant: 'low' })] : []))
  });
  await h.sdk.setAnalyticsConsent('denied');
  storage.setItem('supersdk_device_id', 'device-1');
  await h.sdk.setAnalyticsConsent('granted');
  await h.sdk.experiment.ready();
  assert.equal(h.sdk.experiment.get('paywall').variant, 'low', 'frozen for device-1');

  await h.sdk.setAnalyticsConsent('denied');
  assert.deepEqual({ ...h.sdk.experiment.get('paywall', { default: { price: 'd' } }) },
    { inExperiment: false, variant: '', vid: null, payload: { price: 'd' }, reason: 'no_subject' });
  assert.equal(h.sdk.experiment.getAll().paywall.reason, 'no_subject');

  // Re-granted: a brand-new device id (the revocation removed device-1 and init had none).
  await h.sdk.setAnalyticsConsent('granted');
  await h.sdk.experiment.ready();
  assert.notEqual(h.assignRequests.at(-1).body.device_id, 'device-1');
  const regranted = h.sdk.experiment.get('paywall');
  assert.equal(regranted.inExperiment, false, 'device-1 frozen variant is not served to the new device');
  assert.equal(regranted.reason, 'unknown');
  await h.sdk.reportEvent('after');
  const events = await flushEvents(h);
  assert.equal(events.filter((event) => event.event_name === '$exp_exposure').length, 0, 'only the device-1 exposure was queued before revocation and revocation cleared the queue');
  assert.equal(events.find((event) => event.event_name === 'after').event_param.exp_vids, undefined);
});

// ---------------------------------------------------------------- WS-12-S2 · in-app native delegation
// docs/architecture/experiment-s2-impl-spec.md §4: a container that declares the five experiment
// JSB methods owns fetching, freezing, exposure and exp_vids; the JSSDK only mirrors.

function nativeResult(key, vid, extra = {}) {
  return { key, inExperiment: true, variant: `v${vid}`, vid, payload: { price: String(vid) }, reason: 'alloc', frozen: false, ...extra };
}

function delegatedHarness({ diagnostics, manifest } = {}) {
  const fetches = [];
  const target = createTarget(async (url, options) => {
    fetches.push({ url, body: options?.body, headers: options?.headers });
    return ok({});
  });
  const mock = createBridgeMock(manifest ? { target, manifest } : { target });
  const sdk = createSuperSDK({ target, random: () => 0.5, diagnosticSink: diagnostics, experimentSetTimeout: () => 0, experimentClearTimeout: () => {} });
  sdk.installGlobal();
  sdk.init({ spid: SPID });
  const callsOf = (id) => mock.calls.filter((call) => call.methodId === id);
  const paramsOf = (call) => JSON.parse(call.args[1]);
  return { sdk, target, mock, fetches, callsOf, paramsOf };
}

function success(data) {
  return { code: 'SUCCESS', data };
}

test('delegated_ready_mirrors_native_results_and_get_stays_synchronous', async function delegated_ready_mirrors_native_results_and_get_stays_synchronous() {
  const h = delegatedHarness();
  const early = h.sdk.experiment.get('late', { default: { price: '9.9' } });
  assert.deepEqual({ ...early }, { inExperiment: false, variant: '', vid: null, payload: { price: '9.9' }, reason: 'no_result' });
  await settle();
  assert.equal(h.callsOf('getExperiment').length, 0, 'a read before ready() is not sent to native');

  h.mock.queueResult('experimentReady', success({ ready: true }));
  h.mock.queueResult('getAllExperiments', success({ experiments: [nativeResult('paywall', 101), nativeResult('late', 301)] }));
  await h.sdk.experiment.ready({ timeoutMs: 1500, namespaces: ['pay'] });
  assert.deepEqual(h.paramsOf(h.callsOf('experimentReady')[0]), { timeoutMs: 1500, namespaces: ['pay'] });
  assert.deepEqual(h.paramsOf(h.callsOf('getAllExperiments')[0]), {});

  h.mock.queueResult('getExperiment', success(nativeResult('paywall', 101)));
  const first = h.sdk.experiment.get('paywall');
  assert.deepEqual({ ...first }, { inExperiment: true, variant: 'v101', vid: 101, payload: { price: '101' }, reason: 'alloc' });
  assert.equal(h.sdk.experiment.get('late').reason, 'no_result', 'a key read before ready() keeps its default for the page');
  h.mock.queueResult('getExperiment', success({ inExperiment: false, variant: '', vid: null, payload: {}, reason: 'unknown' }));
  assert.equal(h.sdk.experiment.get('missing').reason, 'unknown');
  await settle();

  assert.deepEqual(h.callsOf('getExperiment').map(h.paramsOf), [{ key: 'paywall', expose: true }, { key: 'missing', expose: true }]);
  h.sdk.experiment.get('paywall');
  await settle();
  assert.equal(h.callsOf('getExperiment').length, 2, 'native is asked once per key per page');
  assert.equal(h.sdk.experiment.getAll().paywall.vid, 101);

  // Native owns fetching and exposure: no assign request (not even on visibility), no $exp_exposure from H5.
  h.target.dispatch('visibilitychange');
  await settle();
  assert.equal(h.fetches.filter((entry) => entry.url.includes('/v2/experiments/assign')).length, 0);
  assert.equal(h.callsOf('reportEvent').length, 0);
  assert.equal(h.callsOf('getEnv').length, 0, 'the suspended web client never resolves a subject');
});

test('delegated_get_reconciles_with_the_native_frozen_value_and_reports_a_diagnostic', async function delegated_get_reconciles_with_the_native_frozen_value_and_reports_a_diagnostic() {
  const seen = [];
  const h = delegatedHarness({ diagnostics: (event) => seen.push(event) });
  h.mock.queueResult('experimentReady', success({ ready: true }));
  h.mock.queueResult('getAllExperiments', success({ experiments: [nativeResult('paywall', 102)] }));
  await h.sdk.experiment.ready();
  // Native froze an earlier assignment for this session (e.g. read by native code first).
  h.mock.queueResult('getExperiment', success(nativeResult('paywall', 101, { frozen: true })));
  assert.equal(h.sdk.experiment.get('paywall').vid, 102, 'first read answers synchronously from the mirror');
  await settle();
  assert.equal(h.sdk.experiment.get('paywall').vid, 101, 'native frozen value wins');
  assert.equal(h.sdk.experiment.getAll().paywall.vid, 101);
  assert.ok(seen.some((event) => event.category === 'experiment_native' && event.code === 'NATIVE_RESULT_MISMATCH'));
});

test('delegated_expose_false_then_expose_calls_native_once', async function delegated_expose_false_then_expose_calls_native_once() {
  const h = delegatedHarness();
  h.mock.queueResult('experimentReady', success({ ready: true }));
  h.mock.queueResult('getAllExperiments', success({ experiments: [nativeResult('paywall', 101)] }));
  await h.sdk.experiment.ready();
  h.mock.queueResult('getExperiment', success(nativeResult('paywall', 101)));
  const result = h.sdk.experiment.get('paywall', { expose: false, default: { price: '0' } });
  assert.equal(result.vid, 101);
  await settle();
  assert.deepEqual(h.paramsOf(h.callsOf('getExperiment')[0]), { key: 'paywall', expose: false, default: { price: '0' } });
  assert.equal(h.callsOf('exposeExperiment').length, 0);

  h.mock.queueResult('exposeExperiment', success({}));
  h.sdk.experiment.expose('paywall');
  h.sdk.experiment.expose('paywall');
  h.sdk.experiment.get('paywall');
  h.sdk.experiment.expose('never-read');
  await settle();
  assert.deepEqual(h.callsOf('exposeExperiment').map(h.paramsOf), [{ key: 'paywall' }]);
});

test('delegated_set_attributes_forwards_validated_attributes', async function delegated_set_attributes_forwards_validated_attributes() {
  const h = delegatedHarness();
  h.mock.queueResult('setExperimentAttributes', success({}));
  h.sdk.experiment.setAttributes({ 'attr.vip': 1, level: true, gone: null });
  await settle();
  assert.deepEqual(h.callsOf('setExperimentAttributes').map(h.paramsOf), [{ attributes: { vip: '1', level: 'true', gone: null } }]);
  assert.throws(() => h.sdk.experiment.setAttributes({ 'bad-name': '1' }), (error) => assertSDKError(error, 'INVALID_ARGUMENT', false));
  assert.throws(() => h.sdk.experiment.setAttributes('vip'), (error) => assertSDKError(error, 'INVALID_ARGUMENT', false));
  await assert.rejects(h.sdk.experiment.ready({ namespaces: ['Bad'] }), (error) => assertSDKError(error, 'INVALID_ARGUMENT', false));
});

test('delegated_events_carry_no_js_exp_vids_and_caller_values_are_dropped', async function delegated_events_carry_no_js_exp_vids_and_caller_values_are_dropped() {
  const h = delegatedHarness();
  h.mock.queueResult('experimentReady', success({ ready: true }));
  h.mock.queueResult('getAllExperiments', success({ experiments: [nativeResult('paywall', 101)] }));
  await h.sdk.experiment.ready();
  h.mock.queueResult('getExperiment', success(nativeResult('paywall', 101)));
  h.sdk.experiment.get('paywall');
  await settle();
  h.mock.queueResult('reportEvent', success({}));
  h.mock.queueResult('reportEvent', success({}));
  await h.sdk.reportEvent('plain', { a: 1 });
  await h.sdk.reportEvent('spoofed', { a: 1, exp_vids: '9' });
  const reports = h.callsOf('reportEvent').map((call) => ({ name: call.args[1], params: JSON.parse(call.args[2]) }));
  assert.deepEqual(reports, [{ name: 'plain', params: { a: 1 } }, { name: 'spoofed', params: { a: 1 } }]);
});

test('delegated_ready_never_rejects_when_native_fails_and_refresh_surfaces_errors', async function delegated_ready_never_rejects_when_native_fails_and_refresh_surfaces_errors() {
  const h = delegatedHarness();
  h.mock.queueResult('experimentReady', { code: 'UNAVAILABLE', message: 'not started' });
  h.mock.queueResult('getAllExperiments', { code: 'UNAVAILABLE' });
  await h.sdk.experiment.ready();
  assert.equal(h.sdk.experiment.get('paywall').reason, 'no_result');

  h.mock.queueResult('getAllExperiments', { code: 'UNAVAILABLE' });
  await assert.rejects(h.sdk.experiment.refresh(), (error) => error.code === 'UNAVAILABLE');
  h.mock.queueResult('getAllExperiments', success({ experiments: [nativeResult('banner', 201)] }));
  await h.sdk.experiment.refresh();
  h.mock.queueResult('getExperiment', success(nativeResult('banner', 201)));
  assert.equal(h.sdk.experiment.get('banner').vid, 201);
  assert.equal(h.sdk.experiment.get('paywall').reason, 'no_result', 'paywall stays frozen at its pre-ready value');
  await settle();
});

test('legacy_appbridge_without_manifest_delegates_when_the_functions_exist', async function legacy_appbridge_without_manifest_delegates_when_the_functions_exist() {
  const calls = [];
  const target = createTarget(async () => ok({}));
  target.appbridge = {};
  for (const name of ['getEnvAsync', 'reportEvent', ...EXPERIMENT_BRIDGE_METHODS]) {
    target.appbridge[name] = (...args) => { calls.push({ name, args }); };
  }
  const sdk = createSuperSDK({
    target, random: () => 0.5, experimentSetTimeout: () => 0, experimentClearTimeout: () => {},
    bridgeSetTimeout: () => 0, bridgeClearTimeout: () => {}
  });
  sdk.installGlobal();
  sdk.init({ spid: SPID });
  sdk.experiment.setAttributes({ vip: '1' });
  assert.deepEqual(calls.map((call) => call.name), ['setExperimentAttributes']);
  delete target.appbridge.getExperiment;
  // Latched: one page never switches paths midway.
  sdk.experiment.setAttributes({ vip: '2' });
  assert.equal(calls.filter((call) => call.name === 'setExperimentAttributes').length, 2);
});

// ---------------------------------------------------------------- WS-12-S6 · server-side experiments
// docs/architecture/experiment-s6-impl-spec.md §1/§3: server-type experiments travel to backends as
// X-Super-AB-Vids / super_ab_vids; generating that value treats them as read (freeze + expose once).

function serverAssignment(key, vid, extra = {}) {
  return assignment(key, vid, { type: 'server', ...extra });
}

async function serverHarness(options = {}) {
  const seen = [];
  const h = harness({
    assign: () => ok(body(1, [assignment('paywall', 101), serverAssignment('ranking', 501), serverAssignment('pricing', 502)])),
    diagnostics: (event) => seen.push(event),
    ...options
  });
  await h.sdk.experiment.ready();
  return { ...h, seen };
}

function exposures(events) {
  return events.filter((event) => event.event_name === '$exp_exposure').map((event) => event.event_param.vid);
}

test('s6_get_on_a_server_experiment_is_not_participating_without_freeze_or_exposure', async function s6_get_on_a_server_experiment_is_not_participating_without_freeze_or_exposure() {
  const h = await serverHarness();
  const result = h.sdk.experiment.get('ranking', { default: { mode: 'base' } });
  assert.deepEqual({ ...result }, { inExperiment: false, variant: '', vid: null, payload: { mode: 'base' }, reason: 'unknown' });
  h.sdk.experiment.get('ranking');
  h.sdk.experiment.expose('ranking');
  assert.equal(h.seen.filter((event) => event.code === 'SERVER_EXPERIMENT_READ').length, 1, 'one diagnostic per key');
  const all = h.sdk.experiment.getAll();
  assert.equal(all.ranking.type, 'server');
  assert.equal(all.ranking.vid, 501);
  assert.equal(all.paywall.type, 'client');
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), { 'X-Super-AB-Vids': '501,502' }, 'get() did not freeze or expose it');
  assert.deepEqual(exposures(await flushEvents(h)), [501, 502]);
});

test('s6_first_request_vids_freeze_and_expose_server_experiments_once', async function s6_first_request_vids_freeze_and_expose_server_experiments_once() {
  const h = await serverHarness();
  h.sdk.experiment.get('paywall');
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), { 'X-Super-AB-Vids': '101,501,502' });
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), { 'X-Super-AB-Vids': '101,501,502' });
  assert.equal(h.sdk.experiment.appendVidsToUrl('/feed'), '/feed?super_ab_vids=101,501,502');
  await h.sdk.reportEvent('after', {});
  const events = await flushEvents(h);
  assert.deepEqual(exposures(events), [101, 501, 502], 'each server vid exposed once');
  const exposure = events.find((event) => event.event_name === '$exp_exposure' && event.event_param.vid === 501);
  assert.equal(exposure.event_param.source, 'web');
  assert.equal(exposure.event_param.exp_key, 'ranking');
  assert.equal(events.find((event) => event.event_name === 'after').event_param.exp_vids, '101,501,502');

  // Frozen for the session: a later assign moving the server experiment does not change the value.
  h.clock.now += 1000;
  await h.sdk.experiment.refresh().catch(() => undefined);
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), { 'X-Super-AB-Vids': '101,501,502' });
});

test('s6_server_experiment_frozen_value_survives_a_reassignment', async function s6_server_experiment_frozen_value_survives_a_reassignment() {
  let round = 0;
  const h = harness({
    assign: () => {
      round += 1;
      return ok(body(round, [serverAssignment('ranking', round === 1 ? 501 : 503)], [501, 503]));
    }
  });
  await h.sdk.experiment.ready();
  assert.equal(h.sdk.experiment.getRequestHeaders()['X-Super-AB-Vids'], '501');
  await h.sdk.experiment.refresh();
  assert.equal(h.sdk.experiment.getRequestHeaders()['X-Super-AB-Vids'], '501', 'frozen to the session');
  assert.deepEqual(exposures(await flushEvents(h)), [501]);
});

test('s6_empty_set_means_no_header_and_unchanged_url', async function s6_empty_set_means_no_header_and_unchanged_url() {
  const h = harness({ assign: () => ok(body(1, [assignment('paywall', 101)])) });
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), {}, 'before results arrive the value is empty');
  await h.sdk.experiment.ready();
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), {}, 'client experiments join only when read');
  const url = 'https://api.example.com/feed?page=1&super_ab_vids=9#top';
  assert.equal(h.sdk.experiment.appendVidsToUrl(url), url);
  assert.throws(() => h.sdk.experiment.appendVidsToUrl(42), (error) => assertSDKError(error, 'INVALID_ARGUMENT', false));
});

test('s6_append_vids_to_url_overwrites_and_preserves_query_hash_and_relative_form', async function s6_append_vids_to_url_overwrites_and_preserves_query_hash_and_relative_form() {
  const h = await serverHarness();
  const v = '501,502';
  const cases = [
    ['https://api.example.com/feed', `https://api.example.com/feed?super_ab_vids=${v}`],
    ['https://api.example.com/feed?page=1&sort=new', `https://api.example.com/feed?page=1&sort=new&super_ab_vids=${v}`],
    ['https://api.example.com/feed?super_ab_vids=1,2&page=1#list', `https://api.example.com/feed?page=1&super_ab_vids=${v}#list`],
    ['https://api.example.com/feed?super%5Fab%5Fvids=1&super_ab_vids=2', `https://api.example.com/feed?super_ab_vids=${v}`],
    ['https://api.example.com/feed#a?b=1', `https://api.example.com/feed?super_ab_vids=${v}#a?b=1`],
    ['https://api.example.com/feed?', `https://api.example.com/feed?super_ab_vids=${v}`],
    ['/api/feed?x=1', `/api/feed?x=1&super_ab_vids=${v}`],
    ['feed', `feed?super_ab_vids=${v}`],
    ['//cdn.example.com/a?super_ab_vidsX=1', `//cdn.example.com/a?super_ab_vidsX=1&super_ab_vids=${v}`]
  ];
  for (const [input, expected] of cases) assert.equal(h.sdk.experiment.appendVidsToUrl(input), expected, input);
  assert.equal(h.sdk.experiment.appendVidsToUrl(new URL('https://a.example/x?y=1')), `https://a.example/x?y=1&super_ab_vids=${v}`);
});

test('s6_experiment_fetch_merges_the_header_with_sdk_winning', async function s6_experiment_fetch_merges_the_header_with_sdk_winning() {
  const h = await serverHarness();
  const calls = [];
  h.target.fetch = async (input, init) => { calls.push({ input, init }); return response(200, {}); };
  const header = (init) => new Headers(init.headers).get('X-Super-AB-Vids');

  await h.sdk.experiment.fetch('https://api.example.com/a', { method: 'POST', headers: { 'x-super-ab-vids': 'forged', 'X-Trace': '1' }, body: '{}' });
  await h.sdk.experiment.fetch('https://api.example.com/b', { headers: new Headers({ 'X-Trace': '2' }) });
  await h.sdk.experiment.fetch('https://api.example.com/c', { headers: [['X-Trace', '3'], ['X-Super-AB-Vids', 'forged']] });
  await h.sdk.experiment.fetch('https://api.example.com/d');
  const request = new Request('https://api.example.com/e', { headers: { 'X-Trace': '5' } });
  await h.sdk.experiment.fetch(request);

  assert.deepEqual(calls.map((call) => header(call.init)), ['501,502', '501,502', '501,502', '501,502', '501,502']);
  assert.deepEqual(calls.map((call) => new Headers(call.init.headers).get('X-Trace')), ['1', '2', '3', null, '5']);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, '{}');
  assert.equal(calls[0].input, 'https://api.example.com/a', 'the URL is not rewritten');
  assert.equal(calls[4].input, request);
  assert.deepEqual(exposures(await flushEvents(h)), [501, 502]);
});

test('s6_experiment_fetch_with_an_empty_set_passes_arguments_through', async function s6_experiment_fetch_with_an_empty_set_passes_arguments_through() {
  const h = harness({ assign: () => ok(body(1, [])) });
  await h.sdk.experiment.ready();
  const calls = [];
  h.target.fetch = async (input, init) => { calls.push({ input, init }); return response(200, {}); };
  const init = { headers: { 'X-Trace': '1' } };
  await h.sdk.experiment.fetch('/a', init);
  assert.equal(calls[0].init, init);
});

test('s6_platform_requests_carry_only_the_current_exposed_set_without_the_side_effect', async function s6_platform_requests_carry_only_the_current_exposed_set_without_the_side_effect() {
  const h = await serverHarness();
  assert.equal(h.assignRequests[0].headers['X-Super-AB-Vids'], undefined, 'empty set: header omitted');
  await h.sdk.reportEvent('before', {});
  await settle();
  await h.sdk.flush();
  await h.sdk.experiment.refresh();
  assert.equal(h.assignRequests[1].headers['X-Super-AB-Vids'], undefined, 'platform requests never treat server experiments as read');
  assert.deepEqual(exposures(h.events), []);

  h.sdk.experiment.get('paywall');
  await h.sdk.experiment.refresh();
  assert.equal(h.assignRequests[2].headers['X-Super-AB-Vids'], '101');
  h.sdk.experiment.getRequestHeaders();
  await h.sdk.experiment.refresh();
  assert.equal(h.assignRequests[3].headers['X-Super-AB-Vids'], '101,501,502');
});

test('s6_report_event_upload_carries_the_header', async function s6_report_event_upload_carries_the_header() {
  const uploads = [];
  const target = createTarget(async (url, options) => {
    if (url.endsWith('/v2/experiments/assign')) return ok(body(1, [assignment('paywall', 101)]));
    uploads.push(options.headers);
    return response(200, { code: 'SUCCESS' });
  });
  target.navigator = { userAgent: '', language: 'en-US' };
  const sdk = createSuperSDK({ target });
  sdk.init({ spid: SPID, environment: 'prod', analyticsConsent: 'granted', deviceId: 'dev-1' });
  await sdk.experiment.ready();
  sdk.experiment.get('paywall');
  await settle();
  await sdk.flush();
  assert.ok(uploads.length > 0);
  assert.equal(uploads.at(-1)['X-Super-AB-Vids'], '101');
  assert.equal(uploads.at(-1)['X-Aid'], SPID);
});

test('s6_delegated_request_vids_are_synchronous_from_the_mirror_and_reconciled_with_native', async function s6_delegated_request_vids_are_synchronous_from_the_mirror_and_reconciled_with_native() {
  const seen = [];
  const h = delegatedHarness({ diagnostics: (event) => seen.push(event) });
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), {}, 'before ready(): empty');
  assert.equal(h.sdk.experiment.appendVidsToUrl('/a'), '/a');
  await settle();
  assert.equal(h.callsOf('getExperimentRequestVids').length, 0, 'native is not asked before ready()');

  h.mock.queueResult('experimentReady', success({ ready: true }));
  h.mock.queueResult('getAllExperiments', success({
    experiments: [
      nativeResult('paywall', 101, { type: 'client', exposed: true }),
      nativeResult('ranking', 501, { type: 'server', exposed: false }),
      nativeResult('banner', 201, { type: 'client', exposed: false })
    ]
  }));
  await h.sdk.experiment.ready();
  assert.equal(h.sdk.experiment.getAll().ranking.type, 'server');
  assert.equal(h.sdk.experiment.getAll().ranking.exposed, undefined, 'mirror-only fields are not public');

  // get() on a server experiment: not participating, native not asked.
  assert.equal(h.sdk.experiment.get('ranking').reason, 'unknown');
  await settle();
  assert.equal(h.callsOf('getExperiment').length, 0);
  assert.ok(seen.some((event) => event.code === 'SERVER_EXPERIMENT_READ'));

  // Native also knows an exposed vid this page has not mirrored (e.g. another namespace).
  h.mock.queueResult('getExperimentRequestVids', success({ vids: '101,377,501' }));
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), { 'X-Super-AB-Vids': '101,501' });
  await settle();
  assert.deepEqual(h.callsOf('getExperimentRequestVids').map(h.paramsOf), [{}]);
  assert.ok(seen.some((event) => event.code === 'NATIVE_RESULT_MISMATCH' && event.api === 'getExperimentRequestVids'));
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), { 'X-Super-AB-Vids': '101,377,501' }, 'native value adopted');
  assert.equal(h.sdk.experiment.appendVidsToUrl('/a#h'), '/a?super_ab_vids=101,377,501#h');
  await settle();
  assert.equal(h.callsOf('getExperimentRequestVids').length, 1, 'unchanged set: no further round trip');
  assert.equal(h.callsOf('reportEvent').length, 0, 'H5 never reports exposures itself');

  // Platform requests in-app read the current set only.
  h.target.fetch = async (url, init) => { h.fetches.push({ url, headers: init?.headers }); return response(200, {}); };
  await h.sdk.experiment.fetch('https://api.example.com/x');
  assert.equal(new Headers(h.fetches.at(-1).headers).get('X-Super-AB-Vids'), '101,377,501');
});

test('s6_delegated_new_server_experiment_after_refresh_asks_native_again', async function s6_delegated_new_server_experiment_after_refresh_asks_native_again() {
  const h = delegatedHarness();
  h.mock.queueResult('experimentReady', success({ ready: true }));
  h.mock.queueResult('getAllExperiments', success({ experiments: [nativeResult('ranking', 501, { type: 'server' })] }));
  await h.sdk.experiment.ready();
  h.mock.queueResult('getExperimentRequestVids', success({ vids: '501' }));
  assert.equal(h.sdk.experiment.getRequestHeaders()['X-Super-AB-Vids'], '501');
  await settle();
  h.mock.queueResult('getAllExperiments', success({ experiments: [nativeResult('ranking', 501, { type: 'server', exposed: true }), nativeResult('sort', 601, { type: 'server' })] }));
  await h.sdk.experiment.refresh();
  h.mock.queueResult('getExperimentRequestVids', success({ vids: '501,601' }));
  assert.equal(h.sdk.experiment.getRequestHeaders()['X-Super-AB-Vids'], '501,601');
  await settle();
  assert.equal(h.callsOf('getExperimentRequestVids').length, 2);
});

test('s6_delegated_get_exposure_joins_the_mirror_set', async function s6_delegated_get_exposure_joins_the_mirror_set() {
  const h = delegatedHarness();
  h.mock.queueResult('experimentReady', success({ ready: true }));
  h.mock.queueResult('getAllExperiments', success({ experiments: [nativeResult('paywall', 101, { type: 'client' })] }));
  await h.sdk.experiment.ready();
  h.mock.queueResult('getExperiment', success(nativeResult('paywall', 101)));
  h.sdk.experiment.get('paywall');
  await settle();
  h.mock.queueResult('getExperimentRequestVids', success({ vids: '101' }));
  assert.equal(h.sdk.experiment.getRequestHeaders()['X-Super-AB-Vids'], '101');
});

test('s6_old_native_without_get_experiment_request_vids_uses_the_mirror_only', async function s6_old_native_without_get_experiment_request_vids_uses_the_mirror_only() {
  const seen = [];
  const h = delegatedHarness({ diagnostics: (event) => seen.push(event), manifest: manifestWithout(['getExperimentRequestVids']) });
  h.mock.queueResult('experimentReady', success({ ready: true }));
  // An S2 container sends neither `type` nor `exposed`.
  h.mock.queueResult('getAllExperiments', success({ experiments: [nativeResult('paywall', 101)] }));
  await h.sdk.experiment.ready();
  assert.equal(h.sdk.experiment.getAll().paywall.type, 'client');
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), {});
  h.mock.queueResult('getExperiment', success(nativeResult('paywall', 101)));
  h.sdk.experiment.get('paywall');
  await settle();
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), { 'X-Super-AB-Vids': '101' });
  await settle();
  assert.equal(h.callsOf('getExperimentRequestVids').length, 0);
  assert.equal(seen.filter((event) => event.code === 'REQUEST_VIDS_UNSUPPORTED').length, 1, 'diagnostic once');
});

test('s6_cors_simple_settings_get_never_carries_the_header', async function s6_cors_simple_settings_get_never_carries_the_header() {
  const settingsRequests = [];
  const target = createTarget(async (url, options) => {
    if (url.endsWith('/v2/experiments/assign')) return ok(body(1, [assignment('paywall', 101)]));
    if ((options?.method || 'GET') === 'GET') {
      settingsRequests.push(options);
      return response(200, { code: 'SUCCESS', data: { configs: {} } });
    }
    return response(200, { code: 'SUCCESS' });
  });
  target.navigator = { userAgent: '', language: 'en-US' };
  const sdk = createSuperSDK({ target });
  sdk.init({ spid: SPID, environment: 'prod', analyticsConsent: 'granted', deviceId: 'dev-1' });
  await sdk.experiment.ready();
  sdk.experiment.get('paywall');
  assert.deepEqual(sdk.experiment.getRequestHeaders(), { 'X-Super-AB-Vids': '101' });
  await sdk.getHostSettings('app_config').catch(() => undefined);
  assert.ok(settingsRequests.length > 0, 'settings GET was sent');
  for (const options of settingsRequests) {
    assert.equal(options.method, 'GET');
    assert.deepEqual(Object.keys(options.headers), ['Accept'], 'still a CORS-simple request');
  }
});

// ---------------------------------------------------------------- WS-12-S5 · emergency stop
// docs/architecture/experiment-s5-impl-spec.md §4: keys in `emergency_stopped` leave the freeze
// table, read as not participating (`paused`) for the rest of the page session, and their vids
// leave exp_vids and the request vids.

function stoppedBody(rulesVersion, assignments, stoppedKeys, liveVids = assignments.map((item) => item.vid)) {
  return { ...body(rulesVersion, assignments, liveVids), emergency_stopped: stoppedKeys };
}

test('s5_frozen_key_becomes_not_participating_after_an_emergency_stop', async function s5_frozen_key_becomes_not_participating_after_an_emergency_stop() {
  const seen = [];
  let round = 0;
  const h = harness({
    diagnostics: (event) => seen.push(event),
    assign: () => {
      round += 1;
      if (round === 1) return ok(body(1, [assignment('paywall', 101), assignment('banner', 201)]));
      // The stopped experiment is paused: no assignment, not in live_vids, listed as stopped.
      // live_vids is deliberately left containing 101 to prove the stop alone removes it.
      return ok(stoppedBody(2, [assignment('banner', 201)], ['paywall'], [101, 201]));
    }
  });
  await h.sdk.experiment.ready();
  assert.equal(h.sdk.experiment.get('paywall').vid, 101);
  h.sdk.experiment.get('banner');
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), { 'X-Super-AB-Vids': '101,201' });
  await h.sdk.reportEvent('before_stop');

  await h.sdk.experiment.refresh();
  const after = h.sdk.experiment.get('paywall', { default: { price: '9.9' } });
  assert.deepEqual({ ...after }, { inExperiment: false, variant: '', vid: null, payload: { price: '9.9' }, reason: 'paused' });
  assert.equal(h.sdk.experiment.getAll().paywall.reason, 'paused');
  assert.equal(h.sdk.experiment.get('banner').vid, 201, 'other experiments stay frozen');
  h.sdk.experiment.expose('paywall');
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), { 'X-Super-AB-Vids': '201' });
  assert.equal(h.sdk.experiment.appendVidsToUrl('/feed'), '/feed?super_ab_vids=201');
  await h.sdk.reportEvent('after_stop');

  const events = await flushEvents(h);
  const vidsOf = (name) => events.find((event) => event.event_name === name).event_param.exp_vids;
  assert.equal(vidsOf('before_stop'), '101,201');
  assert.equal(vidsOf('after_stop'), '201', 'the stopped vid leaves exp_vids of later events');
  assert.deepEqual(exposures(events), [101, 201], 'no exposure for the stopped key afterwards');
  const stops = seen.filter((event) => event.code === 'EMERGENCY_STOPPED');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].state, 'frozen');
  assert.equal(stops[0].discarded, 1);
});

test('s5_stopped_key_stays_stopped_for_the_session_and_resumes_on_the_next_page', async function s5_stopped_key_stays_stopped_for_the_session_and_resumes_on_the_next_page() {
  const seen = [];
  let round = 0;
  const assign = () => {
    round += 1;
    if (round === 1) return ok(stoppedBody(1, [], ['paywall'], []));
    // Resumed: assigned again, no longer listed as stopped.
    return ok(body(round, [assignment('paywall', 101)]));
  };
  const h = harness({ assign, diagnostics: (event) => seen.push(event) });
  await h.sdk.experiment.ready();
  assert.equal(h.sdk.experiment.get('paywall').reason, 'paused', 'stopped before it was ever read');
  await h.sdk.experiment.refresh();
  assert.equal(h.sdk.experiment.get('paywall').reason, 'paused', 'stays stopped within this page session');
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), {});
  assert.equal(seen.filter((event) => event.code === 'EMERGENCY_STOPPED').length, 1);
  assert.equal(seen.find((event) => event.code === 'EMERGENCY_STOPPED').state, 'unread');
  assert.deepEqual(exposures(await flushEvents(h)), []);

  const nextPage = harness({ assign, storage: h.storage, clock: h.clock });
  await nextPage.sdk.experiment.ready();
  assert.equal(nextPage.sdk.experiment.get('paywall').vid, 101, 'readable again in the next page session');
  assert.deepEqual(exposures(await flushEvents(nextPage)), [101]);
});

test('s5_emergency_stop_of_a_server_experiment_leaves_the_request_vids', async function s5_emergency_stop_of_a_server_experiment_leaves_the_request_vids() {
  let round = 0;
  const h = await serverHarness({
    assign: () => {
      round += 1;
      if (round === 1) return ok(body(1, [assignment('paywall', 101), serverAssignment('ranking', 501), serverAssignment('pricing', 502)]));
      return ok(stoppedBody(2, [assignment('paywall', 101), serverAssignment('pricing', 502)], ['ranking']));
    }
  });
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), { 'X-Super-AB-Vids': '501,502' });
  await h.sdk.experiment.refresh();
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), { 'X-Super-AB-Vids': '502' });
  await h.sdk.reportEvent('after_stop');
  const events = await flushEvents(h);
  assert.equal(events.find((event) => event.event_name === 'after_stop').event_param.exp_vids, '502');
  assert.deepEqual(exposures(events), [501, 502]);
});

test('s5_rollout_results_participate_but_never_expose_or_join_the_vids', async function s5_rollout_results_participate_but_never_expose_or_join_the_vids() {
  const h = harness({ assign: () => ok(body(4, [assignment('winner', 501, { reason: 'rollout' })], [])) });
  await h.sdk.experiment.ready();
  const rolled = h.sdk.experiment.get('winner');
  assert.equal(rolled.inExperiment, true);
  assert.equal(rolled.variant, 'v501');
  assert.equal(rolled.reason, 'rollout');
  h.sdk.experiment.expose('winner');
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), {});
  assert.equal(h.sdk.experiment.appendVidsToUrl('/x'), '/x');
  await h.sdk.reportEvent('after');
  const events = await flushEvents(h);
  assert.deepEqual(exposures(events), []);
  assert.equal(events.find((event) => event.event_name === 'after').event_param.exp_vids, undefined);
});

test('s5_delegated_get_adopts_a_native_answer_that_is_now_not_participating', async function s5_delegated_get_adopts_a_native_answer_that_is_now_not_participating() {
  const h = delegatedHarness();
  h.mock.queueResult('experimentReady', success({ ready: true }));
  h.mock.queueResult('getAllExperiments', success({ experiments: [nativeResult('paywall', 101, { exposed: true })] }));
  await h.sdk.experiment.ready();
  // Native received the emergency stop after this page mirrored the participating result.
  h.mock.queueResult('getExperiment', success({ inExperiment: false, variant: '', vid: null, payload: {}, reason: 'paused' }));
  assert.equal(h.sdk.experiment.get('paywall').vid, 101, 'synchronous mirror value first');
  await settle();
  assert.equal(h.sdk.experiment.get('paywall').reason, 'paused');
  assert.equal(h.sdk.experiment.get('paywall').inExperiment, false);
  assert.equal(h.sdk.experiment.getAll().paywall.reason, 'paused');
});

test('s5_delegated_mirror_reload_corrects_a_frozen_key_native_stopped', async function s5_delegated_mirror_reload_corrects_a_frozen_key_native_stopped() {
  const h = delegatedHarness({ manifest: manifestWithout(['getExperimentRequestVids']) });
  h.mock.queueResult('experimentReady', success({ ready: true }));
  h.mock.queueResult('getAllExperiments', success({
    experiments: [nativeResult('paywall', 101), nativeResult('banner', 201, { exposed: true })]
  }));
  await h.sdk.experiment.ready();
  h.mock.queueResult('getExperiment', success(nativeResult('paywall', 101)));
  assert.equal(h.sdk.experiment.get('paywall').vid, 101);
  await settle();
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), { 'X-Super-AB-Vids': '101,201' });

  h.mock.queueResult('getAllExperiments', success({
    experiments: [
      { key: 'paywall', inExperiment: false, variant: '', vid: null, payload: {}, reason: 'paused' },
      // A plain reassignment of a frozen key does not override the page's frozen value.
      nativeResult('banner', 202, { exposed: true })
    ]
  }));
  await h.sdk.experiment.refresh();
  const after = h.sdk.experiment.get('paywall', { default: { price: '9.9' } });
  assert.deepEqual({ ...after }, { inExperiment: false, variant: '', vid: null, payload: { price: '9.9' }, reason: 'paused' });
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), { 'X-Super-AB-Vids': '202' });
});

test('s5_emergency_stops_apply_only_from_accepted_full_responses', async function s5_emergency_stops_apply_only_from_accepted_full_responses() {
  const seen = [];
  let round = 0;
  const h = harness({
    diagnostics: (event) => seen.push(event),
    assign: () => {
      round += 1;
      if (round === 1) return ok(body(5, [assignment('paywall', 101)]));
      // not_modified and older (dropped) responses never apply a stop.
      if (round === 2) return ok({ rules_version: 5, not_modified: true, emergency_stopped: ['paywall'] });
      return ok(stoppedBody(4, [], ['paywall'], []));
    }
  });
  await h.sdk.experiment.ready();
  assert.equal(h.sdk.experiment.get('paywall').vid, 101);
  await h.sdk.experiment.refresh();
  assert.equal(h.assignRequests.at(-1).body.known_version, 5);
  assert.equal(h.sdk.experiment.get('paywall').vid, 101, 'not_modified: stop ignored');
  await h.sdk.experiment.refresh();
  assert.equal(h.sdk.experiment.get('paywall').vid, 101, 'older response dropped: stop ignored');
  assert.deepEqual(h.sdk.experiment.getRequestHeaders(), { 'X-Super-AB-Vids': '101' });
  assert.equal(seen.filter((event) => event.code === 'EMERGENCY_STOPPED').length, 0);
});

test('s5_full_response_with_an_equal_rules_version_replaces_results', async function s5_full_response_with_an_equal_rules_version_replaces_results() {
  let round = 0;
  const assign = () => {
    round += 1;
    // The server answers in full with the same rules_version once an experiment has expired.
    return ok(round === 1 ? body(7, [assignment('paywall', 101), assignment('banner', 201)]) : body(7, [], []));
  };
  const h = harness({ assign });
  await h.sdk.experiment.ready();
  h.sdk.experiment.get('paywall');
  await h.sdk.reportEvent('before');
  await h.sdk.experiment.refresh();
  assert.equal(h.assignRequests.at(-1).body.known_version, 7);
  assert.equal(h.sdk.experiment.get('banner').reason, 'unknown', 'unread key reads the replaced results');
  assert.equal(h.sdk.experiment.get('paywall').vid, 101, 'already-read key stays frozen for the page');
  await h.sdk.reportEvent('after');
  const events = await flushEvents(h);
  const vidsOf = (name) => events.find((event) => event.event_name === name).event_param.exp_vids;
  assert.equal(vidsOf('before'), '101');
  assert.equal(vidsOf('after'), undefined, 'live_vids of the equal-version response pruned the vid');

  const nextPage = harness({ assign, storage: h.storage, clock: h.clock });
  await nextPage.sdk.experiment.ready();
  assert.equal(nextPage.sdk.experiment.get('paywall').reason, 'unknown');
});
