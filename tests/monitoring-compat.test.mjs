// TC T-021; ci_reason: legacy/default-off compatibility.
import test from 'node:test'; import assert from 'node:assert/strict'; import { createSuperSDK } from '../src/runtime/createSuperSDK.js'; import { monitoringTarget } from './helpers.mjs';
test('legacy runtime remains available while monitoring is dormant',()=>{const sdk=createSuperSDK({target:monitoringTarget()});assert.equal(typeof sdk.reportEvent,'function');assert.equal(sdk.monitoring.start().status,'dormant');assert.equal(sdk.monitoring.getState().remoteStatus,'disabled');});
