#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

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
    runViewer(proof);
  }
} catch (error) {
  process.stderr.write(`Visual proof unavailable: ${error.message}\n`);
  process.exitCode = 1;
}

function runViewer(proof) {
  let status = "";
  let statusTimer;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  const draw = () => {
    const columns = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const name = path.basename(proof.path);
    const detail = `${proof.image.width}×${proof.image.height} · ${formatBytes(proof.bytes)}`;
    const displayPath = truncateMiddle(proof.path, Math.max(10, columns - 2));
    const preview = renderPreview(proof.image, columns, rows);
    process.stdout.write(
      `\x1b[2J\x1b[H\x1b]2;Visual proof: ${name}\x07` +
        `\x1b[1;36mVisual proof\x1b[0m  \x1b[1m${name}\x1b[0m\n` +
        `\x1b[2m${detail} · ${displayPath}\x1b[0m\n\n${preview}\n\n` +
        `\x1b[2mq/Esc close · o open externally · y copy path\x1b[0m` +
        (status ? `  \x1b[32m${status}\x1b[0m` : ""),
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
    process.stdout.write("\x1b[?25h\x1b[0m");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  };

  process.stdout.write("\x1b[?25l");
  draw();
  process.stdout.on("resize", draw);
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
