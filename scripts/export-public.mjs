import { access, cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { PUBLIC_ROOT_FILES, PUBLIC_SCRIPT_FILES, PUBLIC_SOURCE_DIRECTORIES, listFiles, scanPublicTree, sha256File, verifyPublicTree } from './public-policy.mjs';

const packageRoot = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const outputFlag = args.indexOf('--output');
if (outputFlag < 0 || !args[outputFlag + 1]) {
  console.error('Usage: node scripts/export-public.mjs --output <empty-directory> [--force]');
  process.exit(2);
}
const output = resolve(args[outputFlag + 1]);
const metadataRoot = await exists(resolve(packageRoot, 'public-repo')) ? resolve(packageRoot, 'public-repo') : packageRoot;
if (output === packageRoot || packageRoot.startsWith(`${output}/`)) throw new Error('output must not contain the package source');
if (args.includes('--force')) await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
if ((await listFiles(output)).length) throw new Error('output directory must be empty (or use --force)');

for (const file of PUBLIC_ROOT_FILES) {
  await cp(resolve(packageRoot, file), resolve(output, file));
}
for (const file of PUBLIC_SCRIPT_FILES) {
  await mkdir(resolve(output, dirname(file)), { recursive: true });
  await cp(resolve(packageRoot, file), resolve(output, file));
}
for (const directory of PUBLIC_SOURCE_DIRECTORIES) {
  for (const file of await listFiles(resolve(packageRoot, directory))) {
    await mkdir(resolve(output, directory, dirname(file)), { recursive: true });
    await cp(resolve(packageRoot, directory, file), resolve(output, directory, file));
  }
}
await cp(resolve(metadataRoot, '.gitignore'), resolve(output, '.gitignore'));
await cp(resolve(metadataRoot, 'SECURITY.md'), resolve(output, 'SECURITY.md'));
await cp(resolve(metadataRoot, '.github'), resolve(output, '.github'), { recursive: true });

const firstScan = await scanPublicTree(output);
const packageJson = JSON.parse(await readFile(resolve(output, 'package.json'), 'utf8'));
const digests = {};
for (const file of firstScan.files) digests[file] = await sha256File(resolve(output, file));
await writeFile(resolve(output, 'PUBLIC_PROVENANCE.json'), `${JSON.stringify({
  schema: 1,
  package: packageJson.name,
  version: packageJson.version,
  source: 'allowlisted-export',
  files: digests
}, null, 2)}\n`);
const finalScan = await verifyPublicTree(output);
console.log(JSON.stringify({ output: basename(output), version: packageJson.version, scanned: finalScan.scanned }));

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
