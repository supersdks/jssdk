import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';

const packageRoot = resolve(import.meta.dirname, '..');
const requests = { settings: [], analytics: [], aborted: 0 };
let pageServer;
let apiServer;
let browser;
let pageOrigin;
let apiOrigin;

test.before(async () => {
  pageServer = http.createServer(async (request, response) => {
    if (request.url === '/' || request.url === '/index.html') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><meta charset="utf-8"><title>SuperSDK browser contract</title>');
      return;
    }
    if (request.url === '/dist/index.js' || request.url === '/dist/supersdk.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end(await readFile(resolve(packageRoot, request.url.slice(1))));
      return;
    }
    response.writeHead(404).end();
  });
  await listen(pageServer);
  pageOrigin = origin(pageServer);

  apiServer = http.createServer(async (request, response) => {
    const cors = {
      'Access-Control-Allow-Origin': pageOrigin,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Accept,Content-Type,X-Aid,X-Super-API-ENV',
      'Content-Type': 'application/json'
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors).end();
      return;
    }
    const url = new URL(request.url, apiOrigin);
    if (url.pathname === '/superapi/v2/settings') {
      requests.settings.push(Object.fromEntries(url.searchParams));
      response.writeHead(200, cors);
      response.end(JSON.stringify({ code: 'SUCCESS', data: { feature: true, script: '<script>globalThis.__executed=true</script>' } }));
      return;
    }
    if (url.pathname === '/superapi/v2/reportEvent') {
      const body = JSON.parse(await bodyText(request));
      requests.analytics.push(body);
      if (body.events.some((event) => event.event_name === 'hang')) {
        response.on('close', () => { requests.aborted += 1; });
        return;
      }
      response.writeHead(200, cors);
      response.end(JSON.stringify({ code: 'SUCCESS' }));
      return;
    }
    response.writeHead(404, cors).end(JSON.stringify({ code: 'NOT_FOUND' }));
  });
  await listen(apiServer);
  apiOrigin = origin(apiServer);
  const executablePath = [
    process.env.CHROMIUM_PATH,
    chromium.executablePath(),
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
  ].find((candidate) => candidate && existsSync(candidate));
  if (!executablePath) throw new Error('Chromium is required; run `npx playwright-core install chromium` or set CHROMIUM_PATH');
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
  await browser?.close();
  await close(apiServer);
  await close(pageServer);
});

