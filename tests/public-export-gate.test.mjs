import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { listFiles, scanPublicTree, verifyPublicTree } from '../scripts/public-policy.mjs';

const packageRoot = resolve(import.meta.dirname, '..');

test('public_tree_and_tarball_allowlist_rejects_private_content_secrets_and_paths', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'supersdk-public-export-'));
  const output = resolve(temporary, 'jssdk');
  const report = JSON.parse(execFileSync(process.execPath, [
    resolve(packageRoot, 'scripts/export-public.mjs'), '--output', output
  ], { cwd: packageRoot, encoding: 'utf8' }));
  const scan = await scanPublicTree(output, { allowGeneratedProvenance: true });
  const verified = await verifyPublicTree(output);
  const publicPackage = JSON.parse(await readFile(resolve(output, 'package.json'), 'utf8'));
  assert.equal(scan.scanned, report.scanned);
  assert.equal(verified.scanned, report.scanned);
  assert.match(publicPackage.scripts.verify, /verify:public-tree/);
  execFileSync('npm', ['run', 'verify:public-tree'], { cwd: output, stdio: 'pipe' });
  assert.ok(scan.scanned > 20, 'scan must prove it examined the public tree');
  assert.ok(scan.files.includes('.github/workflows/ci.yml'));
  assert.ok(scan.files.includes('.github/workflows/publish.yml'));
  assert.ok(scan.files.includes('PUBLIC_PROVENANCE.json'));
  assert.equal(scan.files.some((file) => /(?:docs\/features|release_doc|supersimples|android|ios|server)/i.test(file)), false);
  await writeFile(resolve(output, 'unexpected.txt'), 'innocent but not approved\n');
  await assert.rejects(scanPublicTree(output, { allowGeneratedProvenance: true }), /public path not allowlisted: unexpected\.txt/);
});

test('generated_public_tree_scans_provenance_for_secrets_and_absolute_paths', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'supersdk-public-provenance-'));
  const output = resolve(temporary, 'jssdk');
  execFileSync(process.execPath, [resolve(packageRoot, 'scripts/export-public.mjs'), '--output', output], {
    cwd: packageRoot,
    stdio: 'pipe'
  });
  const provenancePath = resolve(output, 'PUBLIC_PROVENANCE.json');
  const provenance = await readFile(provenancePath, 'utf8');
  await writeFile(provenancePath, `${provenance}\n${['api', '_token'].join('')}=${["'not", "-public'"].join('')}\n`);
  await assert.rejects(scanPublicTree(output, { allowGeneratedProvenance: true }), /public content rejected: PUBLIC_PROVENANCE\.json/);
  assert.throws(() => execFileSync('npm', ['run', 'verify'], { cwd: output, stdio: 'pipe' }), /Command failed/);
  await writeFile(provenancePath, `${provenance}\nsource_path=${['/work', 'space/private-jssdk'].join('')}\n`);
  await assert.rejects(scanPublicTree(output, { allowGeneratedProvenance: true }), /public content rejected: PUBLIC_PROVENANCE\.json/);
});

test('public_repo_missing_provenance_fails_instead_of_falling_back_to_private_export_mode', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'supersdk-public-missing-provenance-'));
  const output = resolve(temporary, 'jssdk');
  execFileSync(process.execPath, [resolve(packageRoot, 'scripts/export-public.mjs'), '--output', output], {
    cwd: packageRoot,
    stdio: 'pipe'
  });
  await rm(resolve(output, 'PUBLIC_PROVENANCE.json'));
  assert.throws(() => execFileSync('npm', ['run', 'verify:public-tree'], { cwd: output, stdio: 'pipe' }), /Command failed/);
});

test('installed_public_tree_ignores_only_top_level_generated_directories', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'supersdk-public-installed-'));
  const output = resolve(temporary, 'jssdk');
  execFileSync(process.execPath, [resolve(packageRoot, 'scripts/export-public.mjs'), '--output', output], {
    cwd: packageRoot,
    stdio: 'pipe'
  });
  await mkdir(resolve(output, 'node_modules/.bin'), { recursive: true });
  await mkdir(resolve(output, 'node_modules/pkg'), { recursive: true });
  await mkdir(resolve(output, 'dist'), { recursive: true });
  await mkdir(resolve(output, '.git/objects'), { recursive: true });
  await writeFile(resolve(output, 'node_modules/pkg/bin.js'), 'export default true;\n');
  await symlink('../pkg/bin.js', resolve(output, 'node_modules/.bin/pkg'));
  await writeFile(resolve(output, 'dist/index.js'), 'export default true;\n');
  await writeFile(resolve(output, '.git/objects/generated'), 'not public source\n');
  const verified = await verifyPublicTree(output);
  assert.equal(verified.files.some((file) => /^(?:node_modules|dist|\.git)\//.test(file)), false);
});

test('public_export_and_tarball_scan_rejects_private_history_native_server_and_process_material', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'supersdk-public-reject-'));
  await mkdir(resolve(temporary, 'src'), { recursive: true });
  await writeFile(resolve(temporary, 'src/index.js'), 'export default true;\n');
  await mkdir(resolve(temporary, 'docs/features'), { recursive: true });
  await writeFile(resolve(temporary, 'docs/features/process.md'), 'internal process\n');
  await assert.rejects(scanPublicTree(temporary), /docs\/features\/process\.md/);

  const secretTree = await mkdtemp(resolve(tmpdir(), 'supersdk-public-secret-'));
  await mkdir(resolve(secretTree, 'src'), { recursive: true });
  await writeFile(resolve(secretTree, 'src/index.js'), `const marker = ['BEGIN PGP', 'PRIVATE KEY'].join(' ');\n${''}`);
  assert.deepEqual(await listFiles(secretTree), ['src/index.js']);
  await writeFile(resolve(secretTree, 'src/key.js'), ['-----BEGIN PGP', 'PRIVATE KEY-----'].join(' '));
  await assert.rejects(scanPublicTree(secretTree), /public content rejected: src\/key\.js/);
});
