import { hostname } from 'node:os';
import { paneDelivery } from './src/herdr.mjs';
import { startReceiver } from './src/server.mjs';
import { helperLink } from './src/handoff.mjs';

try {
  const target = JSON.parse(process.env.FILE_UPLOAD_TARGET || 'null');
  if (!target?.paneID || !target?.terminalID) throw new Error('Launch the “Attach files to this pane” action from your target pane.');
  const receiver = await startReceiver({
    target: { paneID: target.paneID, host: hostname() },
    stateDir: process.env.HERDR_PLUGIN_STATE_DIR,
    deliver: paneDelivery(target),
    onActivity: (message) => console.log(message),
  });
  console.log(`\nFile Upload → ${target.paneID} on ${hostname()}\n`);
  const helper = helperLink({ host: hostname(), paneID: target.paneID, port: receiver.port, token: receiver.token });
  console.log('Kitty on your local computer: Ctrl+Shift+click this link, then drop files:');
  console.log(`\n\x1b]8;;${helper}\x1b\\Open local file helper\x1b]8;;\x1b\\\n`);
  console.log('Requires the local Kitty open-actions.conf entry from the plugin README.');
  console.log(`Helper link (for copying):\n${helper}\n`);
  console.log(`Browser upload fallback:\n\n${receiver.url}\n`);
  console.log('If this pane is remote, run this on your laptop first:');
  console.log(`\n  ssh -N -L ${receiver.port}:127.0.0.1:${receiver.port} <your-ssh-host>\n`);
  console.log('Replace <your-ssh-host> with the SSH alias for this machine.');
  console.log('Then open the link above on your laptop. Keep the tunnel running.\n');
  console.log('Drop files in the browser, then choose “Insert paths”.');
  console.log('Files stay on this machine; input goes only to the original pane.');
  console.log(`Saved files: ${receiver.directory}`);
  console.log('\nThis window expires in 30 minutes. Press Ctrl+C to stop it.\n');
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => void receiver.close());
  }
} catch (error) {
  console.error(`File Upload: ${error.message}`);
  process.exitCode = 1;
}
