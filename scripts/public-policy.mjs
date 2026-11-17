import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

export const PUBLIC_ROOT_FILES = Object.freeze([
  'CHANGELOG.md', 'JSBridge.md', 'LICENSE', 'README.md', 'package-lock.json', 'package.json',
  'supersdk.test.cjs'
]);

export const PUBLIC_SOURCE_DIRECTORIES = Object.freeze(['protocol', 'src', 'tests', 'types']);
export const PRIVATE_ONLY_SOURCE_FILES = Object.freeze(new Set([
  'tests/jsb-workflow.test.mjs',
  'tests/native-contract.test.mjs',
  'tests/monitoring-native-contract.e2e.test.mjs',
  'tests/monitoring-privacy.test.mjs',
  'tests/push-docs.test.mjs',
  'tests/fixtures/monitoring-v1-negative.json'
]));

export const PUBLIC_SCRIPT_FILES = Object.freeze([
  'scripts/build.mjs', 'scripts/export-public.mjs', 'scripts/generate-bridge-contract.mjs',
  'scripts/generate-monitoring-contract.mjs', 'scripts/generate-suenc-contract.mjs',
  'scripts/public-policy.mjs', 'scripts/release-channel.mjs', 'scripts/verify-native-attestation.mjs',
  'scripts/verify-public-tree.mjs', 'scripts/verify-release.mjs'
]);

export const TARBALL_FILES = Object.freeze([
  'CHANGELOG.md',
  'JSBridge.md',
  'LICENSE',
  'README.md',
  'dist/global.cjs',
  'dist/global.d.ts',
  'dist/global.js',
  'dist/index.bundle.cjs',
  'dist/index.cjs',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/manifest.json',
  'dist/mock.cjs',
  'dist/mock.d.ts',
  'dist/mock.js',
  'dist/monitoring-contract.d.ts',
  'dist/protocol.cjs',
  'dist/protocol.d.ts',
  'dist/protocol.js',
  'dist/supersdk.js',
  'package.json',
  'protocol/experiment-v1-golden.json',
  'protocol/experiment-v1.json',
  'protocol/golden-vectors.json',
  'protocol/monitoring-v1-golden.json',
  'protocol/monitoring-v1.json',
  'protocol/push-v1.json',
  'protocol/suenc-v1-golden.json',
  'protocol/suenc-v1.json',
  'protocol/v1.json'
]);

const FORBIDDEN_PATH_PARTS = [
  '.teamwork', 'docs/features', 'android', 'ios', 'server', 'infra',
  'private-key', 'release_doc', 'supersimples', 'apps/'
];

