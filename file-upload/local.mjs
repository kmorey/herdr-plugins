import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { automaticUpload } from './src/automatic-upload.mjs';
import { browserLink, parseHandoff } from './src/handoff.mjs';
import { localConnection, machineCandidates, savedMachines, sshConnection } from './src/local-connection.mjs';
import { parsePaths, readDroppedPaths } from './src/local-paths.mjs';

const exec = promisify(execFile);
let connection;
let expiry;
let pendingTunnel;
let stopping = false;
const shutdown = new AbortController();

async function connectSSH(handoff, target) {
  pendingTunnel = sshConnection(handoff, target, shutdown.signal);
  try { return await pendingTunnel; } finally { pendingTunnel = undefined; }
}

async function question(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.once('SIGINT', () => void stop());
  try { return await rl.question(prompt, { signal: shutdown.signal }); } finally { rl.close(); }
}

async function openBrowser(url) {
  if (stopping) return;
  console.log('Opening the browser uploader for this same destination…');
  try {
    await exec(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { timeout: 5000 });
  } catch {
    console.log(`The browser could not be opened automatically. Open this link:\n${url}`);
  }
}

async function connect(handoff, machineID) {
  if (!machineID) {
    const local = await localConnection(handoff);
    if (local) return local;
  }
  const profiles = await savedMachines();
  const candidates = machineID
    ? profiles.filter((profile) => profile.id === machineID)
    : machineCandidates(profiles, handoff.host);
  if (machineID && !candidates.length) throw new Error('That saved Herdr machine is missing or disabled.');
  for (const profile of candidates) {
    console.log(`Connecting through ${profile.label} (${profile.target})…`);
    try { return await connectSSH(handoff, profile.target); } catch (error) {
      if (machineID || shutdown.signal.aborted) throw error;
      console.log(`Connection failed: ${error.message}`);
    }
  }
  if (!profiles.length) throw new Error('No enabled SSH machines are saved in local Herdr.');
  console.log('\nChoose the saved machine hosting the upload pane:');
  profiles.forEach((profile, index) => console.log(`  ${index + 1}. ${profile.label} — ${profile.target} (${profile.session})`));
  const answer = await question('Machine number (Enter to cancel): ');
  if (!answer.trim()) return null;
  const profile = profiles[Number(answer) - 1];
  if (!/^\d+$/u.test(answer) || !profile) throw new Error('Invalid machine number.');
  return connectSSH(handoff, profile.target);
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  shutdown.abort();
  clearTimeout(expiry);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write('\x1b[?2004l');
  const pending = await pendingTunnel?.catch(() => null);
  await pending?.close();
  await connection?.close();
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => void stop());

try {
  const [link, ...args] = process.argv.slice(2);
  if (!link || link === '--help') {
    console.log('Usage: node local.mjs <herdr-upload://link> [--machine PROFILE_ID] [-- /local/file ...]');
    console.log('Run on your local computer, preferably through the Kitty helper link in the Herdr upload pane.');
  } else {
    const handoff = parseHandoff(link);
    let machineID;
    if (args[0] === '--machine') {
      args.shift();
      machineID = args.shift();
      if (!machineID) throw new Error('--machine requires a saved Herdr profile ID.');
    }
    if (args.length && args.shift() !== '--') throw new Error('Pass local files after --.');
    console.log(`\nLocal File Upload → ${handoff.paneID} on ${handoff.host}\n`);
    connection = await connect(handoff, machineID);
    if (connection) {
      expiry = setTimeout(() => {
        console.log('\nUpload window expired. Closing the local tunnel.');
        void stop();
      }, Math.max(1, connection.session.expiresAt - Date.now()));
      console.log('Connected to the pinned upload window.');
      console.log('Drop files here to upload and insert their paths automatically.');
      console.log('Or type quoted absolute paths and press Enter. b: browser · q: cancel\n');
      let paths;
      let fallback = false;
      try {
        const text = args.length ? undefined : await readDroppedPaths();
        if (args.length) paths = args;
        else if (text !== null) {
          if (!text) fallback = true;
          else paths = parsePaths(text);
        }
      } catch (error) {
        console.log(`Automatic upload unavailable: ${error.message}`);
        fallback = true;
      }
      if (fallback) {
        await openBrowser(browserLink(connection.origin, connection.token, true));
      } else if (paths) {
        const result = await automaticUpload({ connection, paths, openBrowser, onProgress: console.log });
        fallback = result.mode === 'browser';
        if (fallback) console.log(`Automatic upload stopped: ${result.error}`);
        else {
          console.log(`\nInserted ${result.files.length} path(s) into ${handoff.paneID}. Enter was not sent.`);
          result.files.forEach((file) => console.log(file.path));
        }
      }
      if (fallback) {
        console.log('\nKeep this helper open while using the browser; it owns the SSH tunnel.');
        await question('Press Enter after you finish in the browser to close the tunnel. ');
      } else if (paths) {
        await question('\nPress Enter to close the helper and return to Herdr. ');
      }
    }
  }
} catch (error) {
  await connection?.close();
  if (!shutdown.signal.aborted) {
    console.error(`\nFile Upload: ${error.message}`);
    console.error('If SSH cannot reach the receiver, the browser cannot reach it either.');
    console.error('Use the browser link and manual SSH tunnel command in the Herdr upload pane.');
    process.exitCode = 1;
    if (process.stdin.isTTY) await question('\nPress Enter to close. ').catch(() => {});
  }
} finally {
  clearTimeout(expiry);
  await connection?.close();
}
