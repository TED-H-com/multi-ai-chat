import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const identity = { name: 'publishers/publisher/items/extension', itemId: 'extension' };
const published = {
  ...identity,
  publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '0.3.0' }] },
};
const uploaded = { ...identity, uploadState: 'SUCCEEDED', crxVersion: '0.4.1' };
const submitted = { ...identity, state: 'PENDING_REVIEW' };

// Run the real CLI with a fake HTTP boundary. No network or Google credentials.
function run(responses: unknown[], options: { mode?: string; preflight?: boolean; version?: string; exitCodes?: number[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cws-test-'));
  try {
    writeFileSync(join(dir, 'responses.json'), JSON.stringify(responses));
    writeFileSync(join(dir, 'exit-codes.json'), JSON.stringify(options.exitCodes ?? []));
    writeFileSync(join(dir, 'calls.json'), '[]');
    writeFileSync(join(dir, 'output'), '');
    writeFileSync(join(dir, 'archive.zip'), 'test archive bytes');
    writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(dir, 'curl'), `#!/usr/bin/env node
const fs = require('node:fs');
const dir = process.env.CWS_TEST_DIR;
const args = process.argv.slice(2);
const calls = JSON.parse(fs.readFileSync(dir + '/calls.json', 'utf8'));
const index = calls.length;
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
calls.push({ method: value('--request') || 'GET', url: args.at(-1), data: value('--data'),
  archive: value('--data-binary') ? fs.readFileSync(value('--data-binary').slice(1), 'utf8') : undefined,
  retry: value('--retry') });
fs.writeFileSync(dir + '/calls.json', JSON.stringify(calls));
const responses = JSON.parse(fs.readFileSync(dir + '/responses.json', 'utf8'));
if (index >= responses.length) { process.stderr.write('Unexpected HTTP request'); process.exit(99); }
process.stdout.write(JSON.stringify(responses[index]));
process.exit(JSON.parse(fs.readFileSync(dir + '/exit-codes.json', 'utf8'))[index] || 0);
`, { mode: 0o755 });
    const result = spawnSync('bash', [resolve('scripts/chrome-web-store.sh'), ...(options.preflight ? ['--preflight'] : [])], {
      encoding: 'utf8', timeout: 20_000,
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, CWS_TEST_DIR: dir,
        ACCESS_TOKEN: 'test-token', CWS_PUBLISHER_ID: 'publisher', CWS_EXTENSION_ID: 'extension',
        PUBLISH_MODE: options.mode ?? 'automatic', EXPECTED_VERSION: options.version ?? '0.4.1',
        ARCHIVE: join(dir, 'archive.zip'), GITHUB_OUTPUT: join(dir, 'output'),
      },
    });
    assert.ifError(result.error);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('test-token'), 'Credentials must not be logged');
    return {
      ...result,
      calls: JSON.parse(readFileSync(join(dir, 'calls.json'), 'utf8')),
      output: Object.fromEntries(readFileSync(join(dir, 'output'), 'utf8').trim().split('\n').filter(Boolean).map((line) => line.split('='))),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('status-only and preflight perform one read without uploading', () => {
  for (const options of [{ mode: 'status-only' }, { preflight: true }]) {
    const result = run([published], options);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.upload_state, 'not-run');
    assert.equal(result.output.publish_state, 'PUBLISHED');
    assert.deepEqual(result.calls.map((call: any) => call.method), ['GET']);
  }
});

test('status-only supports an item with no published or submitted revision', () => {
  const result = run([identity], { mode: 'status-only', version: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.publish_state, 'not-submitted');
});

for (const state of ['PENDING_REVIEW', 'STAGED']) {
  test(`preflight refuses to replace a ${state} submission`, () => {
    const result = run([{ ...published, submittedItemRevisionStatus: { state } }], { preflight: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to replace/);
    assert.equal(result.calls.length, 1);
  });
}

test('preflight refuses to replace an upload still processing', () => {
  const result = run([{ ...published, lastAsyncUploadState: 'IN_PROGRESS' }], { preflight: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /still processing/);
  assert.equal(result.calls.length, 1);
});

for (const flag of ['warned', 'takenDown']) {
  test(`${flag} blocks submission but allows a remediation upload`, () => {
    const status = { ...published, [flag]: true };
    const blocked = run([status], { preflight: true });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /policy warning/);
    const remediation = run([status, uploaded], { mode: 'upload-only' });
    assert.equal(remediation.status, 0, remediation.stderr);
    assert.equal(remediation.output.publish_state, 'not-submitted');
    assert.equal(remediation.calls.length, 2);
  });
}

for (const version of ['0.3.0', '0.3.0.0', '0.2.9', '1.2.bad', '1.2.3.4.5', '65536.0', '0']) {
  test(`invalid or non-increasing version ${version} cannot upload`, () => {
    const result = run([published], { version });
    assert.notEqual(result.status, 0);
    assert.ok(result.calls.every((call: any) => call.method === 'GET'));
  });
}

test('preflight compares numeric version components', () => {
  const result = run([{ ...published, publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '0.9.0' }] } }], { version: '0.10.0', preflight: true });
  assert.equal(result.status, 0, result.stderr);
});

