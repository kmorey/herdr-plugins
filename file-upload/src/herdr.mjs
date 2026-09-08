import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function herdr(args) {
  const { stdout } = await exec(process.env.HERDR_BIN_PATH || 'herdr', args, {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  // Mutating CLI commands such as pane send-text succeed with empty stdout.
  if (!stdout.trim()) return;
  const response = JSON.parse(stdout);
  if (response.error) throw new Error(response.error.message);
  return response.result;
}

export async function captureTarget(paneID, run = herdr) {
  if (!paneID) throw new Error('Open File Upload from the pane you want to attach files to.');
  const { pane } = await run(['pane', 'get', paneID]);
  if (!pane?.terminal_id) throw new Error('Herdr did not return a terminal identity for the target pane.');
  return {
    paneID,
    terminalID: pane.terminal_id,
    agentSession: pane.agent_session ?? null,
    agent: pane.agent ?? null,
  };
}

// POSIX quoting also prevents filenames from introducing terminal control input.
export function quotePath(path) {
  if (/[\x00-\x1f\x7f-\x9f]/u.test(path)) throw new Error('Upload path contains control characters.');
  return `'${path.replaceAll("'", "'\\''")}'`;
}

export function paneDelivery(target, run = herdr) {
  return async (paths) => {
    const current = await captureTarget(target.paneID, run);
    if (current.terminalID !== target.terminalID ||
        JSON.stringify(current.agentSession) !== JSON.stringify(target.agentSession) ||
        current.agent !== target.agent) {
      throw new Error('The target pane occupant changed. Open a new upload window from the intended pane.');
    }
    await run(['pane', 'send-text', target.paneID, ` ${paths.map(quotePath).join(' ')} `]);
  };
}
