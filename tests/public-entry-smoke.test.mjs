import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const packageRoot = resolve(import.meta.dirname, '..');

test('clean_install_supports_esm_cjs_types_and_explicit_global_entry', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'supersdk-pack-smoke-'));
  const packOutput = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temporary], {
    cwd: packageRoot,
    encoding: 'utf8'
  }));
  const record = Array.isArray(packOutput) ? packOutput[0] : packOutput[Object.keys(packOutput)[0]];
  const tarball = resolve(temporary, record.filename);
  const consumer = resolve(temporary, 'consumer');
  await mkdir(consumer, { recursive: true });
  await writeFile(resolve(consumer, 'package.json'), JSON.stringify({ name: 'clean-consumer', private: true, type: 'module' }));
  execFileSync('npm', ['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumer, stdio: 'pipe' });

  await writeFile(resolve(consumer, 'esm.mjs'), `
    const before = ['SuperSDK', 'JSBridge'].map((key) => Object.hasOwn(globalThis, key));
    const module = await import('@supersdk/jssdk');
    if (before.some(Boolean) || Object.hasOwn(globalThis, 'SuperSDK') || Object.hasOwn(globalThis, 'JSBridge')) throw new Error('root import wrote globals');
    if (typeof module.default.init !== 'function' || typeof module.createSuperSDK !== 'function') throw new Error('missing ESM API');
    const isolated = module.createSuperSDK({ target: {} });
    isolated.init({ spid: 'ab12cd34' });
    if ((await isolated.getEnv()).spid !== 'ab12cd34') throw new Error('isolated init failed');
    await import('@supersdk/jssdk/global');
    if (!globalThis.SuperSDK || !globalThis.JSBridge) throw new Error('explicit global entry failed');
  `);
  execFileSync(process.execPath, ['esm.mjs'], { cwd: consumer, stdio: 'pipe' });

  await writeFile(resolve(consumer, 'cjs.cjs'), `
    const before = ['SuperSDK', 'JSBridge'].map((key) => Object.hasOwn(globalThis, key));
    const sdk = require('@supersdk/jssdk');
    if (before.some(Boolean) || Object.hasOwn(globalThis, 'SuperSDK') || Object.hasOwn(globalThis, 'JSBridge')) throw new Error('root require wrote globals');
    if (typeof sdk.init !== 'function' || typeof sdk.createSuperSDK !== 'function') throw new Error('missing CJS API');
    for (const path of ['@supersdk/jssdk/src/index.js', '@supersdk/jssdk/dist/index.js']) {
      try { require.resolve(path); throw new Error('deep import resolved: ' + path); }
      catch (error) { if (!String(error.code).includes('PACKAGE_PATH_NOT_EXPORTED')) throw error; }
    }
  `);
  execFileSync(process.execPath, ['cjs.cjs'], { cwd: consumer, stdio: 'pipe' });

  await writeFile(resolve(consumer, 'index.ts'), `
    import SDK, { createSuperSDK, SuperSDKError, type FlushSummary } from '@supersdk/jssdk';
    import '@supersdk/jssdk/global';
    SDK.init({ spid: 'ab12cd34', analyticsConsent: 'denied' });
    const isolated = createSuperSDK();
    const error: SuperSDKError | null = null;
    const result: Promise<FlushSummary> = isolated.flush();
    window.SuperSDK.getDeliveryState();
    void error; void result;
  `);
  await writeFile(resolve(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2020', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      noEmit: true, lib: ['ES2020', 'DOM'], skipLibCheck: false
    },
    files: ['index.ts']
  }));
  const tsc = resolve(packageRoot, 'node_modules/typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: consumer, stdio: 'inherit' });

  const installedPackage = JSON.parse(await readFile(resolve(consumer, 'node_modules/@supersdk/jssdk/package.json'), 'utf8'));
  assert.equal(installedPackage.version, '1.0.0');
  assert.deepEqual(Object.keys(installedPackage.exports), ['.', './global', './supersdk.js']);
  assert.equal(installedPackage.dependencies, undefined);
});
