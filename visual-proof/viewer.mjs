#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { imagePlacement, openPaneGraphics } from "./src/herdr-graphics.mjs";
import { loadProof } from "./src/proof.mjs";
import { renderPreview, truncateMiddle } from "./src/render.mjs";

const requestedPath = process.env.VISUAL_PROOF_PATH || process.argv[2];

try {
  const proof = loadProof(requestedPath);
  if (process.argv.includes("--inspect")) {
    process.stdout.write(`${JSON.stringify({
      path: proof.path,
      bytes: proof.bytes,
      width: proof.image.width,
      height: proof.image.height,
    })}\n`);
  } else {
    await runViewer(proof);
  }
} catch (error) {
  process.stderr.write(`Visual proof unavailable: ${error.message}\n`);
  process.exitCode = 1;
}

async function runViewer(proof) {
  let status = "";
  let statusTimer;
  let graphics;
  let graphicsError = "";
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  const draw = () => {
    const columns = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const name = path.basename(proof.path);
    const detail = `${proof.image.width}×${proof.image.height} · ${formatBytes(proof.bytes)}`;
    const metadata = truncateMiddle(
      `${detail} · ${proof.path}` +
        (graphicsError ? ` · ANSI fallback (${graphicsError})` : ""),
      Math.max(1, columns - 1),
    );
    const heading =
      `\x1b[1;36mVisual proof\x1b[0m  \x1b[1m${name}\x1b[0m\n` +
      `\x1b[2m${metadata}\x1b[0m\n`;
    const controls =
      `\x1b[2mq/Esc close · o open externally · y copy path\x1b[0m` +
      (status ? `  \x1b[32m${status}\x1b[0m` : "");
    const title = `\x1b[2J\x1b[H\x1b]2;Visual proof: ${name}\x07`;
    if (graphics) {
      process.stdout.write(`${title}${heading}\x1b[${rows};1H${controls}`);
    } else {
      const preview = renderPreview(proof.image, columns, rows);
      process.stdout.write(`${title}${heading}\n${preview}\n\n${controls}`);
    }
  };

  const renderGraphics = () => {
    if (!graphics) return;
    graphics.renderPng(
      proof.data,
      proof.image,
      imagePlacement(
        proof.image,
        { columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 },
        graphics.cell,
      ),
    );
  };

  const setStatus = (message) => {
    status = message;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      status = "";
      draw();
    }, 1_800);
    draw();
  };

  const cleanup = () => {
    clearTimeout(statusTimer);
    graphics?.close();
    process.stdout.write("\x1b[?25h\x1b[0m");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  };

  try {
    graphics = await openPaneGraphics({
      socketPath: process.env.HERDR_SOCKET_PATH,
      paneId: process.env.HERDR_PANE_ID,
    });
  } catch (error) {
    graphics = undefined;
    graphicsError = error instanceof Error ? error.message : String(error);
  }

  process.stdout.write("\x1b[?25l");
  draw();
  renderGraphics();
  process.stdout.on("resize", () => {
    draw();
    renderGraphics();
  });
  process.once("exit", cleanup);
  process.once("SIGTERM", () => process.exit(0));

  if (!interactive) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (key) => {
    if (key === "q" || key === "\x1b" || key === "\x03") process.exit(0);
    if (key === "o") {
      openExternal(proof.path);
      setStatus("Opened externally");
    }
    if (key === "y") {
      const encoded = Buffer.from(proof.path).toString("base64");
      process.stdout.write(`\x1b]52;c;${encoded}\x07`);
      setStatus("Path copied");
    }
  });
}

function openExternal(proofPath) {
  let command;
  let args;
  if (process.platform === "darwin") [command, args] = ["open", [proofPath]];
  else if (process.platform === "win32") [command, args] = ["cmd", ["/d", "/c", "start", "", proofPath]];
  else [command, args] = ["xdg-open", [proofPath]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
