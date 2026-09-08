import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyReceiver } from './handoff.mjs';

const exec = promisify(execFile);

export async function savedMachines() {
  const { stdout } = await exec('herdr', ['machine', 'list', '--json'], { timeout: 5000, maxBuffer: 128 * 1024 });
  const profiles = JSON.parse(stdout);
  if (!Array.isArray(profiles)) throw new Error('Herdr did not return a saved-machine list.');
  return profiles.filter((profile) => profile.enabled && typeof profile.target === 'string');
}

export function machineCandidates(profiles, host) {
  const matches = profiles.filter((profile) => {
    let targetHost = profile.target.split('@').at(-1);
    if (profile.target.startsWith('ssh://')) {
      try { targetHost = new URL(profile.target).hostname; } catch { return false; }
    }
    return targetHost.toLowerCase() === host.toLowerCase();
  });
  // Selection is only a connection hint, never authority to choose a pane.
  return [...new Set([...matches, ...profiles.filter((profile) => profile.selected)])];
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export async function sshConnection(handoff, sshTarget, signal) {
  signal?.throwIfAborted();
  if (!sshTarget || sshTarget.startsWith('-') || /[\x00-\x20\x7f]/u.test(sshTarget)) {
    throw new Error('Invalid SSH target. Choose a saved Herdr machine.');
  }
  const port = await unusedPort();
  signal?.throwIfAborted();
  const child = spawn('ssh', [
    '-T', '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ForkAfterAuthentication=no', '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
    '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-L', `127.0.0.1:${port}:127.0.0.1:${handoff.port}`, sshTarget,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let failure;
  let stderr = '';
  let exited = false;
  const onAbort = () => { failure = 'Connection cancelled.'; child.kill('SIGTERM'); };
  signal?.addEventListener('abort', onAbort, { once: true });
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4096); });
  const closed = new Promise((resolve) => {
    child.once('error', (error) => { failure = error.message; });
    child.once('close', (code) => {
      exited = true;
      failure ||= stderr.trim() || `SSH exited (${code}).`;
      resolve();
    });
  });
  let closePromise;
  const connection = {
    origin: `http://127.0.0.1:${port}`,
    token: handoff.token,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        signal?.removeEventListener('abort', onAbort);
        if (!exited) child.kill('SIGTERM');
        const kill = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 1000);
        await closed;
        clearTimeout(kill);
      })();
      return closePromise;
    },
  };
  try {
    const deadline = Date.now() + 12_000;
    let error;
    while (!failure && Date.now() < deadline) {
      try {
        connection.session = await verifyReceiver(connection, handoff);
        signal?.throwIfAborted();
        return connection;
      } catch (cause) {
        error = cause;
        await delay(150, undefined, { signal });
      }
    }
    throw new Error(failure || error?.message || 'Could not reach the upload receiver over SSH.');
  } catch (error) {
    await connection.close();
    throw error;
  }
}

export async function localConnection(handoff) {
  if (handoff.host.toLowerCase() !== hostname().toLowerCase()) return null;
  const connection = { origin: `http://127.0.0.1:${handoff.port}`, token: handoff.token, close: async () => {} };
  try {
    connection.session = await verifyReceiver(connection, handoff);
    return connection;
  } catch {
    return null;
  }
}
