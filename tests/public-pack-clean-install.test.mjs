import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { TARBALL_FILES } from '../scripts/public-policy.mjs';

const packageRoot = resolve(import.meta.dirname, '..');

test('npm_pack_contains_only_declared_public_files_and_no_sourcemap', async () => {
  const output = JSON.parse(execFileSync('npm', ['pack', '--json', '--dry-run'], { cwd: packageRoot, encoding: 'utf8' }));
  const record = Array.isArray(output) ? output[0] : output[Object.keys(output)[0]];
  const files = record.files.map((entry) => entry.path).sort();
  assert.deepEqual(files, [...TARBALL_FILES]);
  assert.equal(record.entryCount, TARBALL_FILES.length);
  assert.equal(record.name, '@supersdk/jssdk');
  assert.equal(record.version, '1.0.0');
  assert.ok(record.integrity.startsWith('sha512-'));
  assert.equal(files.some((file) => file.endsWith('.map')), false);
  assert.equal(files.some((file) => /(?:src|tests|scripts|android|ios|server|private)/i.test(file)), false);

  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'dist/manifest.json'), 'utf8'));
  assert.equal(manifest.version, record.version);
  assert.deepEqual(Object.keys(manifest.files).sort(), [
    'global.cjs', 'global.d.ts', 'global.js', 'index.bundle.cjs', 'index.cjs',
    'index.d.ts', 'index.js', 'supersdk.js'
  ]);
  assert.ok(Object.values(manifest.files).every((size) => Number.isInteger(size) && size > 0));
});
