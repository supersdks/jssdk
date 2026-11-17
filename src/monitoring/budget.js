import { LIMITS } from '../core/limits.js';
import { utf8Bytes } from '../core/utils.js';

const FIELDS = ['pageEnvelopes','sessionEnvelopes','bytesPerMinute','envelopeBytes','aggregationKeys','errorFingerprintsPerPage'];

export function normalizeMonitoringBudgets(input = {}) {
  if (!plain(input)) invalid();
  for (const key of Object.keys(input)) if (!FIELDS.includes(key)) invalid();
  const source = LIMITS.monitoring;
  const output = {};
  for (const key of FIELDS) {
    const value = input[key] ?? source[key];
    if (!Number.isInteger(value) || value < 1 || value > source[`${key}Hard`]) invalid();
    output[key] = value;
  }
  if (output.sessionEnvelopes < output.pageEnvelopes || output.envelopeBytes > output.bytesPerMinute || output.errorFingerprintsPerPage > output.aggregationKeys) invalid();
  return Object.freeze(output);
}

export function createMonitoringBudget(budgets, now = Date.now) {
  let page = 0;
  let session = 0;
  const minute = [];
  function admit(envelope, wrapperBody) {
    const at = now();
    while (minute.length && minute[0].at <= at - 60_000) minute.shift();
    const bytes = Math.max(utf8Bytes(JSON.stringify(envelope)), wrapperBody ? utf8Bytes(wrapperBody) : 0);
    const used = minute.reduce((sum, item) => sum + item.bytes, 0);
    if (bytes > budgets.envelopeBytes) return 'envelope_bytes';
    if (page >= budgets.pageEnvelopes) return 'page_envelopes';
    if (session >= budgets.sessionEnvelopes) return 'session_envelopes';
    if (used + bytes > budgets.bytesPerMinute) return 'bytes_per_minute';
    page += 1; session += 1; minute.push({ at, bytes });
    return null;
  }
  return Object.freeze({ admit, resetPage: () => { page = 0; }, clear: () => { page = 0; session = 0; minute.length = 0; } });
}

function plain(value) { return Object.prototype.toString.call(value) === '[object Object]' && [null, Object.prototype].includes(Object.getPrototypeOf(value)); }
function invalid() { const error = new TypeError('invalid monitoring budgets'); error.code = 'INVALID_ARGUMENT'; throw error; }
