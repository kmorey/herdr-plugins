const TOKEN = /^[a-f0-9]{64}$/u;

export function helperLink({ host, paneID, port, token }) {
  const url = new URL(`herdr-upload://${host}:${port}/`);
  url.searchParams.set('pane', paneID);
  url.hash = token;
  return url.href;
}

export function parseHandoff(value) {
  const url = new URL(value);
  const port = Number(url.port);
  const paneID = url.searchParams.get('pane');
  if (url.protocol !== 'herdr-upload:' || url.username || url.password ||
      !url.hostname || url.pathname !== '/' || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !paneID || !/^[a-zA-Z0-9:_-]{1,128}$/u.test(paneID) || !TOKEN.test(url.hash.slice(1))) {
    throw new Error('Invalid helper link. Use the link printed by the Herdr upload pane.');
  }
  return { host: url.hostname, port, paneID, token: url.hash.slice(1) };
}

export function browserLink(origin, token, fallback = false) {
  return `${origin}/${fallback ? '?fallback=1' : ''}#${token}`;
}

export async function receiverRequest(connection, path, options = {}) {
  const response = await fetch(`${connection.origin}${path}`, {
    ...options,
    redirect: 'error',
    signal: options.signal ?? AbortSignal.timeout(120_000),
    headers: { ...options.headers, Authorization: `Bearer ${connection.token}` },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Receiver returned HTTP ${response.status}.`);
  return body;
}

export async function verifyReceiver(connection, handoff) {
  const session = await receiverRequest(connection, '/api/session', { signal: AbortSignal.timeout(2000) });
  if (session.target?.paneID !== handoff.paneID || session.target?.host?.toLowerCase() !== handoff.host.toLowerCase()) {
    throw new Error('The receiver does not match the pinned host and pane.');
  }
  if (session.expiresAt <= Date.now()) throw new Error('This upload window has expired. Invoke Attach again.');
  return session;
}
