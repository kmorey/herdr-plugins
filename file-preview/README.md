# File Preview

Read agent-generated reports and screenshots beside their Herdr pane. File
Preview supports PNG, MP4 video, Markdown, JSON, and UTF-8 text in an ordered mixed gallery.
Files are read on the host running the plugin, including when Herdr is remote.

## Install and develop

Node.js 20+ and npm are required. Herdr installs the locked Markdown and
Unicode-wrapping dependencies through the plugin's build step.

```sh
herdr plugin install kmorey/herdr-plugins/file-preview --ref v0.5.0 --yes
```

For a local checkout, from the repository root:

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
  native graphics, a still frame uses the terminal fallback and seeking works.
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
`FILE_PREVIEW_PATHS` alongside PNG and text files. For local development, link
this checkout to use MP4 support; the pinned v0.5.0 release predates it.

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

On Herdr 0.8.2+, enable pane graphics in `~/.config/herdr/config.toml` on the
server and, with `herdr --remote`, on the local client:

```toml
[experimental]
kitty_graphics = true
```

The outer terminal must support the Kitty graphics protocol (Herdr's audited
terminals are Ghostty, kitty, and WezTerm). If native graphics are unavailable,
PNG previews use true-color Unicode half blocks. Switching to text clears the
native image layer; returning to PNG renders it again.

## Migration from Visual Proof

The existing user-invoked `open-current` action is retained for reopening the
latest PNG/MP4 proof gallery from the focused pane's last 500 rows. It recognizes
Visual Proof, Fresh Proof, Current Proof, and Updated Visual Proof headings
(including Fresh/Current Visual Proof variants), and otherwise selects the
most recent existing PNG or MP4 path. Stale or missing paths produce a notification.
Explicit file-path inputs remain the reliable handoff for all supported formats.

```sh
herdr plugin action invoke kmorey.file-preview.open-current
```

Update an existing shortcut in `~/.config/herdr/config.toml` to the new action:

```toml
[[keys.command]]
key = "prefix+v"
type = "plugin_action"
command = "kmorey.file-preview.open-current"
description = "Open current visual proof"
```

Relink/reinstall as `kmorey.file-preview` and update callers to use that plugin
ID. The old `kmorey.visual-proof` ID is not an alias. Existing installations can
remain while callers migrate; the visual-proof skill still collects and
delivers screenshot evidence, using File Preview as its viewer.

Input precedence, from highest to lowest:

1. `FILE_PREVIEW_PATHS` — JSON array of absolute paths.
2. `FILE_PREVIEW_PATH` — one absolute path.
3. `VISUAL_PROOF_PATHS` — legacy JSON array.
4. `VISUAL_PROOF_PATH` — legacy single path.
5. Positional path arguments.

A selected empty or malformed variable fails validation rather than falling
through to a lower-priority input. Compatibility variables remain supported
during migration.

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

The tests use Node's built-in runner, real file fixtures, a mock Herdr socket,
and the actual CLI in a PTY. Interactive tests require Python 3 on macOS/Linux;
PTY and Unix-socket tests are skipped on Windows. Video tests generate real MP4
fixtures and require FFmpeg/ffprobe; they are skipped when those tools are missing.
Python is a test-only requirement. This JavaScript
package has no TypeScript/typechecking setup; syntax can be checked with
`node --check`.
