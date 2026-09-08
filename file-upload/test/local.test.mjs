import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { automaticUpload } from '../src/automatic-upload.mjs';
import { browserLink, helperLink, parseHandoff, receiverRequest, verifyReceiver } from '../src/handoff.mjs';
import { localConnection, machineCandidates } from '../src/local-connection.mjs';
import { parsePaths, readDroppedPaths } from '../src/local-paths.mjs';
import { startReceiver } from '../src/server.mjs';

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'herdr-local-upload-'));
  const deliveries = [];
  const browserURLs = [];
  const target = { host: hostname(), paneID: 'w2:p3' };
  const receiver = await startReceiver({
    stateDir: directory, target, deliver: async (paths) => deliveries.push(paths), ...options,
  });
  const handoff = parseHandoff(helperLink({ ...target, ...receiver }));
  const connection = await localConnection(handoff);
  t.after(async () => {
    await receiver.close();
    await rm(directory, { recursive: true, force: true });
  });
  const run = (paths) => automaticUpload({ connection, paths, openBrowser: async (url) => browserURLs.push(url) });
  return { directory, receiver, connection, handoff, deliveries, browserURLs, run };
}

test('helper handoffs roundtrip and reject malformed destinations', () => {
  const original = { host: 'build-host', paneID: 'w12:p34', port: 54321, token: 'a'.repeat(64) };
  assert.deepEqual(parseHandoff(helperLink(original)), original);
  for (const value of [
    'https://host:12/#' + original.token,
    helperLink(original).replace('build-host', 'user@build-host'),
    helperLink(original).replace('54321', '0'),
    helperLink(original).replace('/?', '/other?'),
    helperLink(original).replace(original.token, 'bad'),
    helperLink(original).replace('w12%3Ap34', 'bad%0Avalue'),
  ]) assert.throws(() => parseHandoff(value));
});

test('dropped paths support shell quoting and file URIs without evaluating shell syntax', () => {
  assert.deepEqual(parsePaths("'/home/me/a b.png' /home/me/c\\ d.txt \"/tmp/it\\\"s.txt\""), [
    '/home/me/a b.png', '/home/me/c d.txt', '/tmp/it"s.txt',
  ]);
  assert.deepEqual(parsePaths("'/tmp/it'\\''s.txt'"), ["/tmp/it's.txt"]);
  assert.deepEqual(parsePaths('file:///tmp/a%20b.txt\nfile://localhost/tmp/c.txt'), ['/tmp/a b.txt', '/tmp/c.txt']);
  assert.deepEqual(parsePaths("'/tmp/$(touch owned).txt'"), ['/tmp/$(touch owned).txt']);
  for (const value of ["'/tmp/incomplete", '/tmp/a\\', 'relative.txt', 'file://other-host/tmp/file', '/tmp/\x1b[201~bad']) {
    assert.throws(() => parsePaths(value));
  }
});

test('split bracketed-paste sequences trigger a drop without Enter and restore terminal mode', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (raw) => { input.isRaw = raw; };
  const output = new PassThrough();
  let written = '';
  output.on('data', (data) => { written += data; });
  const drop = readDroppedPaths(input, output);
  for (const chunk of ['\x1b[2', '00~', "'/tmp/", '💚 file', ".txt'", '\x1b[20', '1~']) input.write(chunk);
  assert.equal(await drop, "'/tmp/💚 file.txt'");
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount('data'), 0);
  assert.ok(written.endsWith('\x1b[?2004l\n'));
});

test('local file bytes go to the pinned receiver and only new uploads are inserted', async (t) => {
  const { directory, connection, deliveries, browserURLs, run } = await setup(t);
  const previous = await receiverRequest(connection, '/api/files?name=earlier.txt', { method: 'POST', body: 'earlier' });
  const first = join(directory, "it's a screenshot.png");
  const empty = join(directory, 'empty.txt');
  const bytes = Buffer.from([0, 1, 127, 128, 255, 13, 10]);
  await writeFile(first, bytes);
  await writeFile(empty, '');
  const result = await run([first, empty]);
  assert.equal(result.mode, 'inserted');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].includes(previous.path), false);
  assert.deepEqual(await readFile(deliveries[0][0]), bytes);
  assert.equal((await readFile(deliveries[0][1])).length, 0);
  assert.deepEqual(browserURLs, []);
});

