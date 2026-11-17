import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from './public-policy.mjs';

const packageRoot = resolve(import.meta.dirname, '..');
const REQUIRED_SUITES = Object.freeze(['jssdk-node-contract', 'android-jsb-contract', 'ios-jsb-contract']);

export async function verifyNativeAttestation(record, { sourceCommit } = {}) {
  if (!record || typeof record !== 'object' || record.schemaVersion !== 1) throw new Error('ATTESTATION_SCHEMA');
  if (!/^[0-9a-f]{40}$/.test(record.sourceCommit || '')) throw new Error('ATTESTATION_COMMIT');
  if (sourceCommit && record.sourceCommit !== sourceCommit) throw new Error('ATTESTATION_COMMIT_MISMATCH');
  const idlSha256 = await sha256File(resolve(packageRoot, 'protocol/v1.json'));
  const generatorSha256 = await sha256File(resolve(packageRoot, 'scripts/generate-bridge-contract.mjs'));
  if (record.idlSha256 !== idlSha256) throw new Error('ATTESTATION_IDL_MISMATCH');
  if (record.generatorSha256 !== generatorSha256) throw new Error('ATTESTATION_GENERATOR_MISMATCH');
  if (!Array.isArray(record.suites) || REQUIRED_SUITES.some((suite) => !record.suites.includes(suite))) throw new Error('ATTESTATION_SUITES');
  if (typeof record.runUrl !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+$/.test(record.runUrl)) {
    throw new Error('ATTESTATION_RUN_URL');
  }
  return Object.freeze({
    schemaVersion: 1,
    sourceCommit: record.sourceCommit,
    idlSha256,
    generatorSha256,
    suites: [...REQUIRED_SUITES],
    runUrl: record.runUrl
  });
}

export async function readAndVerifyNativeAttestation(path, options) {
  return verifyNativeAttestation(JSON.parse(await readFile(resolve(path), 'utf8')), options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const attestationIndex = process.argv.indexOf('--attestation');
  const provenanceIndex = process.argv.indexOf('--provenance');
  const sourceIndex = process.argv.indexOf('--source-commit');
  if (sourceIndex >= 0 && !process.argv[sourceIndex + 1]) throw new Error('provide a value for --source-commit');
  const sourceCommit = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : undefined;
  let record;
  if (attestationIndex >= 0 && process.argv[attestationIndex + 1]) {
    record = JSON.parse(await readFile(resolve(process.argv[attestationIndex + 1]), 'utf8'));
  } else if (provenanceIndex >= 0 && process.argv[provenanceIndex + 1]) {
    const provenance = JSON.parse(await readFile(resolve(process.argv[provenanceIndex + 1]), 'utf8'));
    record = provenance.jsbContract;
  } else {
    throw new Error('provide --attestation or --provenance');
  }
  console.log(JSON.stringify(await verifyNativeAttestation(record, { sourceCommit })));
}
