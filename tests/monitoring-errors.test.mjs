// TC T-004; ci_reason: P0 bounded error aggregation and delta delivery.
import test from 'node:test'; import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/runtime/createSuperSDK.js'; import { monitoringTarget } from './helpers.mjs';
test('error snapshot is cumulative while fixed-window envelopes are delta',async()=>{
 const target=monitoringTarget();const sdk=createSuperSDK({target,crypto:{},random:()=>0.3});sdk.monitoring.setConsent({errors:'granted'});sdk.monitoring.start();const seen=[];sdk.monitoring.onEnvelope(e=>seen.push(e));
 target.dispatch('error',{error:new TypeError()});target.dispatch('error',{error:new TypeError()});assert.equal(target.timerCount(5000),1);target.runTimer(5000);await new Promise(r=>queueMicrotask(r));
 assert.equal(seen[0].summary.count,2);assert.equal(sdk.monitoring.getSnapshot().aggregates[0].count,2);
 target.dispatch('error',{error:new TypeError()});target.runTimer(5000);await new Promise(r=>queueMicrotask(r));assert.equal(seen[1].summary.count,1);assert.equal(sdk.monitoring.getSnapshot().aggregates[0].count,3);
});
test('resource and rejection collectors classify metadata without retaining raw error text',async()=>{
 const target=monitoringTarget();const sdk=createSuperSDK({target,crypto:{},random:()=>0.31});sdk.monitoring.setConsent({errors:'granted'});sdk.monitoring.start();
 target.dispatch('error',{target:{tagName:'IMG'},message:'https://private.invalid/a?token=x'});target.dispatch('unhandledrejection',{reason:new RangeError('secret')});target.runTimer(5000);await new Promise(r=>queueMicrotask(r));
 const recent=sdk.monitoring.getSnapshot().recent;assert.deepEqual(new Set(recent.map(item=>item.signal)),new Set(['resource_error','unhandled_rejection']));assert.equal(recent.find(item=>item.signal==='resource_error').summary.resourceClass,'image');assert.equal(recent.find(item=>item.signal==='unhandled_rejection').summary.errorClass,'range_error');assert.doesNotMatch(JSON.stringify(recent),/private|token|secret/i);
});
test('beforeSend and subscriber failures are bounded, non-recursive and metadata-only',async()=>{
 const diagnostics=[];const target=monitoringTarget();const sdk=createSuperSDK({target,crypto:{},random:()=>0.32,diagnosticSink:item=>diagnostics.push(item)});sdk.monitoring.setConsent({errors:'granted'});sdk.monitoring.start({beforeSend(){throw new Error('https://private.invalid?token=x');}});
 target.dispatch('error',{error:new TypeError('secret')});target.runTimer(5000);await new Promise(r=>queueMicrotask(r));assert.equal(sdk.monitoring.getSnapshot().recent.length,0);assert.equal(sdk.monitoring.getSnapshot().drops.before_send,1);assert.equal(diagnostics.filter(item=>item.level==='error'&&item.category==='monitoring_hook').length,1);assert.doesNotMatch(JSON.stringify(diagnostics),/private|token|secret/i);
 const subscriberDiagnostics=[];const subscriberTarget=monitoringTarget();const subscriberSDK=createSuperSDK({target:subscriberTarget,crypto:{},random:()=>0.33,diagnosticSink:item=>subscriberDiagnostics.push(item)});subscriberSDK.monitoring.setConsent({errors:'granted'});subscriberSDK.monitoring.start();subscriberSDK.monitoring.onEnvelope(()=>{throw new Error('secret subscriber');});subscriberTarget.dispatch('error',{error:new TypeError('secret')});subscriberTarget.runTimer(5000);await new Promise(r=>queueMicrotask(r));assert.equal(subscriberSDK.monitoring.getSnapshot().recent.length,1);assert.equal(subscriberSDK.monitoring.getSnapshot().drops.subscriber_error,1);assert.equal(subscriberDiagnostics.filter(item=>item.level==='error'&&item.category==='monitoring_subscriber').length,1);assert.doesNotMatch(JSON.stringify(subscriberDiagnostics),/secret/i);
});
