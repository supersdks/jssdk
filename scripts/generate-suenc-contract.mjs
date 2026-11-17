import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const STANDARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const argument = (name, fallback) => { const index = args.indexOf(name); return resolve(index >= 0 ? args[index + 1] : fallback); };
const protocolPath = argument('--schema', resolve(root, 'protocol/suenc-v1.json'));
const goldenPath = argument('--golden', resolve(root, 'protocol/suenc-v1-golden.json'));
const jsPath = argument('--js-output', resolve(root, 'src/suenc/generated-contract.js'));
const tsPath = argument('--ts-output', resolve(root, 'types/suenc-contract.d.ts'));
const defaultJavaPath = resolve(root, '../android-sdk-base/src/main/java/com/supersdk/base/net/suenc/SuEncContract.java');
const defaultSwiftPath = resolve(root, '../ios-sdk/SuperSDK/Sources/Base/SuEnc/SuEncContract.swift');

const protocol = JSON.parse(await readFile(protocolPath, 'utf8'));
const golden = JSON.parse(await readFile(goldenPath, 'utf8'));
validateSource(protocol, golden);
const digest = createHash('sha256').update(`${canonical(protocol)}\n${canonical(golden)}\n`).digest('hex');
let outputs = new Map([
  [jsPath, renderJavaScript(protocol, golden, digest)],
  [tsPath, renderTypeScript(protocol, digest)],
  [defaultJavaPath, renderJava(protocol, golden, digest)],
  [defaultSwiftPath, renderSwift(protocol, golden, digest)]
]);

const javaIndex = args.indexOf('--java-output');
const swiftIndex = args.indexOf('--swift-output');
if (javaIndex >= 0) { outputs.delete(defaultJavaPath); outputs.set(resolve(args[javaIndex + 1]), renderJava(protocol, golden, digest)); }
if (swiftIndex >= 0) { outputs.delete(defaultSwiftPath); outputs.set(resolve(args[swiftIndex + 1]), renderSwift(protocol, golden, digest)); }
if (args.includes('--js-only')) outputs = new Map([...outputs].filter(([path]) => path === jsPath || path === tsPath));

