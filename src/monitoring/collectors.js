export function installErrorCollectors(target, record) {
  if (typeof target?.addEventListener !== 'function') return () => {};
  const onError = (event) => {
    const resourceClass = classifyResource(event?.target);
    if (resourceClass) record({ category: 'errors', signal: 'resource_error', resourceClass, locationClass: 'unknown' });
    else record({ category: 'errors', signal: 'js_exception', errorClass: classifyError(event?.error), locationClass: 'unknown' });
  };
  const onRejection = (event) => record({ category: 'errors', signal: 'unhandled_rejection', errorClass: classifyError(event?.reason) });
  target.addEventListener('error', onError, true);
  target.addEventListener('unhandledrejection', onRejection);
  return () => { target.removeEventListener?.('error', onError, true); target.removeEventListener?.('unhandledrejection', onRejection); };
}

export function installPerformanceCollectors(target, setMeasurement, sealPage, restorePage, unavailable = () => {}) {
  const observers = [];
  const definitions = [
    ['paint', 'FCP', 'ms', (entry) => entry.name === 'first-contentful-paint' && setMeasurement('FCP', entry.startTime, 'ms')],
    ['largest-contentful-paint', 'LCP', 'ms', (entry) => setMeasurement('LCP', entry.startTime, 'ms')],
    ['layout-shift', 'CLS', 'score', (entry) => !entry.hadRecentInput && setMeasurement('CLS', entry.value, 'score')],
    ['event', 'INP', 'ms', (entry) => entry.name === 'click' && setMeasurement('INP', entry.duration, 'ms')]
  ];
  const Observer = target?.PerformanceObserver;
  if (typeof Observer === 'function') {
    for (const [type, metric, unit, consume] of definitions) {
      let observer;
      try {
        observer = new Observer((list) => { for (const entry of list.getEntries()) consume(entry); });
        observer.observe({ type, buffered: true }); observers.push(observer);
      } catch (_) { observer?.disconnect?.(); setMeasurement(metric, 0, unit, 'unavailable'); unavailable(type); }
    }
  } else for (const [type, metric, unit] of definitions) { setMeasurement(metric, 0, unit, 'unavailable'); unavailable(type); }
  try {
    const nav = target?.performance?.getEntriesByType?.('navigation')?.[0];
    if (nav && Number.isFinite(nav.duration)) setMeasurement('navigation', nav.duration, 'ms');
    else { setMeasurement('navigation', 0, 'ms', 'unavailable'); unavailable('navigation'); }
  } catch (_) { setMeasurement('navigation', 0, 'ms', 'unavailable'); unavailable('navigation'); }
  const onPageHide = (event) => sealPage(Boolean(event?.persisted));
  const onPageShow = (event) => { if (event?.persisted) restorePage(); };
  target?.addEventListener?.('pagehide', onPageHide);
  target?.addEventListener?.('pageshow', onPageShow);
  return () => { for (const observer of observers) observer.disconnect?.(); target?.removeEventListener?.('pagehide', onPageHide); target?.removeEventListener?.('pageshow', onPageShow); };
}

export function installBridgeCollector(diagnostics, record) {
  return diagnostics.subscribe((item) => {
    if (item.category !== 'bridge_operation' || !item.api || !item.outcome) return;
    const failure = !['success','cancelled'].includes(item.outcome);
    record({
      category: failure ? 'errors' : 'performance', signal: 'jsb_operation', api: item.api,
      outcome: normalizeOutcome(item.outcome), latencyBucket: normalizeLatency(item.latencyBucket),
      ...(failure ? { errorClass: normalizeErrorClass(item.errorClass, item.outcome) } : {}),
      ...(item.requestId ? { requestId: item.requestId } : {})
    });
  });
}

export function classifyError(value) {
  const name = typeof value === 'object' && value ? value.name : typeof value;
  if (name === 'TypeError') return 'type_error';
  if (name === 'RangeError') return 'range_error';
  if (name === 'SyntaxError') return 'syntax_error';
  return 'unknown';
}

function classifyResource(target) {
  const tag = String(target?.tagName || '').toLowerCase();
  return ({ script: 'script', link: 'style', img: 'image', image: 'image', video: 'media', audio: 'media', source: 'media' })[tag] || null;
}
function normalizeOutcome(value) { return ['success','cancelled','timeout','unsupported','failure','terminated','unavailable'].includes(value) ? value : 'failure'; }
function normalizeLatency(value) { return ['lt10ms','lt100ms','lt1s','lt10s','gte10s','unknown'].includes(value) ? value : 'unknown'; }
function normalizeErrorClass(value, outcome) {
  const allowed = ['type_error','range_error','syntax_error','network','timeout','unsupported','native','business','process_terminated','unknown'];
  if (allowed.includes(value)) return value;
  if (outcome === 'timeout') return 'timeout';
  if (outcome === 'unsupported') return 'unsupported';
  return 'native';
}
