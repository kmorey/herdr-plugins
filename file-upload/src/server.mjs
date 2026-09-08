import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const assets = new Map(await Promise.all([
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/style.css', 'style.css', 'text/css; charset=utf-8'],
].map(async ([route, file, type]) => [route, {
  body: await readFile(new URL(`../public/${file}`, import.meta.url)), type,
}])));

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function safeName(name) {
  // Strip either platform's directory components and characters unsafe in a terminal.
  const base = name.split(/[\\/]/u).at(-1).normalize('NFC')
    .replace(/[\x00-\x1f\x7f-\x9f<>:"|?*]/gu, '_')
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, '_')
    .replace(/^\.+|[. ]+$/gu, '');
  let result = '';
  for (const character of base || 'upload') {
    if (Buffer.byteLength(result + character) > 160) break;
    result += character;
  }
  return result;
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJSON(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8192) throw new RequestError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'Invalid JSON.');
  }
}

export async function startReceiver({
  stateDir,
  target,
  deliver,
  port = 0,
  maxFileBytes = 25 * 1024 * 1024,
  maxTotalBytes = 100 * 1024 * 1024,
  maxFiles = 32,
  lifetimeMs = 30 * 60 * 1000,
  onActivity = () => {},
}) {
  if (!stateDir || typeof deliver !== 'function') throw new Error('Missing upload storage or delivery adapter.');
  const root = resolve(stateDir, 'uploads');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'batch-'));
  const token = randomBytes(32).toString('hex');
  const files = new Map();
  let bytesUsed = 0;
  let busy = false;
  let closing = false;
  const expiresAt = Date.now() + lifetimeMs;

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const asset = assets.get(url.pathname);
        res.writeHead(200, { 'Content-Type': asset.type });
        res.end(asset.body);
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) throw new RequestError(401, 'This upload link is missing its access key. Reopen the link from the Herdr upload pane.');
      // API requests use a secret header and same-origin fetches. No CORS is enabled.
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'Cross-site requests are not allowed.');
      if (closing || Date.now() >= expiresAt) throw new RequestError(410, 'This upload window has expired. Open a new one in Herdr.');
      if (req.method === 'GET' && url.pathname === '/api/session') {
        json(res, 200, { target, maxFileBytes, maxTotalBytes, maxFiles, expiresAt, files: [...files.values()] });
        return;
      }
      if (req.method !== 'POST' || !['/api/files', '/api/insert'].includes(url.pathname)) {
        throw new RequestError(404, 'Not found.');
      }
      if (busy) throw new RequestError(409, 'Another upload or insertion is in progress.');
      busy = true;
      try {
        if (url.pathname === '/api/files') {
          if (files.size >= maxFiles) throw new RequestError(413, `This window accepts up to ${maxFiles} files.`);
          const name = url.searchParams.get('name');
          if (!name || name.length > 1024) throw new RequestError(400, 'A filename is required (up to 1024 characters).');
          const available = Math.min(maxFileBytes, maxTotalBytes - bytesUsed);
          if (Number(req.headers['content-length']) > available) throw new RequestError(413, 'File exceeds the remaining upload limit.');
          const id = randomUUID();
          const filename = safeName(name);
          const path = join(directory, `${id}-${filename}`);
          const handle = await open(path, 'wx', 0o600);
          let size = 0;
          try {
            for await (const chunk of req.iterator({ destroyOnReturn: false })) {
              size += chunk.length;
              if (size > available) throw new RequestError(413, 'File exceeds the remaining upload limit.');
              await handle.writeFile(chunk);
            }
            await handle.close();
            const file = { id, name: filename, path, size, delivery: 'pending' };
            files.set(id, file);
            bytesUsed += size;
            onActivity(`Uploaded ${filename} (${size} bytes)`);
            json(res, 201, file);
          } catch (error) {
            req.resume();
            await handle.close().catch(() => {});
            await rm(path, { force: true });
            throw error;
          }
        } else {
          const input = await readJSON(req);
          if (!Array.isArray(input?.ids) || !input.ids.length || input.ids.length > maxFiles ||
              new Set(input.ids).size !== input.ids.length || input.ids.some((id) => !files.has(id))) {
            throw new RequestError(400, 'Choose uploaded files from this window.');
          }
          const selected = input.ids.map((id) => files.get(id));
          if (selected.some((file) => file.delivery !== 'pending')) {
            throw new RequestError(409, 'These paths have already been sent or attempted. Check the target pane before copying them manually.');
          }
          // A CLI timeout can occur after text reached the terminal. Never replay automatically.
          for (const file of selected) file.delivery = 'attempted';
          try {
            await deliver(selected.map((file) => file.path));
          } catch (error) {
            onActivity(`Insertion failed: ${error.message}`);
            throw new RequestError(502, 'Could not confirm insertion. Check the target pane; the saved paths are available below for manual copying.');
          }
          for (const file of selected) file.delivery = 'inserted';
          onActivity(`Inserted ${selected.length} path(s) into ${target.paneID}; Enter was not sent.`);
          json(res, 200, { files: selected });
        }
      } finally {
        busy = false;
      }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, error.status || 500, {
        error: error.status ? error.message : 'Upload failed. Check the Herdr upload pane.',
      });
      if (!error.status) onActivity(`Error: ${error.message}`);
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  }).catch(async (error) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  let closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    clearTimeout(timer);
    closePromise = new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }).then(async () => {
      // Completed files remain available to agents after the browser/receiver closes.
      if (!files.size && !busy) await rm(directory, { recursive: true, force: true });
    });
    return closePromise;
  };
  const timer = setTimeout(() => {
    onActivity('Upload window expired. Saved files remain available.');
    void close();
  }, lifetimeMs);
  timer.unref();
  return { url: `${origin}/#${token}`, origin, token, port: address.port, directory, close };
}
