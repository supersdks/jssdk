import { LIMITS } from '../core/limits.js';
import { isPlainObject, joinApiUrl } from '../core/utils.js';
import { readJsonWithSuEnc } from '../suenc/codec.js';

export function buildMonitoringReportBody(config, envelope) {
  return JSON.stringify({
    basic_data: {
      host_spid: config.spid, env: config.environment, os_type: 'web',
      platform_id: 'web_sdk', device_id: '', source: 'web_sdk_monitoring_untrusted'
    },
    events: [{
      event_name: 'super_sdk_monitoring_v1',
      event_param: { evt_unique_id: envelope.envelopeId, monitoring: envelope },
      client_ts_ms: envelope.emittedAtMs
    }]
  });
}

export function createMonitoringRemote({ target, adapter, busy, fetchImpl, getConfig, diagnostics, setTimer, clearTimer }) {
  let active = null;
  let degraded = false;
  let unsubscribe = null;
  let lastErrorAt = -Infinity;
  const blocked = Boolean(target?.appbridge);
  const timers = { set: setTimer || target?.setTimeout?.bind(target) || globalThis.setTimeout, clear: clearTimer || target?.clearTimeout?.bind(target) || globalThis.clearTimeout };

  function start() {
    if (!adapter || blocked || degraded || unsubscribe) return;
    busy?.ensureHydrated?.();
    unsubscribe = busy?.subscribeBusy?.((value) => { if (value) active?.abort('business_priority'); }) || null;
  }
  function stop() { unsubscribe?.(); unsubscribe = null; active?.abort('stopped'); active = null; }
  function status() { return blocked && adapter ? 'blocked' : degraded ? 'degraded' : active ? 'in_flight' : adapter ? 'ready' : 'disabled'; }
  function bodyFor(envelope) { return adapter?.kind === 'reportEventV2' ? buildMonitoringReportBody(getConfig() || {}, envelope) : null; }

  async function deliver(envelope, fence) {
    if (!adapter || blocked || degraded) return blocked ? 'native_business_priority_unknown' : 'disabled';
    if (active) return 'remote_busy';
    if (busy?.isBusy?.()) return 'business_priority';
    const AbortControllerLike = target?.AbortController || globalThis.AbortController;
    const controller = new AbortControllerLike();
    let reason = null;
    let timer = null;
    let terminate;
    const terminated = new Promise((_, reject) => { terminate = reject; });
    const operation = { category: envelope.category, abort(next) { if (reason) return; reason = next; controller?.abort(); terminate(new Error(next)); } };
    active = operation;
    timer = timers.set(() => operation.abort('timeout'), LIMITS.monitoring.remoteDeadlineMs);
    try {
      const delivery = Promise.resolve().then(() => adapter.kind === 'reportEventV2'
        ? deliverBuiltIn(getConfig(), envelope, controller.signal, fetchImpl)
        : adapter.deliver(envelope, { signal: controller.signal }));
      delivery.catch(() => undefined);
      await Promise.race([delivery, terminated]);
      return fence() ? 'success' : 'stale';
    } catch (_) {
      if (reason === 'timeout') { degraded = true; reportError('TIMEOUT'); return 'remote_adapter_timeout'; }
      if (reason === 'business_priority') return 'business_priority';
      if (reason === 'stopped') return 'stale';
      reportError('ADAPTER_ERROR');
      return 'remote_adapter_error';
    } finally {
      if (timer != null) timers.clear(timer);
      if (active === operation) active = null;
      if (degraded) { unsubscribe?.(); unsubscribe = null; }
    }
  }
  function reportError(code) { const at=Date.now(); if (lastErrorAt<=at-60_000) { lastErrorAt=at; diagnostics.emit('error', { category: 'monitoring_remote', code }); } }
  return Object.freeze({ start, stop, status, deliver, bodyFor, isBlocked: () => blocked, abortCategory(category) { if (active?.category === category) active.abort('stopped'); } });
}

async function deliverBuiltIn(config, envelope, signal, fetchImpl) {
  if (!config?.spid || !config?.environment || !config?.baseUrls?.length || typeof fetchImpl !== 'function') throw new Error('not configured');
  const response = await fetchImpl(joinApiUrl(config.baseUrls[0], '/v2/reportEvent'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Aid': config.spid, 'X-Super-API-ENV': config.environment },
    body: buildMonitoringReportBody(config, envelope), signal
  });
  let body;
  try { body = await readJsonWithSuEnc(response); } catch (_) { throw new Error('protocol'); }
  if (!(response.status >= 200 && response.status < 300 && isPlainObject(body) && (body.code === 'SUCCESS' || body.code === 0))) throw new Error('protocol');
}
