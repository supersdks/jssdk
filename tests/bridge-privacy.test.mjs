import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics } from '../src/core/diagnostics.js';
import { SuperSDKError } from '../src/core/errors.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BRIDGE_PROTOCOL } from '../src/protocol.js';

test('diagnostics allow only bounded metadata and report throwing sinks without recursion', () => {
  const canary = 'CANARY_91b8fcd1_path_token_body';
  const received = [];
  const diagnostics = createDiagnostics({ sink() { throw new Error(canary); } });
  diagnostics.subscribe((entry) => received.push(entry));
  diagnostics.emit('error', {
    category: 'bridge_operation', requestId: 'r1', api: 'readFile', state: 'negotiated',
    outcome: 'failure', errorClass: 'Error', args: canary, result: canary, message: canary,
    path: canary, body: canary, url: canary, event: canary.repeat(10)
  });
  assert.ok(received.some((entry) => entry.outcome === 'sink_error'));
  assert.doesNotMatch(JSON.stringify(received), new RegExp(canary));
  assert.ok(received.every((entry) => !('args' in entry) && !('result' in entry) && !('message' in entry)));
});

test('typed bridge errors preserve only bounded public metadata', () => {
  const error = new SuperSDKError('BRIDGE_ERROR', {
    nativeCode: 'UNKNOWN', reasonCode: 'CALLBACK_HUB_REPLACED',
    details: { api: 'readFile', retry: false, unsafe_value: { token: 'secret' } },
    cause: new Error('private message')
  });
  assert.equal(error.nativeCode, 'UNKNOWN');
  assert.equal(error.reasonCode, 'CALLBACK_HUB_REPLACED');
  assert.deepEqual(error.details, { api: 'readFile', retry: false });
  assert.deepEqual(error.cause, { name: 'Error' });
  assert.doesNotMatch(JSON.stringify(error), /private message|secret/);
});

// The inventory is private to the monorepo. The public export (marked by PUBLIC_PROVENANCE.json) does not carry it.
const publicExport = existsSync(resolve(import.meta.dirname, '..', 'PUBLIC_PROVENANCE.json'));

test('private sink inventory covers the exact 63 native members and all owned sinks', { skip: publicExport && 'private inventory is not part of the public tree' }, async () => {
  const root = resolve(import.meta.dirname, '..');
  const inventory = JSON.parse(await readFile(resolve(root, 'private-contract/bridge-log-inventory.json'), 'utf8'));
  assert.deepEqual([...inventory.nativeMembers].sort(), BRIDGE_PROTOCOL.methods.map((method) => method.nativeName).sort());
  const text = JSON.stringify(inventory);
  for (const sink of ['diagnosticSink', 'Logcat', 'custom handler', 'WebChromeClient', 'SLogger console', 'SLogger file', 'customHandler', 'WebConsole']) {
    assert.ok(text.includes(sink), `inventory missing ${sink}`);
  }
});
