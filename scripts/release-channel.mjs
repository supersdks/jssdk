import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function releaseChannel(version) {
  const match = typeof version === 'string' ? SEMVER.exec(version) : null;
  if (!match) throw new Error(`invalid semver version: ${version}`);
  return match[4] ? 'next' : 'latest';
}

export function assertReleaseChannel(version, tag) {
  const expected = releaseChannel(version);
  if (tag !== expected) throw new Error(`release tag mismatch: ${version} must publish to ${expected}, received ${tag}`);
  return expected;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const versionIndex = process.argv.indexOf('--version');
  const version = versionIndex < 0 ? undefined : process.argv[versionIndex + 1];
  const tagIndex = process.argv.indexOf('--tag');
  const tag = tagIndex < 0 ? undefined : process.argv[tagIndex + 1];
  const channel = tag === undefined ? releaseChannel(version) : assertReleaseChannel(version, tag);
  console.log(channel);
}
