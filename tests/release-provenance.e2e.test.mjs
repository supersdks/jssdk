import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { assertReleaseChannel, releaseChannel } from '../scripts/release-channel.mjs';
import { normalizeRegistryRecord, verifyCandidate, verifyReleaseRecord } from '../scripts/verify-release.mjs';

const packageRoot = resolve(import.meta.dirname, '..');

test('release_channels_are_derived_from_semver_and_reject_mismatched_tags', () => {
  assert.equal(releaseChannel('1.2.3'), 'latest');
  assert.equal(releaseChannel('1.2.3+build-1'), 'latest');
  assert.equal(releaseChannel('1.2.3-rc.1'), 'next');
  assert.equal(assertReleaseChannel('1.2.3-rc.1', 'next'), 'next');
  assert.throws(() => assertReleaseChannel('1.2.3', 'next'), /release tag mismatch/);
  assert.throws(() => releaseChannel('v1.2.3'), /invalid semver/);
});

test('npm_registry_records_accept_an_object_or_exactly_one_npm12_array_entry', () => {
  const record = { dist: { integrity: 'sha512-value' } };
  assert.equal(normalizeRegistryRecord(record), record);
  assert.equal(normalizeRegistryRecord([record]), record);
  assert.throws(() => normalizeRegistryRecord([]), /PUBLISHED_RECORD_AMBIGUOUS/);
  assert.throws(() => normalizeRegistryRecord([record, record]), /PUBLISHED_RECORD_AMBIGUOUS/);
  assert.throws(() => normalizeRegistryRecord(null), /PUBLISHED_RECORD_INVALID/);
});

test('published_version_is_immutable_and_tag_tarball_integrity_and_digest_are_traceable', async () => {
  const candidate = await verifyCandidate();
  assert.equal(candidate.name, '@supersdk/jssdk');
  assert.equal(candidate.version, '1.0.0');
  assert.match(candidate.integrity, /^sha512-/);
  assert.deepEqual(verifyReleaseRecord({
    packageJson: { name: candidate.name, version: candidate.version },
    packRecord: candidate,
    consumerProvenances: [{
      package: candidate.name, version: candidate.version, integrity: candidate.integrity,
      file: 'dist/supersdk.js', sha256: '0'.repeat(64)
    }]
  }), candidate);

  assert.throws(() => verifyReleaseRecord({
    packageJson: { name: candidate.name, version: candidate.version },
    packRecord: candidate,
    registryVersions: { [candidate.version]: { dist: { integrity: candidate.integrity } } }
  }), /VERSION_ALREADY_EXISTS/);

  assert.throws(() => verifyReleaseRecord({
    packageJson: { name: candidate.name, version: candidate.version },
    packRecord: candidate,
    consumerProvenances: [{
      package: candidate.name, version: candidate.version, integrity: 'sha512-different',
      file: 'dist/supersdk.js', sha256: '0'.repeat(64)
    }]
  }), /CONSUMER_ARTIFACT_MISMATCH/);
});

test('publish_workflow_uses_shell_safe_version_detection_and_idempotent_registry_verification', async () => {
  const privateWorkflow = resolve(packageRoot, 'public-repo/.github/workflows/publish.yml');
  const publicWorkflow = resolve(packageRoot, '.github/workflows/publish.yml');
  const workflowPath = await exists(privateWorkflow) ? privateWorkflow : publicWorkflow;
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /version="\$\(node -p 'require\("\.\/package\.json"\)\.version'\)"/);
  assert.doesNotMatch(workflow, /node -p \\"/);
  assert.match(workflow, /node scripts\/verify-release\.mjs --published/);
  assert.match(workflow, /steps\.registry\.outputs\.exists != 'true'/);
});

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
