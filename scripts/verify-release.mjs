import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(import.meta.dirname, '..');

export function verifyReleaseRecord({ packageJson, packRecord, consumerProvenances = [], registryVersions = null }) {
  if (packageJson.name !== '@supersdk/jssdk') throw new Error('PACKAGE_IDENTITY_MISMATCH');
  if (packRecord.name !== packageJson.name || packRecord.version !== packageJson.version) throw new Error('PACK_IDENTITY_MISMATCH');
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(packRecord.integrity || '')) throw new Error('PACK_INTEGRITY_INVALID');
  if (registryVersions && Object.hasOwn(registryVersions, packageJson.version)) throw new Error('VERSION_ALREADY_EXISTS');
  for (const provenance of consumerProvenances) {
    if (provenance.package !== packageJson.name || provenance.version !== packageJson.version) throw new Error('CONSUMER_IDENTITY_MISMATCH');
    if (provenance.integrity !== packRecord.integrity || provenance.file !== 'dist/supersdk.js') throw new Error('CONSUMER_ARTIFACT_MISMATCH');
    if (!/^[0-9a-f]{64}$/.test(provenance.sha256 || '')) throw new Error('CONSUMER_DIGEST_INVALID');
  }
  return Object.freeze({ name: packageJson.name, version: packageJson.version, integrity: packRecord.integrity });
}

export async function verifyCandidate({ consumers = false } = {}) {
  const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  const packRecord = npmPackRecord(packageRoot);
  const consumerProvenances = consumers ? await readConsumerProvenances() : [];
  return verifyReleaseRecord({ packageJson, packRecord, consumerProvenances });
}

export async function verifyPublished() {
  const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  const tag = `v${packageJson.version}`;
  const registry = normalizeRegistryRecord(JSON.parse(execFileSync(
    'npm', ['view', `${packageJson.name}@${packageJson.version}`, '--json'], { encoding: 'utf8' }
  )));
  if (!registry?.dist?.integrity) throw new Error('PUBLISHED_INTEGRITY_MISSING');
  const temporary = await mkdtemp(resolve(tmpdir(), 'supersdk-public-tag-'));
  const checkout = resolve(temporary, 'jssdk');
  try {
    execFileSync('git', ['clone', '--depth', '1', '--branch', tag, 'https://github.com/supersdks/jssdk.git', checkout], { stdio: 'pipe' });
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: checkout, stdio: 'pipe' });
    execFileSync('npm', ['run', 'build'], { cwd: checkout, stdio: 'pipe' });
    const rebuilt = npmPackRecord(checkout);
    verifyReleaseRecord({ packageJson, packRecord: rebuilt });
    if (rebuilt.integrity !== registry.dist.integrity) throw new Error('TAG_REGISTRY_INTEGRITY_MISMATCH');
    return Object.freeze({ name: packageJson.name, version: packageJson.version, tag, integrity: rebuilt.integrity });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function normalizeRegistryRecord(value) {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new Error('PUBLISHED_RECORD_AMBIGUOUS');
    return value[0];
  }
  if (!value || typeof value !== 'object') throw new Error('PUBLISHED_RECORD_INVALID');
  return value;
}

function npmPackRecord(cwd) {
  const output = JSON.parse(execFileSync('npm', ['pack', '--json', '--dry-run'], { cwd, encoding: 'utf8' }));
  return Array.isArray(output) ? output[0] : output[Object.keys(output)[0]];
}

async function readConsumerProvenances() {
  const repositoryRoot = resolve(packageRoot, '../..');
  const files = [
    'apps/fe-main/src/js/supersdk.provenance.json',
    'supersimples/app_repo_example/web/src/js/supersdk.provenance.json',
    'release_doc/supersdk/dev/JSSDK/supersdk.provenance.json'
  ];
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(resolve(repositoryRoot, file), 'utf8'))));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const published = process.argv.includes('--published');
  const result = published
    ? await verifyPublished()
    : await verifyCandidate({ consumers: process.argv.includes('--consumers') });
  console.log(JSON.stringify(result));
}
