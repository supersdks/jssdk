// TC T-001/T-023; ci_reason: P0 lifecycle generation and teardown contract.
import test from 'node:test'; import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/runtime/createSuperSDK.js'; import { monitoringTarget } from './helpers.mjs';
test('monitoring is zero-resource by default and tears down a generation', () => {
  const target=monitoringTarget(); const sdk=createSuperSDK({target,crypto:{},random:()=>0.1});
  assert.deepEqual(sdk.monitoring.getConsent(),{errors:'denied',performance:'denied'});
  assert.equal(sdk.monitoring.start().status,'dormant'); assert.equal(target.listenerCount('error'),0);
  sdk.monitoring.setConsent({errors:'granted'}); assert.equal(target.listenerCount('error'),1);
  const running=sdk.monitoring.getState(); const stopped=sdk.monitoring.stop(); assert.equal(stopped.generation,running.generation+1); assert.equal(target.listenerCount('error'),0);
  assert.equal(sdk.monitoring.stop().generation,stopped.generation);
});

test('same start is idempotent, changed start fails with a stable restart reason, and recent delivery stays bounded', async () => {
  const target=monitoringTarget(); const sdk=createSuperSDK({target,crypto:{},random:()=>0.1});
  sdk.monitoring.setConsent({performance:'granted'});
  const options={budgets:{pageEnvelopes:40,sessionEnvelopes:100,bytesPerMinute:20*1024,envelopeBytes:16*1024,aggregationKeys:100,errorFingerprintsPerPage:10}};
  const first=sdk.monitoring.start(options); const second=sdk.monitoring.start(options);
  assert.equal(second.generation,first.generation); assert.equal(target.listenerCount('pagehide'),1);
  assert.throws(()=>sdk.monitoring.start({sampleRates:{performance:0.5}}),error=>error.code==='INVALID_ARGUMENT'&&error.reasonCode==='MONITORING_RESTART_REQUIRED');
  assert.equal(sdk.monitoring.getState().generation,first.generation); assert.equal(target.listenerCount('pagehide'),1);
  for(let index=0;index<25;index+=1)sdk.__diagnostics.emit('info',{category:'bridge_operation',api:`api.${index}`,outcome:'success',latencyBucket:'lt10ms'});
  target.runTimer(5000); await new Promise(resolve=>queueMicrotask(resolve));
  assert.equal(sdk.monitoring.getSnapshot().recent.length,20);
});
