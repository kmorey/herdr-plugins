# File Preview

Read agent-generated reports and screenshots beside their Herdr pane. File
Preview supports PNG, MP4 video, Markdown, JSON, and UTF-8 text in an ordered mixed gallery.
Files are read on the host running the plugin, including when Herdr is remote.

## Install and develop

Node.js 20+ and npm are required. Herdr installs the locked Markdown and
Unicode-wrapping dependencies through the plugin's build step.

File Preview v0.6.0 requires Herdr 0.9.2 or newer. Install the release with:

```sh
herdr plugin install kmorey/herdr-plugins/file-preview --ref v0.6.0 --yes
```

For local development, link a checkout from the repository root:

```sh
npm --prefix file-preview ci
herdr plugin link "$PWD/file-preview"
```

Open a file beside the current agent without stealing focus:

```sh
herdr plugin pane open \
  --plugin kmorey.file-preview \
  --entrypoint viewer \
  --placement split \
  --target-pane "$HERDR_PANE_ID" \
  --direction right \
  --env 'FILE_PREVIEW_PATH=/absolute/path/to/REPORT.md' \
  --no-focus
```

For a gallery, replace the single-path environment argument with:

```sh
--env 'FILE_PREVIEW_PATHS=["/absolute/path/to/REPORT.md","/absolute/path/to/comparison.json","/absolute/path/to/proof.png"]'
```

At most 24 paths can be supplied. Duplicates are removed, keeping the first
occurrence. Navigation follows the supplied order and wraps at both ends.
Files are loaded as selected, keeping only the current decoded image in memory.
Unreadable files produce an error identifying the failed path.

## Formats and limits

- **MP4:** `.mp4`, case-insensitively, with a video stream supported by the host's
  FFmpeg build. Requires `ffmpeg` and `ffprobe` in `PATH` on the viewer host.
  Opens paused; playback is silent and requires native pane graphics. Without
  native graphics, the viewer reports that the preview is unavailable; `o` opens
  the original recording on the viewer host.
  Video is decoded incrementally, rather than loaded into memory, with previews
  capped at 15 fps and 1280×720. Source dimensions have the same 8,192-per-side
  and 20-million-pixel limits as PNGs; the PNG/text file-size limits do not apply.
  The decoder runs only for the selected video and stops on pause, help, gallery
  navigation, or exit. Late rendered frames are skipped rather than queued.
- **PNG:** detected by signature; `.png` files must also have a valid signature.
  Up to 10 MiB, 8,192 pixels per dimension and 20 million pixels total. Supports
  non-interlaced, 8-bit grayscale, grayscale-alpha, RGB, indexed-color, and RGBA.
- **Markdown:** `.md`, `.markdown`, `.mdown`, and `.mkd`, case-insensitively.
  Headings, emphasis, lists, code, quotes, tables, and links render as terminal
  text. `s` toggles the rendered view and original source. Links display their
  destinations; they do not launch from the preview.
- **JSON:** `.json`, case-insensitively. Indentation preserves original number
  and string tokens, including large integers and precise decimals. Malformed
  JSON shows its original source with a diagnostic. Visual indentation stops
  increasing after 32 nesting levels.
- **Text:** other UTF-8 text files, including empty files. Text formats are
  limited to 1 MiB. Tabs display as four spaces, line endings are normalized,
  and terminal control sequences display as escaped text.

Other binary files, directories, and other image formats are unsupported. Text wraps
to the pane width, accounting for wide characters. Image previews redraw on
resize. The text viewport remains within the current document.

## Controls

| Key | Action |
| --- | --- |
| `?` | Scrollable keyboard help; `?` or `Esc` returns to the file |
| `q`, `Esc`, `Ctrl+C` | Close the viewer (Esc cancels an active search or help) |
| `Left`, `h`, `[` | Previous file |
| `Right`, `l`, `]` | Next file |
| `Up`/`Down`, `k`/`j` | Scroll text one row |
| `PageUp`/`PageDown`, `Space` | Scroll a page (Space moves down) |
| `Home`/`End` | Beginning/end of document |
| `s` | Toggle Markdown source/rendered view |
| `/` | Enter a new literal, case-sensitive search (up to 256 characters) |
| `Enter` / `Esc` during search | Submit / cancel search |
| `n` / `N` | Next / previous match, wrapping at the ends |
| `y` | Copy the current absolute path through OSC 52 |
| `o` | Request opening with the platform's application on the viewer host |

### Video controls

| Key | Action while viewing MP4 |
| --- | --- |
| `Space` | Play/pause; replay after reaching the end |
| `Left` / `Right` | Seek backward/forward five seconds |
| `,` / `.` | Pause and step backward/forward by one nominal frame interval |
| `[` / `]`, `h` / `l` | Previous/next gallery file |

Video positions are remembered when navigating the gallery; returning opens
paused. Frame stepping uses `1 / average frame rate`, so variable-frame-rate
recordings may not advance exactly one source frame. Resizing refits the video
and restarts decoding at the current position. Audio is not played or forwarded
to remote clients.

Open an MP4 using the same command above with
`--env 'FILE_PREVIEW_PATH=/absolute/path/to/demo.mp4'`, or include it in
`FILE_PREVIEW_PATHS` alongside PNG and text files. MP4 support was added after
v0.5.0.

Search uses the active displayed representation (with Unicode NFC normalization)
and highlights the current
match, including matches crossing soft wraps. Submitting an empty query clears
search. Switching files or toggling Markdown source clears search. Canceling a
draft keeps the previous search. Characters typed into a search are not viewer
shortcuts.

External opening reports launch errors and nonzero opener exits. It does not
download a remote file or open it on the client machine. A successful opener
exit means the host accepted the request, not that a client application exists.