test('missing item identity or unknown revision state cannot pass preflight', () => {
  for (const status of [{}, { ...published, itemId: 'wrong' }, { ...published, publishedItemRevisionStatus: { state: 'NEW_STATE' } }]) {
    const result = run([status], { preflight: true });
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.length, 1);
  }
});

test('HTTP errors preserve API diagnostics and stop before mutations', () => {
  const result = run([{ error: { message: 'Publisher access denied' } }], { exitCodes: [22] });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Publisher access denied/);
  assert.equal(result.calls.length, 1);
});

for (const [mode, publishType] of [['automatic', 'DEFAULT_PUBLISH'], ['staged', 'STAGED_PUBLISH']]) {
  test(`${mode} uploads the archive then submits with warnings blocked`, () => {
    const result = run([published, uploaded, submitted], { mode });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.upload_state, 'SUCCEEDED');
    assert.equal(result.output.publish_state, 'PENDING_REVIEW');
    assert.deepEqual(result.calls.map((call: any) => [call.method, call.url]), [
      ['GET', `https://chromewebstore.googleapis.com/v2/${identity.name}:fetchStatus`],
      ['POST', `https://chromewebstore.googleapis.com/upload/v2/${identity.name}:upload`],
      ['POST', `https://chromewebstore.googleapis.com/v2/${identity.name}:publish`],
    ]);
    assert.equal(result.calls[1].archive, 'test archive bytes');
    assert.deepEqual(JSON.parse(result.calls[2].data), { publishType, blockOnWarnings: true });
    assert.ok(result.calls.slice(1).every((call: any) => !call.retry), 'Mutation requests must not retry');
  });
}

test('async upload is polled to completion before submission', () => {
  const result = run([published, { ...identity, uploadState: 'IN_PROGRESS' }, { ...published, lastAsyncUploadState: 'IN_PROGRESS' }, { ...published, lastAsyncUploadState: 'SUCCEEDED' }, submitted]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map((call: any) => call.method), ['GET', 'POST', 'GET', 'GET', 'POST']);
});

test('failed, mismatched, and unknown uploads never submit', () => {
  for (const upload of [{ ...uploaded, uploadState: 'FAILED' }, { ...uploaded, crxVersion: '0.4.0' }, { ...identity, uploadState: 'SUCCEEDED' }, { ...uploaded, uploadState: 'UNKNOWN' }]) {
    const result = run([published, upload]);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.length, 2);
    assert.notEqual(result.output.upload_state, 'SUCCEEDED');
  }
});

test('async upload timeout never submits', () => {
  const result = run([published, { ...identity, uploadState: 'IN_PROGRESS' }, ...Array(30).fill({ ...published, lastAsyncUploadState: 'IN_PROGRESS' })]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /upload did not succeed/);
  assert.equal(result.calls.length, 32);
});

test('failed or unknown submission cannot report success', () => {
  for (const response of [identity, { ...identity, state: 'REJECTED' }, { ...identity, state: 'UNKNOWN' }]) {
    const result = run([published, uploaded, response]);
    assert.notEqual(result.status, 0);
    assert.equal(result.output.upload_state, 'SUCCEEDED');
    assert.equal(result.output.publish_state, 'not-confirmed');
  }
});

test('failed POST is not repeated and reports the uncertain result', () => {
  const result = run([published, uploaded, { error: { message: 'Submission timed out' } }], { exitCodes: [0, 0, 22] });
  assert.notEqual(result.status, 0);
  assert.equal(result.calls.length, 3);
  assert.equal(result.output.publish_state, 'not-confirmed');
  assert.match(result.stderr, /Submission timed out/);
});
