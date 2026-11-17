import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { sha256File } from '../scripts/public-policy.mjs';
import { assertReleaseChannel, releaseChannel } from '../scripts/release-channel.mjs';
import { normalizeRegistryRecord, verifyCandidate, verifyReleaseRecord } from '../scripts/verify-release.mjs';

const packageRoot = resolve(import.meta.dirname, '..');

test('release_channels_are_derived_from_semver_and_reject_mismatched_tags', () => {
  assert.equal(releaseChannel('2.0.0'), 'candidate');
  assert.equal(releaseChannel('2.0.0+build-1'), 'candidate');
  assert.equal(releaseChannel('1.2.3-rc.1'), 'next');
  assert.equal(assertReleaseChannel('1.2.3-rc.1', 'next'), 'next');
  assert.throws(() => assertReleaseChannel('2.0.0', 'latest'), /release tag mismatch/);
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
  assert.equal(candidate.version, JSON.parse(await readFile(resolve(import.meta.dirname, '..', 'package.json'), 'utf8')).version);
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
  assert.match(workflow, /verify-native-attestation\.mjs --provenance PUBLIC_PROVENANCE\.json/);
  assert.doesNotMatch(workflow, /verify-native-attestation\.mjs[^\n]*github\.sha/);
  assert.match(workflow, /steps\.registry\.outputs\.exists != 'true'/);
  assert.match(workflow, /dist-tags\.candidate/);
  const promote = await readFile(resolve(workflowPath, '..', 'promote.yml'), 'utf8');
  assert.match(promote, /npm dist-tag add "@supersdk\/jssdk@\$VERSION" latest/);
  assert.match(promote, /npm dist-tag rm @supersdk\/jssdk candidate/);
  assert.match(promote, /verify-release\.mjs --published/);
});

test('attestation_cli_ignores_public_github_sha_unless_source_commit_is_explicit', async () => {
  const internalSourceCommit = 'a'.repeat(40);
  const publicRepositoryCommit = 'b'.repeat(40);
  const wrongInternalCommit = 'c'.repeat(40);
  const cli = resolve(packageRoot, 'scripts/verify-native-attestation.mjs');
  const workDir = await mkdtemp(join(tmpdir(), 'jssdk-attestation-cli-'));
  const provenancePath = resolve(workDir, 'PUBLIC_PROVENANCE.json');
  const record = {
    schemaVersion: 1,
    sourceCommit: internalSourceCommit,
    idlSha256: await sha256File(resolve(packageRoot, 'protocol/v1.json')),
    generatorSha256: await sha256File(resolve(packageRoot, 'scripts/generate-bridge-contract.mjs')),
    suites: ['jssdk-node-contract', 'android-jsb-contract', 'ios-jsb-contract'],
    runUrl: 'https://github.com/supersdks/supersdk/actions/runs/123456'
  };

  try {
    await writeFile(provenancePath, `${JSON.stringify({ jsbContract: record })}\n`);
    const publishShape = runAttestationCli(cli, ['--provenance', provenancePath], publicRepositoryCommit);
    assert.equal(publishShape.status, 0, publishShape.stderr);
    assert.equal(JSON.parse(publishShape.stdout).sourceCommit, internalSourceCommit);

    const wrongPromotion = runAttestationCli(
      cli,
      ['--provenance', provenancePath, '--source-commit', wrongInternalCommit],
      publicRepositoryCommit
    );
    assert.notEqual(wrongPromotion.status, 0);
    assert.match(wrongPromotion.stderr, /ATTESTATION_COMMIT_MISMATCH/);

    const correctPromotion = runAttestationCli(
      cli,
      ['--provenance', provenancePath, '--source-commit', internalSourceCommit],
      publicRepositoryCommit
    );
    assert.equal(correctPromotion.status, 0, correctPromotion.stderr);
    assert.equal(JSON.parse(correctPromotion.stdout).sourceCommit, internalSourceCommit);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

function runAttestationCli(cli, args, githubSha) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_SHA: githubSha }
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