test('an unreadable selection opens the browser on the same window before uploading any files', async (t) => {
  const { directory, connection, deliveries, browserURLs, run } = await setup(t);
  const exists = join(directory, 'exists.txt');
  await writeFile(exists, 'exists');
  const result = await run([exists, join(directory, 'does-not-exist.txt')]);
  assert.equal(result.mode, 'browser');
  assert.equal(browserURLs[0], browserLink(connection.origin, connection.token, true));
  assert.deepEqual((await receiverRequest(connection, '/api/session')).files, []);
  assert.deepEqual(deliveries, []);
});

test('partial transfer failure preserves completed uploads for the browser without inserting', async (t) => {
  let second;
  const { directory, connection, deliveries, browserURLs, run } = await setup(t, {
    onActivity: (message) => {
      // Model a source file changing between preflight and streaming.
      if (message.startsWith('Uploaded first')) writeFileSync(second, '');
    },
  });
  const first = join(directory, 'first.txt');
  second = join(directory, 'second.txt');
  await writeFile(first, 'first bytes');
  await writeFile(second, 'second bytes');
  const result = await run([first, second]);
  assert.equal(result.mode, 'browser');
  assert.equal(browserURLs.length, 1);
  const { files } = await receiverRequest(connection, '/api/session');
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'first.txt');
  assert.equal(files[0].delivery, 'pending');
  assert.deepEqual(deliveries, []);
});

test('uncertain insertion opens browser with attempted state and never replays delivery', async (t) => {
  let attempts = 0;
  const { directory, connection, run } = await setup(t, { deliver: async () => { attempts++; throw new Error('CLI timeout'); } });
  const path = join(directory, 'file.txt');
  await writeFile(path, 'hello');
  assert.equal((await run([path])).mode, 'browser');
  const { files } = await receiverRequest(connection, '/api/session');
  assert.equal(files[0].delivery, 'attempted');
  await assert.rejects(() => receiverRequest(connection, '/api/insert', {
    method: 'POST', body: JSON.stringify({ ids: [files[0].id] }),
  }), /already been sent or attempted/);
  assert.equal(attempts, 1);
});

test('saved-machine selection is a hint; incorrect receiver identities and keys are rejected', async (t) => {
  const { connection, handoff } = await setup(t);
  const profiles = [
    { id: 'one', target: 'other-host', selected: true },
    { id: 'two', target: 'me@build-host' },
    { id: 'three', target: 'ssh://me@build-host:2222' },
  ];
  assert.deepEqual(machineCandidates(profiles, 'build-host').map((profile) => profile.id), ['two', 'three', 'one']);
  await assert.rejects(() => verifyReceiver(connection, { ...handoff, paneID: 'w9:p9' }), /does not match/);
  await assert.rejects(() => verifyReceiver(connection, { ...handoff, host: 'other' }), /does not match/);
  await assert.rejects(() => verifyReceiver({ ...connection, token: 'wrong' }, handoff), /access key/);
});

test('an explicitly requested SSH route fails without selecting a different saved machine', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'herdr-upload-route-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'bin'));
  const profiles = [{ id: 'forced', target: 'forced-host', enabled: true, label: 'Forced' },
    { id: 'other', target: 'other-host', enabled: true, label: 'Other', selected: true }];
  await writeFile(join(directory, 'bin', 'herdr'), `#!/bin/sh\nprintf '%s' '${JSON.stringify(profiles)}'\n`, { mode: 0o700 });
  await writeFile(join(directory, 'bin', 'ssh'), '#!/bin/sh\necho "SSH route unavailable" >&2\nexit 255\n', { mode: 0o700 });
  const link = helperLink({ host: 'remote-host', paneID: 'w1:p1', port: 34567, token: 'a'.repeat(64) });
  await assert.rejects(() => promisify(execFile)(process.execPath, [fileURLToPath(new URL('../local.mjs', import.meta.url)), link, '--machine', 'forced'], {
    env: { ...process.env, PATH: `${directory}/bin:${process.env.PATH}` }, timeout: 5000,
  }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /SSH route unavailable/);
    assert.doesNotMatch(error.stdout, /Choose the saved machine|Machine number/);
    return true;
  });
});
