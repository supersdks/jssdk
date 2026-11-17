import { sdkError } from '../core/errors.js';
import { LIMITS } from '../core/limits.js';
import { createUUID, stableStringify } from '../core/utils.js';
import { createMonitoringAggregator } from './aggregator.js';
import { createMonitoringBudget, normalizeMonitoringBudgets } from './budget.js';
import { installBridgeCollector, installErrorCollectors, installPerformanceCollectors } from './collectors.js';
import { createMonitoringRemote } from './remote-adapter.js';
import { deepFreeze, sanitizeEnvelope } from './sanitizer.js';
import { parseContainerCorrelation } from './generated-contract.js';

const DROP_KEYS = ['aggregation_other','aggregation_rejected','budget','before_send','collector_unavailable','teardown_error','subscriber_busy','subscriber_error','remote_busy','business_priority','native_business_priority_unknown','remote_adapter_error','remote_adapter_timeout','invalid_envelope'];

export function createMonitoringController({ target, diagnostics, getConfig, fetchImpl, reporterBusy, cryptoLike, random = Math.random, now = Date.now, sdkVersion, setTimer, clearTimer }) {
  let consent = { errors: 'denied', performance: 'denied' };
  let started = false;
  let starting = false;
  const provisionalGrants = new Set();
  let consentRevision = 0;
  let generation = 0;
  let epochs = { errors: 0, performance: 0 };
  let runtimeSessionId = null;
  let runtimePageId = null;
  let pageEpoch = 0;
  let pageSealed = false;
  let pageSuspended = false;
  let sequence = 0;
  let idCounter = 0;
  let normalized = null;
  let aggregator = null;
  let budget = null;
  let remote = null;
  let drainTimer = null;
  let resources = { errors: [], performance: [], shared: [], route: [] };
  let measurements = new Map();
  let recent = [];
  const subscribers = new Map();
  const diagnosticAt = new Map();
  const drops = Object.fromEntries(DROP_KEYS.map((key) => [key, 0]));
  const timers = { set: setTimer || target?.setTimeout?.bind(target) || globalThis.setTimeout, clear: clearTimer || target?.clearTimeout?.bind(target) || globalThis.clearTimeout };

  function start(options = {}) {
    const candidate = normalizeOptions(options);
    if (started) {
      if (sameOptions(normalized, candidate)) return getState();
      warnOnce('restart_required', { category: 'monitoring_lifecycle', code: 'RESTART_REQUIRED' });
      throw sdkError('INVALID_ARGUMENT', { reasonCode: 'MONITORING_RESTART_REQUIRED' });
    }
    const nextGeneration = generation + 1;
    const nextSession = newId();
    const nextPage = newId();
    const nextAggregator = createMonitoringAggregator({ maxKeys: candidate.budgets.aggregationKeys, maxFingerprints: candidate.budgets.errorFingerprintsPerPage });
    const nextBudget = createMonitoringBudget(candidate.budgets, now);
    const nextRemote = createMonitoringRemote({ target, adapter: candidate.remoteAdapter, busy: reporterBusy, fetchImpl, getConfig, diagnostics, setTimer, clearTimer });
    const old = { normalized, aggregator, budget, remote, runtimeSessionId, runtimePageId, pageEpoch, pageSealed, pageSuspended, generation, started };
    normalized = candidate; aggregator = nextAggregator; budget = nextBudget; remote = nextRemote; runtimeSessionId = nextSession; runtimePageId = nextPage;
    pageEpoch += 1; pageSealed = false; pageSuspended = false; generation = nextGeneration; started = true;
    starting = true;
    try { installGranted(); }
    catch (error) {
      starting = false;
      disposeAll();
      measurements.clear();
      ({ normalized, aggregator, budget, remote, runtimeSessionId, runtimePageId, pageEpoch, pageSealed, pageSuspended, generation, started } = old);
      throw sdkError('MONITORING_START_FAILED', { cause: error });
    }
    starting = false;
    if (hasSampledGrant() && candidate.remoteAdapter) remote.start();
    return getState();
  }

  function stop() {
    consentRevision += 1;
    if (!started) return getState();
    started = false;
    epochs.errors += 1; epochs.performance += 1; generation += 1; pageEpoch += 1;
    cancelDrain(); disposeAll(); subscribers.clear();
    aggregator?.clear(); budget?.clear(); measurements.clear(); recent = [];
    normalized = null; aggregator = null; budget = null; remote = null; runtimeSessionId = null; runtimePageId = null; pageSealed = false; pageSuspended = false; sequence = 0;
    resetDrops();
    return getState();
  }

  function setConsent(next) {
    if (!plain(next) || Object.keys(next).some((key) => !['errors','performance'].includes(key)) || Object.values(next).some((value) => !['granted','denied'].includes(value))) throw sdkError('INVALID_ARGUMENT');
    const revision = ++consentRevision;
    // A provider/adapter may synchronously call back into consent while its
    // grant is being installed. Treat that call as an invalidation request;
    // the outer transaction will observe the revision and roll back instead
    // of recursively installing or resurrecting revoked resources.
    if (Object.keys(next).some((category) => provisionalGrants.has(category))) return getConsent();
    const desired = { ...consent, ...next };
    if (!started) { consent = desired; return getConsent(); }
    for (const category of ['errors','performance']) {
      if (desired[category] === consent[category]) continue;
      if (desired[category] === 'denied') {
        consent = { ...consent, [category]: 'denied' };
        epochs[category] += 1; disposeCategory(category); aggregator.clearCategory(category);
        if (!aggregator.dirty().length) cancelDrain();
        if (category === 'performance') measurements.clear();
        recent = recent.filter((item) => item.category !== category); remote.abortCategory?.(category);
      } else {
        const registry = [];
        const sharedRegistry = [];
        const routeRegistry = [];
        const projected = { ...consent, [category]: 'granted' };
        const transitionGeneration = generation;
        const transitionValid = () => started && generation === transitionGeneration && consentRevision === revision;
        const rollbackGrant = () => {
          disposeRegistry([...registry, ...sharedRegistry, ...routeRegistry], diagnostics, bump);
          if (category === 'performance') measurements.clear();
        };
        provisionalGrants.add(category);
        try {
          installCategory(category, registry);
          if (!transitionValid()) { rollbackGrant(); return getConsent(); }
          if (!resources.shared.length && hasSampledGrant(projected)) sharedRegistry.push(installBridgeCollector(diagnostics, record));
          if (!transitionValid()) { rollbackGrant(); return getConsent(); }
          if (!resources.route.length && normalized.routeAdapter && hasSampledGrant(projected)) routeRegistry.push(installRouteAdapter());
          if (!transitionValid()) { rollbackGrant(); return getConsent(); }
        }
        catch (error) { rollbackGrant(); throw sdkError('MONITORING_START_FAILED', { cause: error }); }
        finally { provisionalGrants.delete(category); }
        resources[category].push(...registry); resources.shared.push(...sharedRegistry); resources.route.push(...routeRegistry); consent = projected;
      }
    }
    if (!hasSampledGrant(consent)) {
      disposeRegistry(resources.route, diagnostics, bump); resources.route = [];
      disposeRegistry(resources.shared, diagnostics, bump); resources.shared = []; remote.stop();
    }
    if (hasSampledGrant() && normalized.remoteAdapter) remote.start();
    return getConsent();
  }

  function installGranted() {
    const installed = [];
    try {
      for (const category of ['errors','performance']) if (consent[category] === 'granted') {
        const registry = [];
        installCategory(category, registry);
        resources[category].push(...registry); installed.push(...registry);
      }
      if (hasSampledGrant(consent)) {
        const bridgeOff = installBridgeCollector(diagnostics, record); resources.shared.push(bridgeOff); installed.push(bridgeOff);
        if (normalized.routeAdapter) { const routeOff = installRouteAdapter(); resources.route.push(routeOff); installed.push(routeOff); }
      }
    } catch (error) { disposeRegistry(installed, diagnostics, bump); resources = { errors: [], performance: [], shared: [], route: [] }; throw error; }
  }

  function installCategory(category, temporary, destination) {
    if (!sampled(category)) return;
    const registry = destination || temporary;
    if (category === 'errors') registry.push(installErrorCollectors(target, record));
    else {
      registry.push(installPerformanceCollectors(target, setMeasurement, pageBoundary, pageRestore, (capability) => { warnOnce(`collector:${capability}`, { category: 'monitoring_collector', code: 'UNAVAILABLE', reason: capability }); bump('collector_unavailable'); }));
    }
  }

  function installRouteAdapter() {
    const off = normalized.routeAdapter.subscribe(routeBoundary);
    if (typeof off !== 'function') throw new TypeError('invalid route unsubscribe');
    return off;
  }

  function record(tuple) {
    const category = tuple.category;
    if (!started || starting || consent[category] !== 'granted' || !sampled(category)) return;
    const fence = { generation, epoch: epochs[category], pageEpoch };
    if (category === 'errors' && cryptoLike?.subtle) {
      const hashSource = stableStringify({ signal: tuple.signal, errorClass: tuple.errorClass, locationClass: tuple.locationClass, resourceClass: tuple.resourceClass, api: tuple.api, outcome: tuple.outcome });
      Promise.resolve(cryptoLike.subtle.digest('SHA-256', new TextEncoder().encode(hashSource))).then((bytes) => {
        if (!validRecordFence(category, fence)) return;
        addTuple(tuple.signal === 'resource_error' ? tuple : { ...tuple, fingerprint: hex(bytes) });
      }).catch(() => { diagnostics.emit('warn', { category: 'monitoring_fingerprint', code: 'UNAVAILABLE' }); if (validRecordFence(category, fence)) addTuple(tuple); });
    } else addTuple(tuple);
  }

  function addTuple(tuple) {
    const result = aggregator.add(tuple);
    if (result === 'other') bump('aggregation_other');
    if (result === 'rejected') { bump('aggregation_rejected'); return; }
    if (!drainTimer) drainTimer = timers.set(() => { drainTimer = null; drainDirty(); }, LIMITS.monitoring.drainMs);
  }

  function drainDirty(category) {
    if (!started) return;
    for (const [key, item] of aggregator.dirty(category)) {
      const count = item.dirty;
      aggregator.consume(key);
      emitTuple(item.tuple, count);
    }
  }

  function emitTuple(tuple, count) {
    const category = tuple.category;
    if (!started || consent[category] !== 'granted') return;
    const summary = { ...tuple, count }; delete summary.category; delete summary.signal; delete summary.requestId;
    const contextExtra = tuple.requestId ? { requestId: tuple.requestId } : {};
    emitEnvelope(category, tuple.signal, summary, contextExtra);
  }

  function setMeasurement(metric, value, unit, availability = 'available') {
    if (!started || (consent.performance !== 'granted' && !provisionalGrants.has('performance')) || pageSealed || !Number.isFinite(value) || value < 0 || !['available','unavailable'].includes(availability)) return;
    const current = measurements.get(metric);
    if (availability === 'unavailable') {
      if (!current) measurements.set(metric, { metric, value: 0, unit, availability });
      return;
    }
    if (!current || current.availability === 'unavailable' || metric === 'CLS' || value > current.value) measurements.set(metric, { metric, value: metric === 'CLS' && current?.availability === 'available' ? current.value + value : value, unit, availability });
  }
  function pageBoundary(persisted = false) {
    if (!started || starting) return;
    if (persisted && pageSuspended) return;
    cancelDrain(); drainDirty(); sealMeasurements();
    pageSealed = true;
    if (persisted) pageSuspended = true;
  }
  function pageRestore() { if (started && pageSuspended) pageSuspended = false; }
  function routeBoundary() {
    if (!started || starting) return;
    pageBoundary(false); pageEpoch += 1; runtimePageId = newId(); measurements.clear(); aggregator.resetPage(); budget.resetPage(); pageSealed = false; pageSuspended = false;
  }
  function sealMeasurements() {
    if (consent.performance !== 'granted' || !measurements.size) return;
    const nav = measurements.get('navigation');
    const vitals = [...measurements.values()].filter((item) => item.metric !== 'navigation');
    if (vitals.length) emitEnvelope('performance', 'web_vitals', { count: 1, measurements: vitals });
    if (nav) emitEnvelope('performance', 'navigation', { count: 1, measurements: [nav] });
    measurements.clear();
  }

  function emitEnvelope(category, signal, summary, contextExtra = {}) {
    const fence = { generation, epoch: epochs[category] };
    let envelope = sanitizeEnvelope({ schema: 'supersdk.monitoring.v1', envelopeId: newId(), sequence: Math.min(2147483647, ++sequence), emittedAtMs: now(), category, signal, platform: 'web', context: { ...context(), ...contextExtra }, summary });
    if (!envelope) { diagnostics.emit('warn', { category: 'monitoring_envelope', code: 'INVALID_ENVELOPE' }); bump('invalid_envelope'); return; }
    if (normalized.beforeSend) {
      try { envelope = normalized.beforeSend(envelope); }
      catch (_) { thirdPartyError('monitoring_hook'); bump('before_send'); return; }
      if (envelope == null) { bump('before_send'); return; }
      envelope = sanitizeEnvelope(envelope);
      if (!envelope) { thirdPartyError('monitoring_hook'); bump('before_send'); return; }
    }
    const budgetReason = budget.admit(envelope, remote.bodyFor(envelope));
    if (budgetReason) { bump('budget'); return; }
    recent.push(envelope); if (recent.length > LIMITS.monitoring.recentEnvelopes) recent.shift();
    fanout(envelope);
    Promise.resolve(remote.deliver(envelope, () => validFence(category, fence))).then((outcome) => {
      if (DROP_KEYS.includes(outcome)) bump(outcome);
    }).catch(() => bump('remote_adapter_error'));
  }

  function fanout(envelope) {
    const fence = { generation, epoch: epochs[envelope.category] };
    for (const [listener, state] of [...subscribers]) {
      if (state.pending >= LIMITS.monitoring.subscriberQueue) { bump('subscriber_busy'); continue; }
      state.pending += 1;
      queueMicrotask(() => {
        try { if (validFence(envelope.category, fence)) listener(envelope); }
        catch (_) { thirdPartyError('monitoring_subscriber'); bump('subscriber_error'); }
        finally { state.pending -= 1; }
      });
    }
  }

  function getState() {
    const active = started && (consent.errors === 'granted' || consent.performance === 'granted');
    return deepFreeze({ status: !started ? 'stopped' : active ? 'active' : 'dormant', generation, consent: getConsent(), runtimeSessionId, activeCollectors: activeCollectors(), remoteStatus: remote?.status() || 'disabled' });
  }
  function getConsent() { return Object.freeze({ ...consent }); }
  function getSnapshot() { return deepFreeze({ state: getState(), context: started ? context() : null, aggregates: aggregator?.snapshot() || [], measurements: [...measurements.values()], drops: { ...drops }, recent: [...recent] }); }
  function onEnvelope(listener) { if (typeof listener !== 'function') throw sdkError('INVALID_ARGUMENT'); const state = { pending: 0 }; subscribers.set(listener, state); return () => subscribers.delete(listener); }
  function context() { return { sdkVersion, runtimeSessionId, runtimePageId, ...readCorrelation(target, diagnostics) }; }
  function sampled(category) { return normalized ? normalized.sampled[category] : false; }
  function hasSampledGrant(value = consent) { return ['errors','performance'].some((category) => value[category] === 'granted' && sampled(category)); }
  function validFence(category, fence) { return started && generation === fence.generation && epochs[category] === fence.epoch && consent[category] === 'granted'; }
  function validRecordFence(category, fence) { return validFence(category, fence) && pageEpoch === fence.pageEpoch; }
  function activeCollectors() { const output = []; if (resources.errors.length) output.push('errors'); if (resources.performance.length) output.push('performance'); if (resources.shared.length) output.push('jsb'); return output; }
  function cancelDrain() { if (drainTimer != null) timers.clear(drainTimer); drainTimer = null; }
  function disposeCategory(category) { disposeRegistry(resources[category], diagnostics, bump); resources[category] = []; if (!aggregator.dirty().length) cancelDrain(); }
  function disposeAll() { cancelDrain(); remote?.stop(); for (const key of ['errors','performance','shared','route']) disposeRegistry(resources[key], diagnostics, bump); resources = { errors: [], performance: [], shared: [], route: [] }; }
  function bump(key) {
    if (!Object.hasOwn(drops, key)) return;
    drops[key] = Math.min(2147483647, drops[key] + 1);
    if (['aggregation_other','aggregation_rejected','budget','collector_unavailable','subscriber_busy','remote_busy','business_priority','native_business_priority_unknown','invalid_envelope'].includes(key)) {
      warnOnce(`drop:${key}`, { category: 'monitoring_drop', code: key.toUpperCase() });
    }
  }
  function resetDrops() { for (const key of DROP_KEYS) drops[key] = 0; }
  function newId() { return `${createUUID(cryptoLike, random)}:${++idCounter}`; }
  function thirdPartyError(category) { const at=now(); if ((diagnosticAt.get(category) ?? -Infinity) <= at-60_000) { diagnosticAt.set(category,at); diagnostics.emit('error', { category, code: 'CALLBACK_ERROR' }); } }
  function warnOnce(key, metadata) { const at=now(); if ((diagnosticAt.get(key) ?? -Infinity) <= at-60_000) { diagnosticAt.set(key,at); diagnostics.emit('warn', metadata); } }

  return Object.freeze({ start, stop, getState, getSnapshot, onEnvelope, setConsent, getConsent });

  function normalizeOptions(input) {
    if (!plain(input)) throw sdkError('INVALID_ARGUMENT');
    const allowed = ['budgets','sampleRates','beforeSend','routeAdapter','remoteAdapter'];
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw sdkError('INVALID_ARGUMENT');
    const sampleRates = input.sampleRates || {};
    if (!plain(sampleRates) || Object.keys(sampleRates).some((key) => !['errors','performance'].includes(key))) throw sdkError('INVALID_ARGUMENT');
    for (const value of Object.values(sampleRates)) if (!Number.isFinite(value) || value < 0 || value > 1) throw sdkError('INVALID_ARGUMENT');
    if (input.beforeSend !== undefined && typeof input.beforeSend !== 'function') throw sdkError('INVALID_ARGUMENT');
    if (input.routeAdapter !== undefined && (!plain(input.routeAdapter) || typeof input.routeAdapter.subscribe !== 'function')) throw sdkError('INVALID_ARGUMENT');
    const adapter = input.remoteAdapter;
    if (adapter !== undefined && !(plain(adapter) && (adapter.kind === 'reportEventV2' ? Object.keys(adapter).length === 1 : typeof adapter.deliver === 'function'))) throw sdkError('INVALID_ARGUMENT');
    if (adapter !== undefined && typeof (target?.AbortController || globalThis.AbortController) !== 'function') throw sdkError('INVALID_ARGUMENT', { reasonCode: 'MONITORING_ABORT_UNAVAILABLE' });
    if (adapter?.kind === 'reportEventV2') {
      const config = getConfig();
      if (!config?.spid || !config?.environment || !config?.baseUrls?.length || typeof fetchImpl !== 'function') throw sdkError('MONITORING_TRANSPORT_NOT_CONFIGURED');
    }
    const rates = { errors: sampleRates.errors ?? 1, performance: sampleRates.performance ?? 1 };
    const remoteAdapter = adapter?.kind === 'reportEventV2' ? Object.freeze({ kind: 'reportEventV2' })
      : adapter ? Object.freeze({ deliver: adapter.deliver.bind(adapter) }) : undefined;
    return { budgets: normalizeMonitoringBudgets(input.budgets), sampleRates: rates, sampled: { errors: random() < rates.errors, performance: random() < rates.performance }, beforeSend: input.beforeSend, routeAdapter: input.routeAdapter, remoteAdapter, remoteSource: adapter };
  }
}

