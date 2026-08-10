import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/index.js';
import { createTarget, response } from './helpers.mjs';

test('settings_never_executes_remote_script_or_exposes_sensitive_request_data_in_errors', async function settings_never_executes_remote_script_or_exposes_sensitive_request_data_in_errors() {
  globalThis.__remoteScriptExecuted = false;
  const sdk = createSuperSDK({ target: createTarget(async () => response(200, {
    code: 'SUCCESS', data: { text: '<script>globalThis.__remoteScriptExecuted=true</script>' }
  })) });
  sdk.init({ spid: 'ab12cd34' });
  const value = await sdk.getHostSettings('safe', { token: 'secret-value' });
  assert.match(value.text, /script/);
  assert.equal(globalThis.__remoteScriptExecuted, false);

  const bad = createSuperSDK({ target: createTarget(async () => { throw new Error('token=secret-value query=x'); }) });
  bad.init({ spid: 'ab12cd34' });
  await assert.rejects(bad.getHostSettings('safe', { token: 'secret-value' }), (error) => {
    assert.equal(JSON.stringify(error).includes('secret-value'), false);
    assert.equal(JSON.stringify(error.cause).includes('secret-value'), false);
    return true;
  });
});
