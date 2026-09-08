let token = location.hash.slice(1);
const fallback = new URLSearchParams(location.search).has('fallback');
document.querySelector('#handoff').hidden = !fallback;
try {
  if (token) sessionStorage.setItem('herdr-upload-key', token);
  else token = sessionStorage.getItem('herdr-upload-key') || '';
} catch { /* A fresh link also works when browser storage is disabled. */ }
// Keep the key out of the address bar, referrers and captured screenshots.
history.replaceState(null, '', location.pathname + location.search);
const input = document.querySelector('#files');
const zone = document.querySelector('#drop-zone');
const status = document.querySelector('#status');
const insert = document.querySelector('#insert');
let session;
let busy = false;

function message(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

function size(bytes) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function render() {
  const files = session?.files || [];
  document.querySelector('#uploads').hidden = !files.length;
  document.querySelector('#count').textContent = `${files.length} file${files.length === 1 ? '' : 's'} · ${size(files.reduce((total, file) => total + file.size, 0))}`;
  const list = document.querySelector('#file-list');
  list.replaceChildren();
  for (const file of files) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    const state = document.createElement('span');
    state.className = 'file-state';
    state.textContent = `${size(file.size)} · ${file.delivery === 'pending' ? 'Ready' : file.delivery === 'inserted' ? 'Inserted' : 'Check pane'}`;
    const path = document.createElement('code');
    path.className = 'file-path';
    path.textContent = file.path;
    li.append(name, state, path);
    list.append(li);
  }
  input.disabled = busy || !session;
  insert.disabled = busy || !files.some((file) => file.delivery === 'pending');
}

async function upload(files) {
  if (busy || !session || !files.length) return;
  busy = true;
  render();
  let completed = 0;
  let failure;
  try {
    for (const file of files) {
      if (file.size > session.maxFileBytes) throw new Error(`${file.name} exceeds the ${size(session.maxFileBytes)} file limit.`);
      message(`Uploading ${file.name} (${completed + 1}/${files.length})…`);
      const uploaded = await api(`/api/files?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      session.files.push(uploaded);
      completed++;
      render();
    }
    message(`${completed} file${completed === 1 ? '' : 's'} saved. Insert the paths when your target pane is ready for input.`);
  } catch (error) {
    failure = error;
    message(`${completed ? `${completed} file(s) saved. ` : ''}${error.message} Remaining files were not uploaded.`, true);
  } finally {
    // Reconcile after an interrupted response: the receiver may have saved the file.
    if (failure) {
      try { session = await api('/api/session'); } catch { /* Keep already known paths visible. */ }
    }
    busy = false;
    input.value = '';
    render();
  }
}

input.addEventListener('change', () => void upload([...input.files]));
for (const event of ['dragover', 'drop']) {
  document.addEventListener(event, (e) => e.preventDefault());
}
zone.addEventListener('dragover', () => zone.classList.add('dragging'));
zone.addEventListener('dragleave', (event) => {
  if (!zone.contains(event.relatedTarget)) zone.classList.remove('dragging');
});
zone.addEventListener('drop', (event) => {
  zone.classList.remove('dragging');
  const items = [...(event.dataTransfer.items || [])];
  if (items.some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
    message('Choose individual files. Folder uploads are not supported.', true);
    return;
  }
  void upload([...event.dataTransfer.files]);
});
insert.addEventListener('click', async () => {
  if (busy || !session) return;
  busy = true;
  const selected = session.files.filter((file) => file.delivery === 'pending');
  // An uncertain network response must not make the button replay terminal input.
  for (const file of selected) file.delivery = 'attempted';
  render();
  try {
    const result = await api('/api/insert', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selected.map((file) => file.id) }),
    });
    for (const file of result.files) Object.assign(session.files.find((item) => item.id === file.id), file);
    message(`Paths inserted into ${session.target.paneID}. Return to Herdr to finish your message. Enter was not sent.`);
  } catch (error) {
    message(`${error.message} Check the pane before copying the paths manually.`, true);
  } finally {
    busy = false;
    render();
  }
});

async function connect() {
  try {
    session = await api('/api/session');
    document.querySelector('#target').textContent = `${session.target.paneID} · ${session.target.host}`;
    document.querySelector('#expiry').textContent = `Closes at ${new Date(session.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    document.querySelector('#limits').textContent = `${size(session.maxFileBytes)} per file · ${size(session.maxTotalBytes)} total · up to ${session.maxFiles} files`;
    message('Connected. Files will be saved on the destination machine.');
    render();
  } catch (error) {
    document.querySelector('#target').textContent = 'Receiver unavailable';
    message(error.message, true);
  }
}
void connect();
