import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { browserLink, receiverRequest } from './handoff.mjs';

export async function uploadLocalFiles(connection, paths, onProgress = () => {}) {
  const session = await receiverRequest(connection, '/api/session');
  const handles = [];
  try {
    if (!paths.length || paths.length + session.files.length > session.maxFiles) {
      throw new Error(`This upload window accepts up to ${session.maxFiles} files.`);
    }
    let total = session.files.reduce((sum, file) => sum + file.size, 0);
    // Validate the entire selection before transferring any bytes. O_NONBLOCK
    // avoids hanging on named pipes before fstat can reject them.
    for (const path of paths) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      handles.push({ handle, path });
      const info = await handle.stat();
      if (!info.isFile()) throw new Error(`${basename(path)} is not a regular file.`);
      if (info.size > session.maxFileBytes) throw new Error(`${basename(path)} exceeds the per-file upload limit.`);
      total += info.size;
      if (total > session.maxTotalBytes) throw new Error('The selection exceeds the remaining upload limit.');
      handles.at(-1).size = info.size;
    }
    const uploaded = [];
    for (const { handle, path, size } of handles) {
      onProgress(`Uploading ${basename(path)}…`);
      const stream = size ? handle.createReadStream({ autoClose: false, start: 0, end: size - 1 }) : undefined;
      try {
        uploaded.push(await receiverRequest(connection, `/api/files?name=${encodeURIComponent(basename(path))}`, {
          method: 'POST',
          body: stream ?? Buffer.alloc(0),
          duplex: 'half',
          headers: { 'Content-Length': String(size), 'Content-Type': 'application/octet-stream' },
        }));
      } finally {
        stream?.destroy();
      }
    }
    onProgress('Inserting destination paths into the pinned pane…');
    // The receiver marks attempts before calling Herdr, so a lost response
    // cannot cause the browser fallback to replay an uncertain insertion.
    return await receiverRequest(connection, '/api/insert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: uploaded.map((file) => file.id) }),
    });
  } finally {
    await Promise.all(handles.map(({ handle }) => handle.close().catch(() => {})));
  }
}

export async function automaticUpload({ connection, paths, openBrowser, onProgress }) {
  try {
    const result = await uploadLocalFiles(connection, paths, onProgress);
    return { mode: 'inserted', files: result.files };
  } catch (error) {
    const url = browserLink(connection.origin, connection.token, true);
    await openBrowser(url);
    return { mode: 'browser', error: error.message, url };
  }
}
