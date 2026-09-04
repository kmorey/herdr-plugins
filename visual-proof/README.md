# Visual Proof

Preview an agent-generated PNG beside its Herdr pane without leaving the
terminal. On Herdr 0.8.2 or newer with `experimental.kitty_graphics = true`,
the viewer uses Herdr's native pane-graphics stream for a full-resolution image.
It falls back to true-color Unicode half blocks when native graphics are
unavailable. The viewer is dependency-free beyond Node.js 20 or newer.

## Develop locally

From the repository root:

```bash
npm --prefix visual-proof test
herdr plugin link "$PWD/visual-proof"
```

Open a proof beside the current pane:

```bash
herdr plugin pane open \
  --plugin kmorey.visual-proof \
  --entrypoint viewer \
  --placement split \
  --target-pane "$HERDR_PANE_ID" \
  --env "VISUAL_PROOF_PATH=/absolute/path/to/proof.png"
```

Open several proofs as a navigable gallery by passing a JSON array in display
order:

```bash
herdr plugin pane open \
  --plugin kmorey.visual-proof \
  --entrypoint viewer \
  --placement split \
  --target-pane "$HERDR_PANE_ID" \
  --env 'VISUAL_PROOF_PATHS=["/absolute/path/to/first.png","/absolute/path/to/second.png"]'
```

Open the latest proof linked from the focused pane:

```bash
herdr plugin action invoke kmorey.visual-proof.open-current
```

The action reads the last 500 rows of the focused pane, prefers PNG links after
the latest `Visual Proof` heading, and opens up to 24 proofs as a gallery. If
there is no heading, it opens the most recent valid PNG path. Missing or stale
paths produce a Herdr notification instead of opening an empty viewer.

Bind the action in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+v"
type = "plugin_action"
command = "kmorey.visual-proof.open-current"
description = "Open current visual proof"
```

The viewer accepts absolute PNG paths up to 10 MiB. It supports non-interlaced,
8-bit grayscale, grayscale-alpha, RGB, indexed-color, and RGBA PNGs.

## Controls

- `q` or `Esc`: close the viewer
- `Left`, `h`, or `[`: show the previous proof
- `Right`, `l`, or `]`: show the next proof
- `o`: open the image in the platform's desktop viewer
- `y`: copy the absolute path using OSC 52

The preview redraws when its pane is resized.

## High-resolution graphics

Enable pane graphics in `~/.config/herdr/config.toml` on the Herdr server and,
when using `herdr --remote`, on the local client too:

```toml
[experimental]
kitty_graphics = true
```

The outer terminal must support the Kitty graphics protocol. Herdr's audited
local terminals are Ghostty, kitty, and WezTerm.

## Agent integration

The visual-proof skill should retain its absolute Markdown links for clients
such as Fleet, then open this plugin pane only when `HERDR_ENV=1` and the plugin
is installed. Passing paths through `--env VISUAL_PROOF_PATHS=...` remains the
most reliable handoff because the paths are explicit. The `open-current` action
is a user-invoked convenience for reopening proofs from retained pane output.
`VISUAL_PROOF_PATH` remains available for a single proof.
