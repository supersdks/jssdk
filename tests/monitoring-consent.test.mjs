// TC T-002/T-003; ci_reason: P0 independent consent and hot-revoke fencing.
import test from 'node:test'; import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/runtime/createSuperSDK.js'; import { monitoringTarget } from './helpers.mjs';
test('consent matrix stays independent from analytics and failed hot grant rolls back',async()=>{
  for(const errors of ['denied','granted'])for(const performance of ['denied','granted']){
    const target=monitoringTarget();const sdk=createSuperSDK({target,crypto:{},random:()=>0.2});
    sdk.init({spid:'ab12cd34',analyticsConsent:'denied'});sdk.monitoring.setConsent({errors,performance});sdk.monitoring.start();
    assert.equal(target.listenerCount('error'),errors==='granted'?1:0);assert.equal(target.listenerCount('pagehide'),performance==='granted'?1:0);
    assert.equal(sdk.getAnalyticsConsent(),'denied');await assert.rejects(sdk.reportEvent('monitoring-must-not-grant-analytics',{}),error=>error.code==='CONSENT_DENIED');sdk.monitoring.stop();
  }
  const target=monitoringTarget();const sdk=createSuperSDK({target,crypto:{},random:()=>0.2});sdk.monitoring.start({routeAdapter:{subscribe(){throw new Error('private');}}});
  assert.throws(()=>sdk.monitoring.setConsent({performance:'granted'}),error=>error.code==='MONITORING_START_FAILED');assert.deepEqual(sdk.monitoring.getConsent(),{errors:'denied',performance:'denied'});assert.equal(target.listenerCount('pagehide'),0);assert.equal(sdk.monitoring.getState().status,'dormant');
});
test('partial revoke clears only its category and does not seal dirty data', async()=>{
  const target=monitoringTarget({performance:{getEntriesByType:()=>[{duration:12}]}}); const sdk=createSuperSDK({target,crypto:{},random:()=>0.2});
  sdk.monitoring.setConsent({errors:'granted',performance:'granted'}); sdk.monitoring.start();
  target.dispatch('error',{error:new TypeError()}); assert.equal(target.timerCount(5000),1);
  sdk.monitoring.setConsent({errors:'denied'}); assert.equal(sdk.monitoring.getState().status,'active');
  assert.equal(sdk.monitoring.getSnapshot().aggregates.some(x=>x.category==='errors'),false); assert.ok(sdk.monitoring.getSnapshot().measurements.length);
  assert.equal(target.runTimer(5000),false); await Promise.resolve(); assert.equal(sdk.monitoring.getSnapshot().recent.length,0);
});

test('shared JSB and route resources follow sampled grants, including hot grant and revoke',()=>{
  const zeroTarget=monitoringTarget();const zeroSDK=createSuperSDK({target:zeroTarget,crypto:{},random:()=>0.2});zeroSDK.monitoring.setConsent({errors:'granted',performance:'granted'});zeroSDK.monitoring.start({sampleRates:{errors:0,performance:0}});
  assert.deepEqual(zeroSDK.monitoring.getState().activeCollectors,[]);assert.equal(zeroTarget.listenerCount('error'),0);assert.equal(zeroTarget.listenerCount('pagehide'),0);zeroSDK.__diagnostics.emit('info',{category:'bridge_operation',api:'device.getEnv',outcome:'success',latencyBucket:'lt10ms'});assert.equal(zeroTarget.timerCount(5000),0);assert.equal(zeroSDK.monitoring.getSnapshot().aggregates.length,0);

  let routeInstalls=0;let routeDisposes=0;const target=monitoringTarget();const sdk=createSuperSDK({target,crypto:{},random:()=>0.2});sdk.monitoring.start({sampleRates:{errors:0,performance:1},routeAdapter:{subscribe(){routeInstalls+=1;return()=>{routeDisposes+=1;};}}});
  sdk.monitoring.setConsent({errors:'granted'});assert.deepEqual(sdk.monitoring.getState().activeCollectors,[]);assert.equal(routeInstalls,0);
  sdk.monitoring.setConsent({performance:'granted'});assert.deepEqual(new Set(sdk.monitoring.getState().activeCollectors),new Set(['performance','jsb']));assert.equal(routeInstalls,1);
  sdk.__diagnostics.emit('info',{category:'bridge_operation',api:'device.getEnv',outcome:'success',latencyBucket:'lt10ms'});assert.equal(target.timerCount(5000),1);
  sdk.monitoring.setConsent({performance:'denied'});assert.deepEqual(sdk.monitoring.getState().activeCollectors,[]);assert.equal(routeDisposes,1);assert.equal(target.listenerCount('pagehide'),0);assert.equal(target.listenerCount('pageshow'),0);assert.equal(target.timerCount(5000),0);
  sdk.__diagnostics.emit('info',{category:'bridge_operation',api:'device.getEnv',outcome:'success',latencyBucket:'lt10ms'});assert.equal(target.timerCount(5000),0);
});

test('hot performance grant preserves synchronous navigation and unavailable measurements',()=>{
  const target=monitoringTarget({PerformanceObserver:undefined,performance:{getEntriesByType:()=>[{duration:23}]}});const sdk=createSuperSDK({target,crypto:{},random:()=>0.2});
  sdk.monitoring.start();assert.deepEqual(sdk.monitoring.getSnapshot().measurements,[]);
  sdk.monitoring.setConsent({performance:'granted'});
  const measurements=new Map(sdk.monitoring.getSnapshot().measurements.map(item=>[item.metric,item]));
  assert.deepEqual(measurements.get('navigation'),{metric:'navigation',value:23,unit:'ms',availability:'available'});
  for(const metric of ['FCP','LCP','CLS','INP'])assert.equal(measurements.get(metric)?.availability,'unavailable');
});

test('reentrant revoke during hot grant invalidates and rolls back provisional resources',()=>{
  let routeDisposes=0;let sdk;const target=monitoringTarget({performance:{getEntriesByType:()=>[{duration:11}]}});
  sdk=createSuperSDK({target,crypto:{},random:()=>0.2});sdk.monitoring.start({routeAdapter:{subscribe(){sdk.monitoring.setConsent({performance:'denied'});return()=>{routeDisposes+=1;};}}});
  assert.deepEqual(sdk.monitoring.setConsent({performance:'granted'}),{errors:'denied',performance:'denied'});
  assert.equal(sdk.monitoring.getState().status,'dormant');assert.equal(routeDisposes,1);assert.equal(target.listenerCount('pagehide'),0);assert.equal(target.listenerCount('pageshow'),0);assert.deepEqual(sdk.monitoring.getSnapshot().measurements,[]);
});
