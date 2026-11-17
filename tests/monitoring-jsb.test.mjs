// TC T-007; ci_reason: safe JSB metadata-only aggregation.
import test from 'node:test'; import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/runtime/createSuperSDK.js'; import { monitoringTarget } from './helpers.mjs';
test('safe terminal bridge diagnostics aggregate without raw values',async()=>{
 const target=monitoringTarget();const sdk=createSuperSDK({target,crypto:{},random:()=>0.5});sdk.monitoring.setConsent({performance:'granted'});sdk.monitoring.start();sdk.__diagnostics.emit('info',{category:'bridge_operation',api:'device.getEnv',outcome:'success',latencyBucket:'lt10ms',requestId:'r'});target.runTimer(5000);await Promise.resolve();const item=sdk.monitoring.getSnapshot().recent[0];assert.equal(item.signal,'jsb_operation');assert.equal(item.summary.api,'device.getEnv');assert.equal(JSON.stringify(item).includes('args'),false);
});
test('success, cancellation and failure use the frozen category and error mapping once',async()=>{
 const target=monitoringTarget();const sdk=createSuperSDK({target,crypto:{},random:()=>0.51});sdk.monitoring.setConsent({errors:'granted',performance:'granted'});sdk.monitoring.start();
 sdk.__diagnostics.emit('info',{category:'bridge_operation',api:'device.getEnv',outcome:'cancelled',requestId:'cancel',latencyBucket:'lt100ms'});sdk.__diagnostics.emit('error',{category:'bridge_operation',api:'device.getEnv',outcome:'timeout',requestId:'timeout',latencyBucket:'gte10s',errorClass:'timeout',args:{secret:true},result:'secret'});target.runTimer(5000);await new Promise(r=>queueMicrotask(r));
 const recent=sdk.monitoring.getSnapshot().recent;assert.equal(recent.length,2);assert.equal(recent.find(item=>item.context.requestId==='cancel').category,'performance');const failed=recent.find(item=>item.context.requestId==='timeout');assert.equal(failed.category,'errors');assert.equal(failed.summary.errorClass,'timeout');assert.doesNotMatch(JSON.stringify(recent),/args|result|secret/);
});
