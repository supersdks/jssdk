import assert from 'node:assert/strict';
import test from 'node:test';
import { assertReleaseChannel, releaseChannel } from '../scripts/release-channel.mjs';
import { verifyCandidate, verifyReleaseRecord } from '../scripts/verify-release.mjs';

test('release_channels_are_derived_from_semver_and_reject_mismatched_tags', () => {
  assert.equal(releaseChannel('1.2.3'), 'latest');
  assert.equal(releaseChannel('1.2.3+build-1'), 'latest');
  assert.equal(releaseChannel('1.2.3-rc.1'), 'next');
  assert.equal(assertReleaseChannel('1.2.3-rc.1', 'next'), 'next');
  assert.throws(() => assertReleaseChannel('1.2.3', 'next'), /release tag mismatch/);
  assert.throws(() => releaseChannel('v1.2.3'), /invalid semver/);
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
