// TC T-006/T-017; ci_reason: performance page/route lifecycle contract.
import test from 'node:test'; import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/runtime/createSuperSDK.js'; import { monitoringTarget } from './helpers.mjs';
test('explicit route seals navigation and rotates only runtime page id',async()=>{
 let route;const target=monitoringTarget({performance:{getEntriesByType:()=>[{duration:9}]}});const sdk=createSuperSDK({target,crypto:{},random:()=>0.4});sdk.monitoring.setConsent({performance:'granted'});sdk.monitoring.start({routeAdapter:{subscribe(fn){route=fn;return()=>{};}}});
 const before=sdk.monitoring.getSnapshot().context;route();await new Promise(r=>queueMicrotask(r));const after=sdk.monitoring.getSnapshot();assert.equal(after.context.runtimeSessionId,before.runtimeSessionId);assert.notEqual(after.context.runtimePageId,before.runtimePageId);assert.ok(after.recent.some(item=>item.signal==='navigation'));
});

test('missing observer and individual entry-type failures expose fixed unavailable measurements without blocking supported metrics',()=>{
  const missingTarget=monitoringTarget();const missingSDK=createSuperSDK({target:missingTarget,crypto:{},random:()=>0.42});missingSDK.monitoring.setConsent({performance:'granted'});missingSDK.monitoring.start();
  const missing=new Map(missingSDK.monitoring.getSnapshot().measurements.map(item=>[item.metric,item]));
  for(const [metric,unit] of [['FCP','ms'],['LCP','ms'],['CLS','score'],['INP','ms'],['navigation','ms']])assert.deepEqual(missing.get(metric),{metric,value:0,unit,availability:'unavailable'});

  const observers=[];class PartialObserver{constructor(callback){this.callback=callback;}observe({type}){if(['largest-contentful-paint','event'].includes(type))throw new Error('unsupported');this.type=type;observers.push(this);}disconnect(){}}
  const partialTarget=monitoringTarget({PerformanceObserver:PartialObserver,performance:{getEntriesByType:()=>[{duration:7}]}});const partialSDK=createSuperSDK({target:partialTarget,crypto:{},random:()=>0.43});partialSDK.monitoring.setConsent({performance:'granted'});partialSDK.monitoring.start();
  observers.find(item=>item.type==='paint').callback({getEntries:()=>[{name:'first-contentful-paint',startTime:3}]});observers.find(item=>item.type==='layout-shift').callback({getEntries:()=>[{hadRecentInput:false,value:0.25}]});
  const partial=new Map(partialSDK.monitoring.getSnapshot().measurements.map(item=>[item.metric,item]));
  assert.deepEqual(partial.get('LCP'),{metric:'LCP',value:0,unit:'ms',availability:'unavailable'});assert.deepEqual(partial.get('INP'),{metric:'INP',value:0,unit:'ms',availability:'unavailable'});
  assert.deepEqual(partial.get('FCP'),{metric:'FCP',value:3,unit:'ms',availability:'available'});assert.deepEqual(partial.get('CLS'),{metric:'CLS',value:0.25,unit:'score',availability:'available'});assert.deepEqual(partial.get('navigation'),{metric:'navigation',value:7,unit:'ms',availability:'available'});
});

test('BFCache seals performance once, preserves page identity and observers, then SPA resumes collection on a new page',()=>{
  let route;const observers=[];class Observer{constructor(callback){this.callback=callback;observers.push(this);}observe({type}){this.type=type;}disconnect(){}}
  const target=monitoringTarget({PerformanceObserver:Observer,performance:{getEntriesByType:()=>[{duration:9}]}});const sdk=createSuperSDK({target,crypto:{},random:()=>0.44});sdk.monitoring.setConsent({performance:'granted'});sdk.monitoring.start({routeAdapter:{subscribe(fn){route=fn;return()=>{};}}});
  const page=sdk.monitoring.getSnapshot().context.runtimePageId;assert.equal(observers.length,4);assert.equal(target.listenerCount('pageshow'),1);
  target.dispatch('pagehide',{persisted:true});assert.equal(sdk.monitoring.getSnapshot().recent.filter(item=>item.signal==='navigation').length,1);
  target.dispatch('pageshow',{persisted:true});assert.equal(sdk.monitoring.getSnapshot().context.runtimePageId,page);assert.equal(observers.length,4);
  observers.find(item=>item.type==='largest-contentful-paint').callback({getEntries:()=>[{startTime:20}]});target.dispatch('pagehide',{persisted:true});assert.equal(sdk.monitoring.getSnapshot().recent.length,1);
  route();const spaPage=sdk.monitoring.getSnapshot().context.runtimePageId;assert.notEqual(spaPage,page);observers.find(item=>item.type==='largest-contentful-paint').callback({getEntries:()=>[{startTime:30}]});route();
  const recent=sdk.monitoring.getSnapshot().recent;assert.equal(recent.filter(item=>item.signal==='navigation').length,1);assert.equal(recent.filter(item=>item.signal==='web_vitals').length,1);assert.equal(observers.length,4);
  sdk.monitoring.stop();assert.equal(target.listenerCount('pageshow'),0);
});