if (args.includes('--check')) {
  const drift = [];
  for (const [path, expected] of outputs) {
    let actual = '';
    try { actual = await readFile(path, 'utf8'); } catch { /* reported as drift */ }
    if (actual !== expected) drift.push(path);
  }
  if (drift.length) {
    console.error(`suenc generated contract drift: ${drift.join(', ')}`);
    process.exit(1);
  }
} else {
  for (const [path, content] of outputs) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

function validateSource(source, vectors) {
  if (source?.version !== 1) throw new Error('invalid suenc contract version');
  for (const key of ['defaultCodec', 'header', 'queryParam', 'contentType']) {
    if (typeof source[key] !== 'string' || !source[key]) throw new Error(`invalid ${key}`);
  }
  if (!source.codecs || typeof source.codecs !== 'object') throw new Error('invalid codecs');
  const keys = Object.keys(source.codecs);
  if (!keys.length) throw new Error('no codecs declared');
  if (!keys.includes(source.defaultCodec)) throw new Error('defaultCodec is not declared in codecs');
  const headerPattern = new RegExp(source.rules?.headerValuePattern ?? '^[a-z0-9_-]{1,32}$');
  for (const key of keys) {
    if (!headerPattern.test(key)) throw new Error(`codec key violates headerValuePattern: ${key}`);
    const codec = source.codecs[key];
    if (codec?.type !== 'custom_base64') throw new Error(`unsupported codec type for ${key}`);
    if (codec.padding !== '=' || codec.charset !== 'utf-8') throw new Error(`unsupported padding/charset for ${key}`);
    // fail-closed：alphabet 必须是标准 Base64 64 字符的合法全排列，且不得是恒等排列
    const alphabet = codec.alphabet;
    if (typeof alphabet !== 'string' || alphabet.length !== 64) throw new Error(`alphabet must be 64 chars: ${key}`);
    if (new Set(alphabet).size !== 64) throw new Error(`alphabet has duplicate chars: ${key}`);
    if ([...alphabet].sort().join('') !== [...STANDARD_BASE64].sort().join('')) throw new Error(`alphabet is not a permutation of standard base64: ${key}`);
    if (alphabet === STANDARD_BASE64) throw new Error(`alphabet must not be the identity permutation: ${key}`);
  }
  for (const key of ['stripAsciiWhitespaceBeforeDecode', 'requireLengthMultipleOfFour', 'paddingOnlyAtEnd', 'requireValidUtf8']) {
    if (source.rules?.[key] !== true) throw new Error(`rules.${key} must be true`);
  }
  if (!Number.isInteger(source.rules?.maxPaddingChars) || source.rules.maxPaddingChars !== 2) throw new Error('rules.maxPaddingChars must be 2');
  if (!Number.isInteger(source.rules?.maxEncodableBodyBytes) || source.rules.maxEncodableBodyBytes <= 0) throw new Error('invalid maxEncodableBodyBytes');

  if (vectors?.version !== 1 || vectors.codec !== source.defaultCodec) throw new Error('golden vectors do not match the default codec');
  if (!Array.isArray(vectors.encode) || !vectors.encode.length) throw new Error('golden encode vectors are empty');
  for (const vector of vectors.encode) {
    if (!vector?.name || typeof vector.plaintext !== 'string' || typeof vector.encoded !== 'string' || typeof vector.plaintextHex !== 'string') {
      throw new Error(`invalid golden encode vector: ${vector?.name || 'unnamed'}`);
    }
    if (Buffer.from(vector.plaintext, 'utf8').toString('hex') !== vector.plaintextHex) throw new Error(`plaintextHex mismatch: ${vector.name}`);
    if (encodeWithAlphabet(Buffer.from(vector.plaintext, 'utf8'), source.codecs[vectors.codec].alphabet) !== vector.encoded) {
      throw new Error(`golden encode vector does not match the pinned alphabet: ${vector.name}`);
    }
  }
  // 必测场景（需求 §19.2 1-5）：空串 / 三种字节余数必须被覆盖
  const lengths = new Set(vectors.encode.map((vector) => Buffer.from(vector.plaintext, 'utf8').length % 3));
  if (!vectors.encode.some((vector) => vector.plaintext === '')) throw new Error('golden vectors must cover the empty string');
  for (const remainder of [0, 1, 2]) if (!lengths.has(remainder)) throw new Error(`golden vectors must cover byte remainder ${remainder}`);
  if (!Array.isArray(vectors.decodeErrors) || vectors.decodeErrors.length < 4) throw new Error('golden decode error vectors are insufficient');
  const errorKinds = new Set(vectors.decodeErrors.map((vector) => vector.error));
  for (const kind of ['SUENC_DECODE_FAILED', 'SUENC_INVALID_UTF8']) if (!errorKinds.has(kind)) throw new Error(`golden decode errors must cover ${kind}`);
  if (vectors.unknownCodec?.error !== 'UNSUPPORTED_SUENC_CODEC') throw new Error('golden vectors must cover the unknown codec case');
  if (Object.keys(source.codecs).includes(vectors.unknownCodec.codec)) throw new Error('unknownCodec vector must not reference a declared codec');
}

function encodeWithAlphabet(bytes, alphabet) {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index];
    const b1 = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const b2 = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const remaining = bytes.length - index;
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += remaining > 1 ? alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += remaining > 2 ? alphabet[b2 & 0x3f] : '=';
  }
  return out;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && Object.prototype.toString.call(value) === '[object Object]') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function renderJavaScript(source, vectors, sha) {
  return `// Generated by scripts/generate-suenc-contract.mjs. Do not edit.\n` +
    `export const SUENC_CONTRACT_SHA256 = ${JSON.stringify(sha)};\n` +
    `export const SUENC_PROTOCOL = deepFreeze(${JSON.stringify(source)});\n` +
    `export const SUENC_GOLDEN_VECTORS = deepFreeze(${JSON.stringify(vectors)});\n` +
    `export const SUENC_HEADER = ${JSON.stringify(source.header)};\n` +
    `export const SUENC_QUERY_PARAM = ${JSON.stringify(source.queryParam)};\n` +
    `export const SUENC_CONTENT_TYPE = ${JSON.stringify(source.contentType)};\n` +
    `export const SUENC_DEFAULT_CODEC = ${JSON.stringify(source.defaultCodec)};\n` +
    `function deepFreeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }\n`;
}

