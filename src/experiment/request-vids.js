import { EXPERIMENT_CONTRACT as C } from './contract.js';

/**
 * WS-12-S6 request-vids helpers (docs/architecture/experiment-s6-impl-spec.md §3): the exposed
 * vid string travels to backends as the `X-Super-AB-Vids` header or the `super_ab_vids` query
 * parameter. Pure functions; the side effect (treating server experiments as read) is the
 * caller's.
 */

export const REQUEST_VIDS_HEADER = C.header;
export const REQUEST_VIDS_QUERY = C.queryParam;

/** `{ 'X-Super-AB-Vids': vids }`, or `{}` for an empty set. */
export function vidsHeaders(vids) {
  return vids ? { [REQUEST_VIDS_HEADER]: vids } : {};
}

/**
 * Adds / overwrites `super_ab_vids=<vids>` keeping every other query parameter, the hash and
 * the URL's form (absolute, relative, protocol-relative). Empty vids → the URL unchanged.
 * Commas are left unencoded (RFC 3986 sub-delims), so the value equals the header value.
 */
export function appendVidsParam(url, vids) {
  if (!vids) return url;
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = beforeHash.indexOf('?');
  const path = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  const query = queryAt >= 0 ? beforeHash.slice(queryAt + 1) : '';
  const kept = query ? query.split('&').filter((part) => part && paramName(part) !== REQUEST_VIDS_QUERY) : [];
  kept.push(`${REQUEST_VIDS_QUERY}=${vids}`);
  return `${path}?${kept.join('&')}${hash}`;
}

function paramName(part) {
  const eq = part.indexOf('=');
  const raw = (eq >= 0 ? part.slice(0, eq) : part).replace(/\+/g, ' ');
  try { return decodeURIComponent(raw); } catch (_) { return raw; }
}

/**
 * Returns a header collection equal to `headers` (Headers / [name, value][] / plain object /
 * undefined) plus the vids header, which wins over a caller-set header of the same name in any
 * letter case. Returns a `Headers` instance when the runtime has one, else a plain object.
 */
export function withVidsHeader(headers, vids, HeadersImpl = globalThis.Headers) {
  if (!vids) return headers;
  if (typeof HeadersImpl === 'function') {
    const merged = new HeadersImpl(headers === undefined || headers === null ? undefined : headers);
    merged.set(REQUEST_VIDS_HEADER, vids);
    return merged;
  }
  const out = {};
  const lower = REQUEST_VIDS_HEADER.toLowerCase();
  const entries = Array.isArray(headers)
    ? headers
    : headers && typeof headers.forEach === 'function' && typeof headers.get === 'function'
      ? collect(headers)
      : Object.entries(headers || {});
  for (const [name, value] of entries) {
    if (String(name).toLowerCase() !== lower) out[name] = value;
  }
  out[REQUEST_VIDS_HEADER] = vids;
  return out;
}

function collect(headers) {
  const list = [];
  headers.forEach((value, name) => list.push([name, value]));
  return list;
}

/** Platform requests: plain-object headers in, plain-object headers out (no side effect). */
export function withPlatformVids(init, vids) {
  if (!vids) return init;
  const headers = withVidsHeader(init && init.headers, vids, null);
  return { ...(init || {}), headers };
}
