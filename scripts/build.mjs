import { build } from 'esbuild';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
await mkdir(dist, { recursive: true });

const common = {
  bundle: true,
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  target: ['es2020'],
  logLevel: 'info'
};

await Promise.all([
  build({ ...common, entryPoints: [resolve(root, 'src/index.js')], format: 'esm', outfile: resolve(dist, 'index.js') }),
  build({ ...common, entryPoints: [resolve(root, 'src/index.js')], format: 'cjs', outfile: resolve(dist, 'index.bundle.cjs') }),
  build({ ...common, entryPoints: [resolve(root, 'src/global.js')], format: 'esm', outfile: resolve(dist, 'global.js') }),
  build({ ...common, entryPoints: [resolve(root, 'src/global.js')], format: 'cjs', outfile: resolve(dist, 'global.cjs') }),
  build({ ...common, entryPoints: [resolve(root, 'src/global.js')], format: 'iife', outfile: resolve(dist, 'supersdk.js') }),
  build({ ...common, entryPoints: [resolve(root, 'src/protocol.js')], format: 'esm', outfile: resolve(dist, 'protocol.js') }),
  build({ ...common, entryPoints: [resolve(root, 'src/protocol.js')], format: 'cjs', outfile: resolve(dist, 'protocol.cjs') }),
  build({ ...common, entryPoints: [resolve(root, 'src/mock.js')], format: 'esm', outfile: resolve(dist, 'mock.js') }),
  build({ ...common, entryPoints: [resolve(root, 'src/mock.js')], format: 'cjs', outfile: resolve(dist, 'mock.cjs') })
]);

await copyFile(resolve(root, 'types/index.d.ts'), resolve(dist, 'index.d.ts'));
await copyFile(resolve(root, 'types/global.d.ts'), resolve(dist, 'global.d.ts'));
await copyFile(resolve(root, 'types/protocol.d.ts'), resolve(dist, 'protocol.d.ts'));
await copyFile(resolve(root, 'types/mock.d.ts'), resolve(dist, 'mock.d.ts'));
await copyFile(resolve(root, 'types/monitoring-contract.d.ts'), resolve(dist, 'monitoring-contract.d.ts'));
// The private monorepo keeps a tracked legacy IIFE at the package root for old
// consumers.  A public allowlisted export deliberately omits that private
// compatibility copy, so building the public repository must not create an
// untracked root file that fails its own fail-closed source-tree scan.
if (await exists(resolve(root, 'supersdk.js'))) {
  await copyFile(resolve(dist, 'supersdk.js'), resolve(root, 'supersdk.js'));
}
await writeFile(resolve(dist, 'index.cjs'), "const m=require('./index.bundle.cjs');module.exports=Object.assign(m.default,m);\n");

const files = ['index.js', 'index.cjs', 'index.bundle.cjs', 'global.js', 'global.cjs', 'supersdk.js', 'protocol.js', 'protocol.cjs', 'mock.js', 'mock.cjs', 'index.d.ts', 'global.d.ts', 'protocol.d.ts', 'mock.d.ts', 'monitoring-contract.d.ts'];
const manifest = {};
for (const file of files) manifest[file] = Buffer.byteLength(await readFile(resolve(dist, file)));
await writeFile(resolve(dist, 'manifest.json'), `${JSON.stringify({ version: packageJson.version, files: manifest }, null, 2)}\n`);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
