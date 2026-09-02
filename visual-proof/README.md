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

The viewer accepts absolute PNG paths up to 10 MiB. It supports non-interlaced,
8-bit grayscale, grayscale-alpha, RGB, indexed-color, and RGBA PNGs.

## Controls

- `q` or `Esc`: close the viewer
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

The visual-proof skill should retain its absolute Markdown link for clients
such as Fleet, then open this plugin pane only when `HERDR_ENV=1` and the plugin
is installed. Passing the path through `--env VISUAL_PROOF_PATH=...` keeps the
handoff explicit and avoids scraping rendered agent output.
