// TC T-020; ci_reason: public root/protocol contract visibility.
import test from 'node:test'; import assert from 'node:assert/strict'; import sdk,{MONITORING_CONTRACT_SHA256,MONITORING_PROTOCOL} from '../src/index.js';
test('root entry exposes controller and generated contract',()=>{assert.equal(typeof sdk.monitoring.start,'function');assert.match(MONITORING_CONTRACT_SHA256,/^[0-9a-f]{64}$/);assert.equal(MONITORING_PROTOCOL.wireSchema,'supersdk.monitoring.v1');});
