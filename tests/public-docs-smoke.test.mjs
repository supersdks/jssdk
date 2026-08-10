import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const packageRoot = resolve(import.meta.dirname, '..');

test('public_documentation_completes_first_time_browser_and_global_migration_without_private_docs', async () => {
  const readme = await readFile(resolve(packageRoot, 'README.md'), 'utf8');
  for (const required of [
    'npm install @supersdk/jssdk',
    "import SuperSDK from '@supersdk/jssdk'",
    'SuperSDK.init({',
    'getHostSettings',
    'setAnalyticsConsent',
    'reportEvent',
    'flush()',
    '@supersdk/jssdk/global',
    'Native-only methods',
    'analyticsConsent: \'denied\''
  ]) assert.ok(readme.includes(required), `README missing: ${required}`);
  assert.equal(/(?:docs\/features|release_doc|private monorepo|\/workspace\/)/i.test(readme), false);
  assert.ok(readme.includes('Runtime dependencies: none'));
  assert.ok(readme.includes('ES2020'));
});
