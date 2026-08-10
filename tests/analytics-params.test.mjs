import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuperSDK } from '../src/index.js';
import { createTarget, response } from './helpers.mjs';

test('common_params_merge_without_overriding_sdk_identity_and_mark_web_source_untrusted', async function common_params_merge_without_overriding_sdk_identity_and_mark_web_source_untrusted() {
  let payload;
  const sdk = createSuperSDK({ target: createTarget(async (_url, options) => {
    payload = JSON.parse(options.body);
    return response(200, { code: 'SUCCESS' });
  }) });
  sdk.init({ spid: 'ab12cd34', environment: 'staging', analyticsConsent: 'granted' });
  sdk.addEventCommonParam('channel', 'organic');
  sdk.addEventCommonParams({ locale: 'en', host_spid: 'attacker', evt_unique_id: 'attacker' });
  const queued = await sdk.reportEvent('open', { channel: 'paid', env: 'attacker', evt_unique_id: 'attacker' });
  await sdk.flush();
  assert.equal(payload.basic_data.host_spid, 'ab12cd34');
  assert.equal(payload.basic_data.env, 'staging');
  assert.equal(payload.basic_data.platform_id, 'web_sdk');
  assert.equal(payload.basic_data.source, 'web_sdk_untrusted');
  assert.equal(payload.events[0].event_param.channel, 'paid');
  assert.equal(payload.events[0].event_param.locale, 'en');
  assert.equal(payload.events[0].event_param.env, undefined);
  assert.equal(payload.events[0].event_param.evt_unique_id, queued.eventId);
});
