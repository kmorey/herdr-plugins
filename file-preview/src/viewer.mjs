import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { emitKeypressEvents } from "node:readline";

import { loadArtifact } from "./artifact.mjs";
import { moveIndex } from "./gallery.mjs";
import { imagePlacement, openPaneGraphics } from "./herdr-graphics.mjs";
import { renderPreview, truncateMiddle } from "./render.mjs";
import { documentText, layoutText, safeText, textRows } from "./text.mjs";

const HELP = [
  "Keyboard help", "",
  "q / Ctrl+C     Close viewer",
  "Esc / ?        Return from help",
  "Left / h / [   Previous file",
  "Right / l / ]  Next file",
  "y              Copy absolute path",
  "o              Open on viewer host",
  "s              Markdown source/render",
  "/              Literal search",
  "Enter / Esc    Submit/cancel search",
  "n / N          Next/previous match",
  "Up/Down / k/j  Scroll one row",
  "PgUp/PgDn      Scroll a page",
  "Space          Next page",
  "Home/End       Start/end of text",
].join("\n");

export async function runViewer(paths) {
  let index = 0;
  let artifact = loadArtifact(paths[index]);
  const offsets = paths.map(() => 0);
  const sourceViews = paths.map(() => false);
  let rows = [];
  let document = artifact.image ? "" : documentText(artifact);
  let layout;
  let layoutWidth;
  let query = "";
  let editing = false;
  let draft = "";
  let matches = [];
  let matchIndex = 0;
  let status = "";
  let graphics;
  let graphicsAttempted = false;
  let imageShown = false;
  let graphicsError = "";
  let closed = false;
  let help = false;
  let helpOffset = 0;
  let queue = Promise.resolve();
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const originalRaw = process.stdin.isRaw ?? false;
  const size = () => ({ columns: Math.max(2, process.stdout.columns || 80), rows: Math.max(4, process.stdout.rows || 24) });
  const viewport = () => Math.max(1, size().rows - 5);

  async function draw() {
    if (closed) return;
    if (artifact.image && !graphicsAttempted && interactive) {
      graphicsAttempted = true;
      try {
        graphics = await openPaneGraphics({ socketPath: process.env.HERDR_SOCKET_PATH, paneId: process.env.HERDR_PANE_ID });
      } catch (error) {
        graphicsError = error.message;
      }
    }
    if ((!artifact.image || help) && imageShown) {
      await graphics.clear();
      imageShown = false;
    }
    const { columns, rows: height } = size();
    const width = columns - 1;
    const name = safeText(path.basename(artifact.path)).replace(/\n/g, "\\n");
    const clip = (text) => textRows(truncateMiddle(safeText(text).replace(/\n/g, "\\n"), width), width)[0];
    if (help) {
      const helpRows = textRows(HELP, width);
      helpOffset = Math.max(0, Math.min(helpOffset, helpRows.length - viewport()));
      process.stdout.write(`\x1b[2J\x1b[H\x1b[1;36m${clip("File preview · Keyboard help")}\x1b[0m\n\n\n${helpRows.slice(helpOffset, helpOffset + viewport()).join("\n")}\x1b[${height - 1};1H${clip("↑↓ scroll · Home/End")}\x1b[${height};1H${clip("Esc/? back · q close")}`);
      return;
    }
    const detail = artifact.image ? `${artifact.image.width}×${artifact.image.height}` : `${artifact.type}${artifact.type === "markdown" ? (sourceViews[index] ? " source" : " rendered") : ""}`;
    const metadata = artifact.diagnostic ? `${artifact.diagnostic} · ${safeText(artifact.path)}` : `${detail} · ${formatBytes(artifact.bytes)} · ${safeText(artifact.path)}`;
    const heading = `\x1b[1;36m${clip(`File preview  ${index + 1}/${paths.length}  ${name}`)}\x1b[0m`;
    const footer = width < 60 ? "? help · q close" : ["? help", paths.length > 1 ? "←/h prev · →/l next" : "", !artifact.image ? "↑↓ scroll · / search · n/N match" : "", artifact.type === "markdown" ? "s source" : "", "q/Esc close · o open · y copy"].filter(Boolean).join(" · ");
    let body;
    if (artifact.image) {
      body = graphics ? "" : renderPreview(artifact.image, columns, height);
    } else {
      if (!layout || layoutWidth !== width) {
        const anchor = layout?.rows[offsets[index]]?.start;
        layout = layoutText(document, width);
        layoutWidth = width;
        if (anchor !== undefined) {
          const next = layout.rows.findIndex((row) => row.start > anchor);
          offsets[index] = next === -1 ? layout.rows.length - 1 : Math.max(0, next - 1);
        }
      }
      rows = layout.rows;
      offsets[index] = Math.max(0, Math.min(offsets[index], rows.length - viewport()));
      body = rows.slice(offsets[index], offsets[index] + viewport()).map((row) => {
        const active = matches[matchIndex];
        if (active === undefined || active >= row.start + row.text.length || active + query.length <= row.start) return row.ansi;
        const from = Math.max(0, active - row.start);
        const to = Math.min(row.text.length, active + query.length - row.start);
        return `${row.text.slice(0, from)}\x1b[7m${row.text.slice(from, to)}\x1b[0m${row.text.slice(to)}`;
      }).join("\n");
    }
    const progress = !artifact.image ? `Lines ${offsets[index] + 1}–${Math.min(rows.length, offsets[index] + viewport())}/${rows.length}` : (graphics ? "Native graphics" : `ANSI fallback${graphicsError ? ` (${graphicsError})` : ""}`);
    const searchStatus = editing ? `/${draft}  (Enter search · Esc cancel)` : query ? `${matches.length ? `Match ${matchIndex + 1}/${matches.length}` : "No matches"} · /${query}` : "";
    process.stdout.write(`\x1b[2J\x1b[H\x1b]2;File preview: ${name}\x07${heading}\n\x1b[2m${clip(metadata)}\x1b[0m\n\n${body}\x1b[${height - 1};1H\x1b[2m${clip(status || searchStatus || progress)}\x1b[0m\x1b[${height};1H${clip(footer)}`);
    if (artifact.image && graphics) {
      await graphics.renderPng(artifact.data, artifact.image, imagePlacement(artifact.image, size(), graphics.cell));
      imageShown = true;
    }
  }

  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  async function close() {
    if (closed) return;
    closed = true;
    try {
      if (imageShown) await graphics.clear();
    } catch (error) {
      process.stderr.write(`Could not clear native image: ${safeText(error.message)}\n`);
      process.exitCode = 1;
    } finally {
      graphics?.close();
      process.stdout.off("resize", resize);
      process.stdin.off("keypress", keypress);
      process.off("SIGTERM", terminate);
      process.off("SIGINT", terminate);
      if (interactive) {
        process.stdin.setRawMode(originalRaw);
        process.stdin.pause();
      }
      process.stdout.write("\x1b[?25h\x1b[0m\n");
      finish();
    }
  }

  function schedule(action) {
    queue = queue.then(action).catch(async (error) => {
      process.stderr.write(`File preview unavailable: ${safeText(error.message)}\n`);
      process.exitCode = 1;
      await close();
    });
  }
  const resize = () => schedule(draw);
  const terminate = () => schedule(close);

  function resetDocument() {
    document = artifact.image ? "" : documentText(artifact, sourceViews[index]);
    layout = undefined;
    query = "";
    matches = [];
    matchIndex = 0;
  }

  function revealMatch() {
    const active = matches[matchIndex];
    if (active === undefined) return;
    const row = rows.findIndex((row) => active >= row.start && active < row.start + row.text.length);
    if (row >= 0) offsets[index] = row;
  }

  async function keypress(char, key = {}) {
    schedule(async () => {
      if (closed) return;
      if (editing) {
        if (key.ctrl && key.name === "c") return close();
        if (key.name === "escape") editing = false;
        else if (key.name === "return" || key.name === "enter") {
          editing = false;
          query = draft.normalize("NFC");
          matches = [];
          matchIndex = 0;
          if (query) {
            let offset = 0;
            while ((offset = layout.text.indexOf(query, offset)) !== -1) {
              matches.push(offset);
              offset += query.length;
            }
          }
          revealMatch();
        } else if (key.name === "backspace") draft = Array.from(draft).slice(0, -1).join("");
        else if (char && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f-\x9f]/.test(char) && draft.length < 256) draft += char;
        await draw();
        return;
      }
      if (char === "q" || (key.ctrl && key.name === "c")) return close();
      if (help) {
        if (char === "?" || key.name === "escape") help = false;
        else helpOffset = scrollPosition(helpOffset, char, key, viewport(), textRows(HELP, size().columns - 1).length);
        await draw();
        return;
      }
      if (key.name === "escape") return close();
      if (char === "?") { help = true; helpOffset = 0; await draw(); return; }
      status = "";
      if (["left", "right"].includes(key.name) || ["h", "l", "[", "]"].includes(char)) {
        const offset = key.name === "left" || char === "h" || char === "[" ? -1 : 1;
        index = moveIndex(index, paths.length, offset);
        artifact = loadArtifact(paths[index]);
        resetDocument();
      }
      if (!artifact.image) {
        if (char === "s" && artifact.type === "markdown") {
          sourceViews[index] = !sourceViews[index];
          offsets[index] = 0;
          resetDocument();
        }
        if (char === "/") { editing = true; draft = ""; }
        if ((char === "n" || char === "N") && matches.length) {
          matchIndex = moveIndex(matchIndex, matches.length, char === "n" ? 1 : -1);
          revealMatch();
        }
        offsets[index] = scrollPosition(offsets[index], char, key, viewport(), rows.length);
      }
      if (char === "y") {
        process.stdout.write(`\x1b]52;c;${Buffer.from(artifact.path).toString("base64")}\x07`);
        status = "Path copied";
      }
      if (char === "o") {
        const file = artifact.path;
        status = "Opening on viewer host…";
        void openExternal(file).then((message) => schedule(async () => {
          if (artifact.path === file) status = message;
          await draw();
        }));
      }
      await draw();
    });
  }

  try {
    process.stdout.write("\x1b[?25l");
    if (interactive) {
      emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.on("keypress", keypress);
      process.stdin.resume();
      process.stdout.on("resize", resize);
      process.once("SIGTERM", terminate);
      process.once("SIGINT", terminate);
    }
    queue = queue.then(draw);
    await queue;
    if (interactive) await done;
  } finally {
    await close();
  }
}

function scrollPosition(offset, char, key, page, length) {
  if (key.name === "down" || char === "j") return offset + 1;
  if (key.name === "up" || char === "k") return offset - 1;
  if (key.name === "pagedown" || char === " ") return offset + page;
  if (key.name === "pageup") return offset - page;
  if (key.name === "home") return 0;
  if (key.name === "end") return length;
  return offset;
}

function openExternal(file) {
  let command;
  let args;
  if (process.platform === "darwin") [command, args] = ["open", [file]];
  else if (process.platform === "win32") [command, args] = ["explorer.exe", [file]];
  else [command, args] = ["xdg-open", [file]];
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", (error) => resolve(`Could not open: ${error.message}`));
    child.once("exit", (code) => resolve(code === 0 ? "Opened on viewer host" : `Could not open: opener exited ${code}`));
    child.unref();
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
