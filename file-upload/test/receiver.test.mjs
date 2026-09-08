import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startReceiver } from '../src/server.mjs';
import { captureTarget, paneDelivery, quotePath } from '../src/herdr.mjs';

async function setup(t, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'herdr-upload-test-'));
  const deliveries = [];
  const receiver = await startReceiver({
    stateDir,
    target: { paneID: 'w1:p2', host: 'test-host' },
    deliver: async (paths) => deliveries.push(paths),
    ...options,
  });
  t.after(async () => {
    await receiver.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const api = async (path, options = {}) => {
    const response = await fetch(receiver.origin + path, {
      ...options, headers: { Authorization: `Bearer ${receiver.token}`, ...options.headers },
    });
    return { status: response.status, body: await response.json() };
  };
  const upload = (name, body = 'hello') => api(`/api/files?name=${encodeURIComponent(name)}`, { method: 'POST', body });
  const insert = (ids) => api('/api/insert', { method: 'POST', body: JSON.stringify({ ids }) });
  return { receiver, deliveries, api, upload, insert };
}

test('binary uploads survive receiver shutdown and insert only selected destination paths once', async (t) => {
  const { receiver, upload, insert, deliveries } = await setup(t);
  const bytes = Buffer.from([0, 255, 128, 10, 13, 42]);
  const first = await upload('screen shot.png', bytes);
  const second = await upload('screen shot.png', 'different');
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.body.path, second.body.path);
  assert.deepEqual(await readFile(first.body.path), bytes);
  assert.equal((await stat(first.body.path)).mode & 0o777, 0o600);
  assert.equal((await stat(receiver.directory)).mode & 0o777, 0o700);
  assert.equal((await insert([second.body.id, first.body.id])).status, 200);
  assert.deepEqual(deliveries, [[second.body.path, first.body.path]]);
  assert.equal((await insert([first.body.id])).status, 409);
  await receiver.close();
  assert.deepEqual(await readFile(first.body.path), bytes);
});

test('API requires the window key; UI exposes no destination or key without it', async (t) => {
  const { receiver, api } = await setup(t);
  const page = await fetch(receiver.origin);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(!html.includes(receiver.token));
  assert.ok(!html.includes('w1:p2'));
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const anonymous = await fetch(`${receiver.origin}/api/session`);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('access-control-allow-origin'), null);
  assert.equal((await api('/api/session', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await api('/api/session')).body.target.paneID, 'w1:p2');
});

test('filenames cannot traverse directories, emit control sequences, or exceed filesystem byte limits', async (t) => {
  const { receiver, upload } = await setup(t);
  for (const name of ['../../outside.txt', 'C:\\Users\\test\\x.txt', '\x1b[200~bad\nname', '💚'.repeat(200)]) {
    const { status, body } = await upload(name);
    assert.equal(status, 201);
    assert.ok(body.path.startsWith(`${receiver.directory}/`));
    assert.ok(!/[\x00-\x1f\x7f-\x9f]/u.test(body.name));
    assert.ok(Buffer.byteLength(body.name) <= 160);
  }
  assert.equal((await readdir(receiver.directory)).length, 4);
});

test('file, aggregate, and count limits reject without saving partial files', async (t) => {
  const { receiver, upload } = await setup(t, { maxFileBytes: 5, maxTotalBytes: 8, maxFiles: 2 });
  assert.equal((await upload('too-big', '123456')).status, 413);
  assert.deepEqual(await readdir(receiver.directory), []);
  assert.equal((await upload('one', '12345')).status, 201);
  assert.equal((await upload('over-total', '1234')).status, 413);
  assert.equal((await upload('two', '123')).status, 201);
  assert.equal((await upload('three', '')).status, 413);
  assert.equal((await readdir(receiver.directory)).length, 2);
});

test('chunked requests cannot bypass the upload limit', async (t) => {
  const { receiver } = await setup(t, { maxFileBytes: 5 });
  const response = await new Promise((resolve, reject) => {
    const req = request(`${receiver.origin}/api/files?name=chunked.bin`, {
      method: 'POST', headers: { Authorization: `Bearer ${receiver.token}` },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write('123');
    req.end('456');
  });
  assert.equal(response, 413);
  assert.deepEqual(await readdir(receiver.directory), []);
});

test('invalid IDs and repeated IDs cannot deliver arbitrary paths', async (t) => {
  const { upload, insert, deliveries, api } = await setup(t);
  const { body: file } = await upload('readme.txt');
  for (const ids of [[], ['/etc/passwd'], [file.id, file.id], [null]]) {
    assert.equal((await insert(ids)).status, 400);
  }
  assert.equal((await api('/api/insert', { method: 'POST', body: 'null' })).status, 400);
  assert.equal((await api('/api/insert', { method: 'POST', body: '{' })).status, 400);
  assert.deepEqual(deliveries, []);
});

test('uncertain delivery is never automatically repeated and saved files remain retrievable', async (t) => {
  let calls = 0;
  const { upload, insert, api } = await setup(t, { deliver: async () => { calls++; throw new Error('CLI timeout'); } });
  const { body: file } = await upload('report.txt');
  assert.equal((await insert([file.id])).status, 502);
  assert.equal((await insert([file.id])).status, 409);
  assert.equal(calls, 1);
  assert.equal((await api('/api/session')).body.files[0].delivery, 'attempted');
  assert.equal(await readFile(file.path, 'utf8'), 'hello');
});

test('concurrent insertion is serialized', async (t) => {
  let finish;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const { upload, insert } = await setup(t, { deliver: () => {
    started();
    return new Promise((resolve) => { finish = resolve; });
  } });
  const { body: file } = await upload('report.txt');
  const first = insert([file.id]);
  await waiting;
  assert.equal((await insert([file.id])).status, 409);
  finish();
  assert.equal((await first).status, 200);
});

test('pane delivery pins identity and never sends Enter or follows focus', async () => {
  const calls = [];
  const pane = { terminal_id: 'term-original', agent: 'opencode', agent_session: { value: 'session-original' } };
  const run = async (args) => { calls.push(args); return { pane }; };
  const target = await captureTarget('w1:p2', run);
  const deliver = paneDelivery(target, run);
  await deliver(["/uploads/it's here.png", '/uploads/$(touch nope).txt']);
  assert.deepEqual(calls.at(-1), ['pane', 'send-text', 'w1:p2', " '/uploads/it'\\''s here.png' '/uploads/$(touch nope).txt' "]);
  pane.agent_session = { value: 'new-session' };
  await assert.rejects(() => deliver(['/uploads/a']), /occupant changed/);
  assert.equal(calls.filter((args) => args[1] === 'send-text').length, 1);
  assert.throws(() => quotePath('/bad\npath'), /control characters/);
});
