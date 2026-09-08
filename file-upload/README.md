# File Upload

Drop local files into a browser, save them on the machine running your Herdr
pane, and insert their absolute paths into that pane's current input. Works
with local Herdr and remote Herdr reached over SSH. Requires **Herdr 0.9.0+**
and **Node.js 20+** on the destination host (Linux or macOS).

## Install and bind

From this repository root, on each machine hosting target panes:

```bash
herdr plugin link "$PWD/file-upload"
```

Add a keybinding to your Herdr config (`~/.config/herdr/config.toml`):

```toml
[[keys.command]]
key = "prefix+u"
type = "plugin_action"
command = "kmorey.file-upload.attach"
description = "attach files to this pane"
```

Or, from this repository root inside the intended Herdr pane, run the action
entrypoint directly (the plugin must already be linked):

```bash
node file-upload/action.mjs
```

## Upload files

1. In the intended agent pane, invoke **Attach files to this pane**. A sibling
   upload pane opens with a browser link. The original pane stays focused.
2. Open the link in your browser. For a local pane, it works immediately.
3. Drop files into the page or use the file picker. Uploads start immediately.
4. When the agent's input is ready, click **Insert paths**. The plugin pastes
   paths into the original pane without sending Enter. Finish your message in
   Herdr and submit it yourself.

The first version uses an agent-independent **path-paste adapter**, including
for OpenCode V2. It does not create native attachment chips or submit messages
through an agent API. Agents with filesystem tools can read the pasted paths;
whether they interpret a path as an image attachment depends on the agent.
The target agent must be able to read the destination host's filesystem. A
container or a separate remote OpenCode service may need a shared mount or a
future transfer adapter.

### Remote panes

The upload receiver binds only to `127.0.0.1` on the destination host. The upload
pane prints a command with its allocated port:

```bash
ssh -N -L PORT:127.0.0.1:PORT your-ssh-host
```

Run that command **on your laptop**, substituting the printed port and the SSH
alias for the machine running the upload pane. Keep it running, then open the
printed browser link on your laptop. SSH transfers the browser's file bytes to
the remote receiver. This also works alongside `herdr --remote` or saved Herdr
machine connections; the plugin does not automatically create their tunnels.

If that local port is already occupied, use a different first port in `-L` and
change the port in the browser link to match. Keep the link's `#…` access key.
The key is specific to this upload window. The page removes it from the address
bar after loading and keeps it in tab-local session storage for refreshes.

Keybindings/actions must execute on the destination Herdr server. The upload
pane and browser page both identify the destination host and pane; the plugin
never infers a remote machine from a local pathname.

## Lifetime and storage

- One receiver per invocation, with a random port and access key; no public
  listener or background daemon.
- **25 MiB per file, 100 MiB and 32 files per upload window.** Files only;
  directory drops are rejected. Uploads are streamed to disk.
- Files live under `HERDR_PLUGIN_STATE_DIR/uploads/batch-*/` with unique names,
  private batch directories, and private file permissions. Original basenames
  are sanitized for terminal use. Duplicate names never overwrite each other.
- The receiver stops after **30 minutes**, when its pane closes, or on Ctrl+C.
  Completed uploads remain on disk so agents can read them later. Closing the
  browser alone does not stop the receiver.
- Delete obsolete batch directories manually once their conversations no longer
  need them. The upload pane prints its batch directory. No automatic retention
  cleanup removes files that an agent may still reference.
- The target pane ID, terminal identity, agent kind, and any native session
  identity are captured before opening the upload pane and checked before
  insertion. A closed, moved, or changed target requires a fresh invocation.
  For agents without session reporting, detecting every process replacement
  within the same terminal is not possible; insert only when the intended
  input is ready.
- An uncertain insertion is not retried automatically. Check the pane and copy
  the displayed paths manually if needed. Uploaded files remain available even
  when insertion fails.

## Develop

```bash
npm --prefix file-upload run check
npm --prefix file-upload test
```

`src/server.mjs` owns transfer, limits, and upload-window state. Its `deliver`
callback receives only completed destination paths. `src/herdr.mjs` owns the
current path-paste adapter. This seam allows a future native OpenCode attachment
adapter or local Herdr drop integration to reuse the same transfer layer.
