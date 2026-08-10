import { execFileSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPublicTree } from './public-policy.mjs';

const packageRoot = resolve(import.meta.dirname, '..');

export async function verifyCurrentOrExportedPublicTree(root = packageRoot) {
  if (await exists(resolve(root, 'PUBLIC_PROVENANCE.json'))) return verifyPublicTree(root);

  // The private monorepo source intentionally contains material that may not
  // be public. Verify its generated allowlisted snapshot instead of weakening
  // the gate for local verification.
  const isPrivateSource = await exists(resolve(root, 'moon.yml')) && await exists(resolve(root, 'public-repo'));
  if (!isPrivateSource) return verifyPublicTree(root);
  const temporary = await mkdtemp(resolve(tmpdir(), 'supersdk-public-verify-'));
  const output = resolve(temporary, 'jssdk');
  try {
    execFileSync(process.execPath, [resolve(root, 'scripts/export-public.mjs'), '--output', output], {
      cwd: root,
      stdio: 'pipe'
    });
    return await verifyPublicTree(output);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyCurrentOrExportedPublicTree();
  console.log(JSON.stringify({ scanned: result.scanned, package: result.provenance.package, version: result.provenance.version }));
}