function readCorrelation(target, diagnostics) {
  try {
    const raw = target?.appbridge?.getMonitoringContext?.();
    const input = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parseContainerCorrelation(input) || {};
  } catch (_) { diagnostics.emit('warn', { category: 'monitoring_context', code: 'INVALID_CONTEXT' }); return {}; }
}
function sameOptions(left, right) { const remoteSame = left?.remoteAdapter?.kind === 'reportEventV2' && right?.remoteAdapter?.kind === 'reportEventV2' || left?.remoteSource === right?.remoteSource; return Boolean(left && right && stableStringify(left.budgets) === stableStringify(right.budgets) && stableStringify(left.sampleRates) === stableStringify(right.sampleRates) && left.beforeSend === right.beforeSend && left.routeAdapter === right.routeAdapter && remoteSame); }
function disposeRegistry(registry, diagnostics, bump) { for (const dispose of [...(registry || [])].reverse()) { try { dispose?.(); } catch (_) { diagnostics?.emit('error', { category: 'monitoring_teardown', code: 'CALLBACK_ERROR' }); bump?.('teardown_error'); } } }
function plain(value) { return Object.prototype.toString.call(value) === '[object Object]' && [null, Object.prototype].includes(Object.getPrototypeOf(value)); }
function hex(buffer) { return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join(''); }