const FORBIDDEN_CONTENT = [
  /BEGIN (?:PGP |RSA |EC |OPENSSH )?PRIVATE KEY/i,
  /(?:npm|github|gh|api)[_-]?(?:token|secret)\s*[:=]\s*['"][^'"]+/i,
  /(?:npm|github|gh|api)[_-]?(?:token|secret)\s*[:=]\s*(?!\$\{\{|\$[A-Z_]+|process\.env\b)[^\s'"`]+/i,
  /\/workspace\//,
  /\/Users\/[^/]+\//,
  /\/home\/[^/]+\//,
  /\\Users\\[^\\]+\\/
];

const GENERATED_TOP_LEVEL_DIRECTORIES = new Set(['.git', 'dist', 'node_modules']);

export async function listFiles(root, { ignoreGeneratedDirectories = false } = {}) {
  const base = resolve(root);
  const result = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignoreGeneratedDirectories && directory === base && entry.isDirectory() && GENERATED_TOP_LEVEL_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const path = resolve(directory, entry.name);
      const rel = relative(base, path).split(sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`public export rejects symlink: ${rel}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) result.push(rel);
      else throw new Error(`public export rejects special file: ${rel}`);
    }
  }
  await walk(base);
  return result.sort();
}

export async function scanPublicTree(root, { allowGeneratedProvenance = false, ignoreGeneratedDirectories = false } = {}) {
  const files = await listFiles(root, { ignoreGeneratedDirectories });
  if (!files.length) throw new Error('public scan examined zero files');
  for (const file of files) {
    if (!isAllowedPublicFile(file, allowGeneratedProvenance)) throw new Error(`public path not allowlisted: ${file}`);
    const lowered = file.toLowerCase();
    if (lowered.split('/').includes('.git') || FORBIDDEN_PATH_PARTS.some((part) => lowered.includes(part.toLowerCase()))) {
      throw new Error(`public path rejected: ${file}`);
    }
    if (file.endsWith('.map')) throw new Error(`sourcemap rejected: ${file}`);
    const buffer = await readFile(resolve(root, file));
    if (buffer.includes(0)) throw new Error(`public binary content rejected: ${file}`);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      throw new Error(`public non-utf8 content rejected: ${file}`);
    }
    if (FORBIDDEN_CONTENT.some((pattern) => pattern.test(text))) {
      throw new Error(`public content rejected: ${file}`);
    }
  }
  return { files, scanned: files.length };
}

export async function verifyPublicTree(root) {
  const scan = await scanPublicTree(root, {
    allowGeneratedProvenance: true,
    ignoreGeneratedDirectories: true
  });
  const provenancePath = resolve(root, 'PUBLIC_PROVENANCE.json');
  let provenance;
  try {
    provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  } catch (error) {
    throw new Error(`public provenance is invalid: ${error.message}`);
  }
  if (provenance?.schema !== 1 || provenance?.source !== 'allowlisted-export') {
    throw new Error('public provenance has an unsupported schema or source');
  }
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (provenance.package !== packageJson.name || provenance.version !== packageJson.version) {
    throw new Error('public provenance package identity mismatch');
  }
  if (!provenance.files || typeof provenance.files !== 'object' || Array.isArray(provenance.files)) {
    throw new Error('public provenance files must be an object');
  }
  const expectedFiles = scan.files.filter((file) => file !== 'PUBLIC_PROVENANCE.json');
  const recordedFiles = Object.keys(provenance.files).sort();
  if (expectedFiles.length !== recordedFiles.length || expectedFiles.some((file, index) => file !== recordedFiles[index])) {
    throw new Error('public provenance allowlist digest set mismatch');
  }
  for (const file of expectedFiles) {
    if (!/^[0-9a-f]{64}$/.test(provenance.files[file] || '')) {
      throw new Error(`public provenance digest is invalid: ${file}`);
    }
    if (provenance.files[file] !== await sha256File(resolve(root, file))) {
      throw new Error(`public provenance digest mismatch: ${file}`);
    }
  }
  return { ...scan, provenance };
}

function isAllowedPublicFile(file, allowGeneratedProvenance) {
  if (PUBLIC_ROOT_FILES.includes(file)) return true;
  if (PUBLIC_SCRIPT_FILES.includes(file)) return true;
  if (file === '.gitignore' || file === 'SECURITY.md') return true;
  if (file === '.github/workflows/ci.yml' || file === '.github/workflows/publish.yml' || file === '.github/workflows/promote.yml') return true;
  if (file === 'PUBLIC_PROVENANCE.json') return allowGeneratedProvenance;
  if (file.startsWith('src/')) return file.endsWith('.js');
  if (file.startsWith('protocol/')) return file.endsWith('.json');
  if (file.startsWith('types/')) return file.endsWith('.d.ts');
  if (file.startsWith('tests/')) return file.endsWith('.test.mjs') || file === 'tests/helpers.mjs' ||
    /^tests\/fixtures\/runtime-1\.0\/(?:contract\.json|supersdk-1\.0\.0\.js\.gz\.base64)$/.test(file);
  return false;
}

export async function sha256File(path) {
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error(`not a regular file: ${path}`);
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
