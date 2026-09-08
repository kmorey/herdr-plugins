# File Upload

Transfer local files to the machine running your Herdr pane and insert their
absolute paths into its current input. The **local Kitty helper** uploads from
dropped paths automatically, with a **browser uploader as fallback**. The
browser also works on its own. Requires **Herdr 0.9.0+** and **Node.js 20+** on
the destination host (Linux or macOS).

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

## Automatic uploads with Kitty on Linux

The helper runs on **your local computer**, outside the remote Herdr pane. It
reads local files and uses an ordinary OpenSSH tunnel to reach the pinned upload
receiver. No Herdr core changes or Kitty remote-control permissions are needed.

### One-time local setup

Check out this repository on your local computer and install Node.js 20+ there.
Add this entry to `~/.config/kitty/open-actions.conf`, replacing the example
path with the **absolute local path** to this checkout:

```conf
protocol herdr-upload
action launch --type=overlay node /home/YOU/herdr-plugins/file-upload/local.mjs ${URL}
```

Keep this as its own entry, separated from other entries by a blank line. If
the checkout path has spaces, quote it. Restart Kitty after setting it up.
Your local Herdr's saved-machine list supplies SSH aliases; the helper does
not copy SSH credentials or change machine profiles.

### Attach, then drop

1. Invoke **Attach files to this pane** in the intended Herdr agent pane.
2. **Ctrl+Shift+click “Open local file helper”** in the upload pane. Kitty opens
   a local terminal overlay with that upload window's access key and pinned
   host/pane. The full helper link is also printed for copying.
3. The helper tries a matching local receiver, then matching/selected saved SSH
   machines. A candidate is accepted only after the receiver authenticates the
   upload-window key and confirms its host and pane. If the SSH alias cannot
   be inferred, choose the destination from the saved-machine list.
4. **Drop files into the local helper.** A bracketed terminal drop uploads and
   inserts the resulting paths automatically; no Enter is sent to your agent.
   You can also type shell-quoted absolute paths and press Enter in the helper.
5. Press Enter to close the helper and return to Herdr. The remote receiver and
   uploaded files remain available for the rest of that upload window.

The helper accepts one selection per launch. Quoted or backslash-escaped paths,
`~/` paths, and local `file://` URLs are parsed as data, without shell expansion.
Directories and non-regular files are rejected.

If a file is missing, unreadable, too large, or an upload/insertion fails, the
helper opens the browser uploader **for the same window**, preserving completed
uploads and any uncertain insertion state. Leave the helper open while using
the browser: it owns the SSH tunnel. Press **b** at the initial drop prompt to
use the browser directly, or **q** / Ctrl+C to cancel.

The helper uses noninteractive SSH (`BatchMode=yes`) and existing keys/SSH-agent
authentication. It disables SSH backgrounding and connection sharing for its
owned tunnel, so closing the helper also closes that tunnel. If SSH itself cannot
connect, neither upload path can reach the receiver. It reports the connection
failure and directs you to the original
browser link and manual tunnel instructions, rather than opening a broken page.
Connection hints never choose or change the destination pane, even if you switch
saved machines in another Herdr client.

For manual launching from a **local** terminal, copy the full helper link and run:

```bash
node file-upload/local.mjs 'herdr-upload://HOST:PORT/?pane=PANE#KEY'
```

You can force an enabled saved machine using `--machine PROFILE_ID`, or supply
file paths after `--`. `herdr machine list --json` lists the local profile IDs.

## Browser uploads

1. In the intended agent pane, invoke **Attach files to this pane**. A sibling
   upload pane opens with helper and browser links. The original pane stays focused.
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
machine connections. The local Kitty helper creates and owns this tunnel
automatically; these manual instructions are for browser-only use.

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
- The local helper's SSH tunnel stops when the helper closes or the upload
  window expires. Browser fallback uses that same tunnel and access key.
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
current path-paste adapter. `local.mjs` runs the local terminal helper, with
connection discovery/tunnel ownership in `src/local-connection.mjs` and the
automatic-transfer/browser-fallback policy in `src/automatic-upload.mjs`. The
same HTTP receiver serves both upload paths.

Herdr already has a native remote-image bridge for some single image-path
drops. This helper additionally covers general files and browser recovery;
it does not intercept arbitrary drops into agent panes or replace that bridge.
