import { sdkError } from '../core/errors.js';
import { SUENC_PROTOCOL, SUENC_HEADER, SUENC_DEFAULT_CODEC } from './generated-contract.js';

// suenc 响应混淆解码。codec 表与规则全部来自生成的契约，业务方不得传入自定义 table。
// 只降低通用关键字扫描的有效性，不提供机密性/防篡改/防重放。

const PADDING = 0x3d; // '='
const RULES = SUENC_PROTOCOL.rules;

/** suenc 自身的错误码：这些必须原样上抛，不得被泛化或回落到明文。 */
export const SUENC_ERROR_CODES = Object.freeze(new Set([
  'UNSUPPORTED_SUENC_CODEC', 'SUENC_DECODE_FAILED', 'SUENC_INVALID_UTF8',
  'SUENC_DOWNGRADE', 'SUENC_RESPONSE_TOO_LARGE', 'SUENC_PROTOCOL_ERROR'
]));

// 反查表按 codec 缓存：256 项 Int16Array，-1 表示该字节不在 alphabet 内。
const decodeTables = new Map();

function decodeTable(codecKey) {
  let table = decodeTables.get(codecKey);
  if (table) return table;
  const alphabet = SUENC_PROTOCOL.codecs[codecKey].alphabet;
  table = new Int16Array(256).fill(-1);
  for (let index = 0; index < alphabet.length; index += 1) table[alphabet.charCodeAt(index)] = index;
  decodeTables.set(codecKey, table);
  return table;
}

function isAsciiWhitespace(code) {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** 当前运行时支持的 suenc 能力。业务方据此决定是否发送 `suenc=1`。 */
export function getSuEncCapabilities() {
  return Object.freeze({ supported: true, codecs: Object.freeze(Object.keys(SUENC_PROTOCOL.codecs)) });
}

/**
 * 解码服务端返回的 suenc 响应体。
 * @param {string} encodedData 完整编码响应体
 * @param {string} codec `X-Su-Enc` header 的原始值
 * @returns {string} 原始 UTF-8 JSON 文本
 */
export function decodeSuEnc(encodedData, codec) {
  if (typeof codec !== 'string' || !codec) throw sdkError('UNSUPPORTED_SUENC_CODEC');
  if (!Object.prototype.hasOwnProperty.call(SUENC_PROTOCOL.codecs, codec)) throw sdkError('UNSUPPORTED_SUENC_CODEC');
  if (typeof encodedData !== 'string') throw sdkError('SUENC_DECODE_FAILED');

  const table = decodeTable(codec);
  const source = encodedData;
  // 先按契约剔除 ASCII 空白，再做严格校验；两步都在一个 Uint8Array 上完成，避免逐字符建临时字符串。
  const symbols = new Uint8Array(source.length);
  let length = 0;
  let padding = 0;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (RULES.stripAsciiWhitespaceBeforeDecode && isAsciiWhitespace(code)) continue;
    if (code === PADDING) {
      padding += 1;
      if (padding > RULES.maxPaddingChars) throw sdkError('SUENC_DECODE_FAILED');
    } else {
      // padding 只允许出现在末尾：已经见过 padding 后再出现数据字符即非法
      if (padding > 0) throw sdkError('SUENC_DECODE_FAILED');
      if (code > 0xff || table[code] < 0) throw sdkError('SUENC_DECODE_FAILED');
    }
    symbols[length] = code;
    length += 1;
  }
  if (RULES.requireLengthMultipleOfFour && length % 4 !== 0) throw sdkError('SUENC_DECODE_FAILED');
  if (length === 0) return '';

  const bytes = new Uint8Array((length / 4) * 3 - padding);
  let out = 0;
  for (let index = 0; index < length; index += 4) {
    const s0 = table[symbols[index]];
    const s1 = table[symbols[index + 1]];
    const c2 = symbols[index + 2];
    const c3 = symbols[index + 3];
    // 前两个符号任何情况下都必须是数据字符
    if (s0 < 0 || s1 < 0) throw sdkError('SUENC_DECODE_FAILED');
    const s2 = c2 === PADDING ? 0 : table[c2];
    const s3 = c3 === PADDING ? 0 : table[c3];
    bytes[out] = (s0 << 2) | (s1 >> 4);
    out += 1;
    if (c2 !== PADDING) { bytes[out] = ((s1 & 0x0f) << 4) | (s2 >> 2); out += 1; }
    if (c3 !== PADDING) { bytes[out] = ((s2 & 0x03) << 6) | s3; out += 1; }
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw sdkError('SUENC_INVALID_UTF8', { cause: error });
  }
}

/** 供内部网络层使用：把 fetch Response 的 suenc header 取出（大小写不敏感）。 */
export function readSuEncCodec(response) {
  const headers = response?.headers;
  if (!headers || typeof headers.get !== 'function') return null;
  const value = headers.get(SUENC_HEADER);
  return typeof value === 'string' && value ? value : null;
}

/**
 * 供内部网络层使用：按 `X-Su-Enc` 透明解码并解析 JSON。
 * 无 header 时保持原有 `response.json()` 行为；有 header 时必须解码，绝不降级读明文。
 */
export async function readJsonWithSuEnc(response) {
  const codec = readSuEncCodec(response);
  if (!codec) return response.json();
  if (typeof response.text !== 'function') throw sdkError('SUENC_PROTOCOL_ERROR');
  const encoded = await response.text();
  return JSON.parse(decodeSuEnc(encoded, codec));
}

export { SUENC_HEADER, SUENC_DEFAULT_CODEC };