function renderTypeScript(source, sha) {
  return `// Generated by scripts/generate-suenc-contract.mjs. Do not edit.\n` +
`export type SuEncCodecKey = ${Object.keys(source.codecs).map((key) => JSON.stringify(key)).join(' | ')};
export interface SuEncCodecDefinition { readonly type: 'custom_base64'; readonly alphabet: string; readonly padding: '='; readonly charset: 'utf-8' }
export interface SuEncCapabilities { readonly supported: boolean; readonly codecs: readonly SuEncCodecKey[] }
export const SUENC_CONTRACT_SHA256: ${JSON.stringify(sha)};
export const SUENC_PROTOCOL: Readonly<Record<string, unknown>>;
export const SUENC_GOLDEN_VECTORS: Readonly<Record<string, unknown>>;
export const SUENC_HEADER: ${JSON.stringify(source.header)};
export const SUENC_QUERY_PARAM: ${JSON.stringify(source.queryParam)};
export const SUENC_CONTENT_TYPE: ${JSON.stringify(source.contentType)};
export const SUENC_DEFAULT_CODEC: ${JSON.stringify(source.defaultCodec)};
`;
}

function renderJava(source, golden, sha) {
  const codecKeys = Object.keys(source.codecs);
  return `// Generated by scripts/generate-suenc-contract.mjs. Do not edit.
package com.supersdk.base.net.suenc;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/** suenc 协议契约常量（由 packages/jssdk/protocol/suenc-v1.json 生成）。 */
public final class SuEncContract {
    public static final String CONTRACT_SHA256 = ${JSON.stringify(sha)};
    public static final String HEADER = ${JSON.stringify(source.header)};
    public static final String QUERY_PARAM = ${JSON.stringify(source.queryParam)};
    public static final String CONTENT_TYPE = ${JSON.stringify(source.contentType)};
    public static final String DEFAULT_CODEC = ${JSON.stringify(source.defaultCodec)};
    public static final String HEADER_VALUE_PATTERN = ${JSON.stringify(source.rules.headerValuePattern)};
    public static final char PADDING = '=';
    public static final boolean STRIP_ASCII_WHITESPACE = ${source.rules.stripAsciiWhitespaceBeforeDecode};
    public static final int MAX_PADDING_CHARS = ${source.rules.maxPaddingChars};
    public static final int MAX_ENCODABLE_BODY_BYTES = ${source.rules.maxEncodableBodyBytes};
    /** 稳定向量原文，供跨语言一致性测试驱动。 */
    public static final String GOLDEN_JSON = ${JSON.stringify(JSON.stringify(golden))};

    private static final Map<String, String> ALPHABETS = alphabets();

    private SuEncContract() {}

    private static Map<String, String> alphabets() {
        Map<String, String> map = new LinkedHashMap<>();
${codecKeys.map((key) => `        map.put(${JSON.stringify(key)}, ${JSON.stringify(source.codecs[key].alphabet)});`).join('\n')}
        return Collections.unmodifiableMap(map);
    }

    /** 返回 codec 的自定义 alphabet；未知 codec 返回 null。 */
    public static String getAlphabet(String codecKey) {
        return codecKey == null ? null : ALPHABETS.get(codecKey);
    }

    public static Set<String> getSupportedCodecs() {
        return Collections.unmodifiableSet(new LinkedHashSet<>(ALPHABETS.keySet()));
    }
}
`;
}

function renderSwift(source, golden, sha) {
  const codecKeys = Object.keys(source.codecs);
  return `// Generated by scripts/generate-suenc-contract.mjs. Do not edit.
import Foundation

/// suenc 协议契约常量（由 packages/jssdk/protocol/suenc-v1.json 生成）。
public enum SuEncContract {
    public static let contractSHA256 = ${JSON.stringify(sha)}
    public static let header = ${JSON.stringify(source.header)}
    public static let queryParam = ${JSON.stringify(source.queryParam)}
    public static let contentType = ${JSON.stringify(source.contentType)}
    public static let defaultCodec = ${JSON.stringify(source.defaultCodec)}
    public static let headerValuePattern = ${JSON.stringify(source.rules.headerValuePattern)}
    public static let padding: Character = "="
    public static let stripAsciiWhitespace = ${source.rules.stripAsciiWhitespaceBeforeDecode}
    public static let maxPaddingChars = ${source.rules.maxPaddingChars}
    public static let maxEncodableBodyBytes = ${source.rules.maxEncodableBodyBytes}
    /// 稳定向量原文，供跨语言一致性测试驱动。
    public static let goldenJSON = ${JSON.stringify(JSON.stringify(golden))}

    private static let alphabets: [String: String] = [
${codecKeys.map((key) => `        ${JSON.stringify(key)}: ${JSON.stringify(source.codecs[key].alphabet)}`).join(',\n')}
    ]

    /// 返回 codec 的自定义 alphabet；未知 codec 返回 nil。
    public static func alphabet(for codecKey: String) -> String? {
        return alphabets[codecKey]
    }

    public static var supportedCodecs: [String] {
        return ${JSON.stringify(codecKeys)}
    }
}
`;
}