## Native graphics

On Herdr 0.9.2+, the viewer writes standard Kitty graphics to its terminal.
It does not call the removed `pane.graphics.info`, `set`, `stream`, or `clear`
APIs and needs no graphics socket connection. Kitty graphics are enabled by
default. If disabled, enable them in `~/.config/herdr/config.toml` on the server
and, with `herdr --remote`, on the local client:

```toml
[terminal]
kitty_graphics = true
```

The outer terminal must support the Kitty graphics protocol (Herdr's audited
terminals are Ghostty, kitty, and WezTerm). PNG previews fit the complete image
to the pane, then send PNG bytes in chunked Kitty protocol commands. If native
graphics are unavailable or fail, the
viewer displays the error and offers `o` to open the original on the viewer host
or `y` to copy its path. Images and video frames never use pixelated terminal-block
substitutes. Switching to text clears the
viewer's owned image; returning to PNG renders it again. Help, resize, and exit
also remove the viewer's graphics without deleting another application's images.

The viewer queries Kitty support and obtains cell dimensions through standard
terminal replies (`CSI 16 t`). Each query or image acknowledgment waits at most
2 seconds; missing or zero cell dimensions are retried within a 2-second
readiness deadline. Some fresh Herdr 0.9.3–0.9.5 panes do not answer the cell-size query
until resized. If the viewer reports unavailable cell dimensions, resize the pane
once to retry negotiation. The viewer remains Node-only and does not guess cell
dimensions or use an additional runtime to obtain them.
Replies, including fragmented or late replies, are consumed separately from
keyboard shortcuts and search input. If support or metrics remain unavailable,
the viewer displays the error and offers the original-file actions rather than
rendering a substitute.

### A preview cannot find its conversation pane

`pane_not_found` when opening a split happens before the viewer starts; it is
separate from a graphics negotiation failure. Check the caller context first:

```sh
herdr pane current --current
herdr pane get "$HERDR_PANE_ID"
```

A shared agent daemon can retain the environment of the pane in which it was
started. In particular, a Codex app-server may execute tools with an old
`HERDR_PANE_ID` even though the visible Codex client has the correct ID. Shell
snapshots can preserve that stale value across conversations. Retrying the same
command or disabling shell snapshots does not repair an already stale daemon
environment.

For Codex, starting a conversation with `codex --no-daemon` gives it a separate
server that inherits its pane context. Existing conversations need to be reopened
with that option. A shell alias only applies where the shell expands it.

Use `herdr pane list` to locate the conversation, then verify its identity with
`herdr pane get <id>` and `herdr pane process-info --pane <id>`. Pass that verified
live ID as `--target-pane` for this conversation only. A working directory alone
is insufficient when several panes share it. Do not fall back to the focused
pane or set one global pane ID for a shared daemon: previews could open beside
another conversation. If the conversation cannot be identified unambiguously,
report the stale context and retain the ordinary file link.

## Open the current file

The `open-current` action opens an ordered gallery of up to the three most
recent distinct existing PNG or MP4 paths from the originating agent pane's
last 500 rows. Invoking it again while File Preview is focused follows the
preview panes back to that agent pane instead of scraping the preview. It
recognizes indented parenthesized paths beneath a label, ignores duplicates
and unusable paths, and keeps the selected paths in their pane-output order.
Explicit file-path inputs remain the reliable way to open an ordered gallery or
any supported text format.

```sh
herdr plugin action invoke kmorey.file-preview.open-current
```

To bind the action:

```toml
[[keys.command]]
key = "prefix+v"
type = "plugin_action"
command = "kmorey.file-preview.open-current"
description = "Open current file"
```

Input precedence, from highest to lowest:

1. `FILE_PREVIEW_PATHS` — JSON array of absolute paths.
2. `FILE_PREVIEW_PATH` — one absolute path.
3. Positional path arguments.

A selected empty or malformed variable fails validation rather than falling
through to a lower-priority input.

Agents should explicitly pass output paths and keep ordinary absolute Markdown
links in their responses for other clients. The retained PNG/MP4 action is a
manual convenience; general Herdr conversation-link activation, directory
browsing, and persistent artifact registration are separate work.

## Inspection and tests

```sh
node file-preview/viewer.mjs --inspect /absolute/path/to/REPORT.md
node --test file-preview/test/cli.test.mjs
npm --prefix file-preview test
```

`--inspect` requires no TTY or Herdr connection. A single file produces an object
with `path` (resolved absolute path), `type` (`png`, `video`, `markdown`, `json`, or
`text`), and `bytes`. PNGs add `width` and `height`; text formats add `lines`
(source line count, including a trailing empty line). Videos add `width`,
`height`, `duration` (seconds), `fps` (average source rate), and `codec`, without
decoding frames. Malformed JSON adds a
`diagnostic` and still exits successfully. Multiple files produce
`{"files":[...]}`; this replaces the old `{"proofs":[...]}` shape. Invalid
inputs exit nonzero with a diagnostic on stderr.

The tests use Node's built-in runner, real file fixtures, a test-only Kitty
terminal responder, and the actual CLI in a PTY. Graphics tests validate
chunked PNG payloads, acknowledgment handling, fitting, and owned-image cleanup. Interactive tests require Python 3 on macOS/Linux;
PTY and Unix-socket tests are skipped on Windows. Video tests generate real MP4
fixtures and require FFmpeg/ffprobe; they are skipped when those tools are missing.
Python is a test-only requirement. This JavaScript
package has no TypeScript/typechecking setup; syntax can be checked with
`node --check`.

The suite launches subprocesses and PTYs. If a restricted agent sandbox reports
`spawnSync ... EPERM`, run the tests through the normal approval mechanism with
those operations permitted; that failure does not establish a viewer regression.