test('real_browser_cors_settings_consent_analytics_and_revocation_contract', async () => {
  requests.settings.length = 0;
  requests.analytics.length = 0;
  requests.aborted = 0;
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${pageOrigin}/index.html`);
  const result = await page.evaluate(async ({ apiOrigin }) => {
    localStorage.setItem('supersdk_device_id', 'legacy-persistent-id');
    localStorage.setItem('supersdk_outbox', '[{"legacy":true}]');
    const module = await import('/dist/index.js');
    if (Object.hasOwn(globalThis, 'SuperSDK') || Object.hasOwn(globalThis, 'JSBridge')) throw new Error('module root wrote globals');
    const diagnostics = [];
    const sdk = module.createSuperSDK();
    sdk.onDiagnostic((entry) => diagnostics.push(entry));
    sdk.init({
      spid: 'ab12cd34', environment: 'staging', baseUrls: [`${apiOrigin}/superapi`],
      analyticsConsent: 'denied', analytics: { flushIntervalMs: 60000 }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const denied = {
      env: await sdk.getEnv(),
      storedId: localStorage.getItem('supersdk_device_id'),
      oldOutbox: localStorage.getItem('supersdk_outbox')
    };
    const settings1 = await sdk.getHostSettings('feature', { b: 2, a: 1, spid: 'forged', __token: 'secret' });
    const settings2 = await sdk.getHostSettings('feature', { a: 1, b: 2, spid: 'different', __token: 'different' });
    await sdk.setAnalyticsConsent('granted');
    const grantedEnv = await sdk.getEnv();
    const queued = await sdk.reportEvent('browser_success', { page: 'home' });
    const flushed = await sdk.flush();
    await sdk.reportEvent('hang', { privateValue: 'must-not-enter-diagnostics' });
    globalThis.__sdk = sdk;
    globalThis.__hangingFlush = sdk.flush();
    return { denied, settings1, settings2, grantedEnv, queued, flushed, diagnostics };
  }, { apiOrigin });

  assert.equal(result.denied.env.deviceId, '');
  assert.equal(result.denied.storedId, null);
  assert.equal(result.denied.oldOutbox, null);
  assert.deepEqual(result.settings1, result.settings2);
  assert.equal(result.settings1.feature, true);
  assert.equal(await page.evaluate(() => globalThis.__executed), undefined);
  assert.equal(requests.settings.length, 1, 'canonical cache key must coalesce equivalent safe params');
  assert.equal(requests.settings[0].spid, 'ab12cd34');
  assert.equal(requests.settings[0].env, 'staging');
  assert.equal(requests.settings[0].__token, undefined);
  assert.ok(result.grantedEnv.deviceId);
  assert.equal(result.queued.queued, true);
  assert.equal(result.flushed.sent, 1);
  assert.equal(requests.analytics[0].basic_data.device_id, result.grantedEnv.deviceId);
  assert.equal(requests.analytics[0].basic_data.source, 'web_sdk_untrusted');

  await waitFor(() => requests.analytics.some((body) => body.events.some((event) => event.event_name === 'hang')));
  const revoked = await page.evaluate(async () => {
    await globalThis.__sdk.setAnalyticsConsent('denied');
    const flush = await globalThis.__hangingFlush;
    return {
      flush,
      state: globalThis.__sdk.getDeliveryState(),
      deviceId: (await globalThis.__sdk.getEnv()).deviceId,
      storedId: localStorage.getItem('supersdk_device_id')
    };
  });
  assert.equal(revoked.flush.reason, 'consent_revoked');
  assert.equal(revoked.state.pending, 0);
  assert.equal(revoked.deviceId, '');
  assert.equal(revoked.storedId, null);
  await waitFor(() => requests.aborted > 0);
  assert.deepEqual(pageErrors, []);
  assert.equal(JSON.stringify(result.diagnostics).includes('must-not-enter-diagnostics'), false);
  assert.equal(JSON.stringify(result.diagnostics).includes('ab12cd34'), false);
  await context.close();
});

test('minimum_webview_global_disabled_storage_and_pagehide_are_safe', async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('storage disabled'); } });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get() { throw new Error('indexeddb disabled'); } });
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${pageOrigin}/index.html`);
  const moduleResult = await page.evaluate(async ({ apiOrigin }) => {
    const module = await import('/dist/index.js');
    const sdk = module.createSuperSDK();
    sdk.init({
      spid: 'ab12cd34', baseUrls: [`${apiOrigin}/superapi`], deviceId: 'explicit-denied-id',
      analyticsConsent: 'denied', analytics: { flushIntervalMs: 60000 }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const denied = await sdk.getEnv();
    await sdk.setAnalyticsConsent('granted');
    const granted = await sdk.getEnv();
    await sdk.reportEvent('offline_pagehide', {});
    globalThis.__disabledStorageSdk = sdk;
    return { denied, granted };
  }, { apiOrigin });
  assert.equal(moduleResult.denied.deviceId, '');
  assert.notEqual(moduleResult.granted.deviceId, 'explicit-denied-id');
  await context.setOffline(true);
  const lifecycleState = await page.evaluate(async () => {
    globalThis.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    return globalThis.__disabledStorageSdk.getDeliveryState();
  });
  assert.equal(lifecycleState.persistent, false);
  assert.equal(lifecycleState.pending, 1);
  await context.setOffline(false);

  await page.evaluate(() => { globalThis.appbridge = { readyCalls: 0, onJSBridgeReady() { this.readyCalls += 1; } }; });
  await page.addScriptTag({ url: '/dist/supersdk.js' });
  const globals = await page.evaluate(() => ({
    sdk: typeof globalThis.SuperSDK?.init,
    bridge: typeof globalThis.JSBridge?.subscribeHandler,
    readyCalls: globalThis.appbridge.readyCalls
  }));
  assert.deepEqual(globals, { sdk: 'function', bridge: 'function', readyCalls: 1 });
  assert.deepEqual(pageErrors, []);
  await context.close();
});

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
}

function origin(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function close(server) {
  return new Promise((resolvePromise) => server?.close(() => resolvePromise()));
}

function bodyText(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error('timed out waiting for browser fixture');
}
