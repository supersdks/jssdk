import { sdkError, isSuperSDKError } from '../core/errors.js';
import { joinApiUrl } from '../core/utils.js';
import { readJsonWithSuEnc, SUENC_ERROR_CODES } from '../suenc/codec.js';
import { buildFeedbackWireBody, parseFeedbackReceipt, validateFeedbackParams } from '../feedback/params.js';

/**
 * Web (no native bridge) transport for `SuperSDK.submitFeedback` (CA-F260916-user-feedback):
 * `POST {baseUrl}/v2/feedback` with `X-Aid` / `X-Super-API-ENV`, base URLs rotated on
 * retryable failures only, response read through the suenc-aware decoder (never plaintext
 * on a downgrade). Business rejections from the server surface as `INVALID_ARGUMENT` with
 * the server code attached; they never trigger a failover.
 */
export function createFeedbackClient({ getConfig, fetchImpl, consent, diagnostics, sdkVersion }) {
  async function submitFeedback(params) {
    const config = getConfig();
    if (!config) throw sdkError('NOT_INITIALIZED');
    const checked = validateFeedbackParams(params);
    if (checked.detail) throw sdkError('INVALID_ARGUMENT', { message: checked.detail });
    const body = buildFeedbackWireBody(checked.value, {
      spid: config.spid,
      env: config.environment,
      deviceId: consent?.getDeviceId?.() || '',
      platform: 'web',
      sdkVersion
    });

    let lastError = sdkError('NETWORK_ERROR');
    for (let index = 0; index < config.baseUrls.length; index += 1) {
      try {
        return await postOne(config, config.baseUrls[index], body);
      } catch (error) {
        lastError = isSuperSDKError(error) ? error : sdkError('NETWORK_ERROR', { cause: error });
        // A 429 is per-spid/per-ip state on the same CA — another base URL answers the same.
        if (!lastError.retryable || lastError.code === 'RATE_LIMITED') throw lastError;
        if (index + 1 < config.baseUrls.length) {
          diagnostics?.emit('warn', { category: 'feedback_failover', code: lastError.code, baseUrlIndex: index });
        }
      }
    }
    throw lastError;
  }

  async function postOne(config, baseUrl, body) {
    if (typeof fetchImpl !== 'function') throw sdkError('NETWORK_ERROR');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), config.settings.timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(joinApiUrl(baseUrl, '/v2/feedback'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Aid': config.spid,
          'X-Super-API-ENV': config.environment
        },
        body: JSON.stringify(body),
        signal: controller?.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw sdkError('TIMEOUT', { cause: error });
      throw sdkError('NETWORK_ERROR', { cause: error });
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (response.status === 429) throw sdkError('RATE_LIMITED');
    if (response.status >= 500) throw sdkError('UNAVAILABLE');
    let envelope;
    try { envelope = await readJsonWithSuEnc(response); } catch (error) {
      // suenc 解码失败必须原样上抛：不得回落到明文，也不得被泛化成协议错误
      if (isSuperSDKError(error) && SUENC_ERROR_CODES.has(error.code)) throw error;
      throw sdkError(response.ok ? 'PROTOCOL_MISMATCH' : 'UNAVAILABLE', { cause: error });
    }
    const receipt = parseFeedbackReceipt(envelope);
    if (response.ok && receipt) return receipt;
    const code = envelope?.code;
    if (typeof code === 'string' && code && code !== 'SUCCESS') {
      // 200-envelope business rejection (INVALID_REQUEST / NOT_FOUND / SPID_REQUIRED …): the
      // request itself is wrong, another base URL would answer the same → not retryable.
      throw sdkError('INVALID_ARGUMENT', {
        message: typeof envelope.message === 'string' && envelope.message ? envelope.message : code,
        nativeCode: code
      });
    }
    if (response.status === 400 || response.status === 413) throw sdkError('INVALID_ARGUMENT');
    throw sdkError(response.ok ? 'PROTOCOL_MISMATCH' : 'UNAVAILABLE');
  }

  return Object.freeze({ submitFeedback });
}
