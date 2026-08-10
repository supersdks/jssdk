export function isPlainObject(value) {
  if (Object.prototype.toString.call(value) !== '[object Object]') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

export function utf8Bytes(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).byteLength;
  return unescape(encodeURIComponent(text)).length;
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = sortValue(value[key]);
    return result;
  }
  return value;
}

export async function stableHash(value, cryptoLike = globalThis.crypto) {
  const text = stableStringify(value);
  if (cryptoLike?.subtle && typeof TextEncoder !== 'undefined') {
    const digest = await cryptoLike.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
  }
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
}

export function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createUUID(cryptoLike = globalThis.crypto, random = Math.random) {
  if (typeof cryptoLike?.randomUUID === 'function') return cryptoLike.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const raw = Math.floor(random() * 16);
    const value = character === 'x' ? raw : ((raw & 0x3) | 0x8);
    return value.toString(16);
  });
}

export function joinApiUrl(baseUrl, path) {
  let base = String(baseUrl || '').replace(/\/+$/, '');
  let suffix = path.startsWith('/') ? path : `/${path}`;
  if (base.endsWith('/superapi') && suffix.startsWith('/superapi/')) suffix = suffix.slice('/superapi'.length);
  return `${base}${suffix}`;
}
