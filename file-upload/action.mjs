import { captureTarget, herdr } from './src/herdr.mjs';

try {
  const target = await captureTarget(process.env.HERDR_PANE_ID);
  await herdr([
    'plugin', 'pane', 'open',
    '--plugin', 'kmorey.file-upload',
    '--entrypoint', 'receiver',
    '--placement', 'split',
    '--target-pane', target.paneID,
    '--env', `FILE_UPLOAD_TARGET=${JSON.stringify(target)}`,
    '--no-focus',
  ]);
} catch (error) {
  console.error(`File Upload: ${error.message}`);
  process.exitCode = 1;
}
