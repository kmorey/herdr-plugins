import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import net from "node:net";

import { loadArtifact, inspectArtifact } from "../src/artifact.mjs";
import { currentProofPaths } from "../src/current-proof.mjs";
import { decodePng } from "../src/png.mjs";
import { pngFrames, VideoDecoder } from "../src/video.mjs";
import { terminal } from "./support/terminal.mjs";

const available = ["ffmpeg", "ffprobe"].every((command) => spawnSync(command, ["-version"]).status === 0);
const viewer = fileURLToPath(new URL("../viewer.mjs", import.meta.url));

function fixture(t, filters = []) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "video-preview-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "sample video.MP4");
  const result = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=2", ...filters, "-c:v", "mpeg4", "-threads", "1", file]);
  assert.equal(result.status, 0, result.stderr.toString());
  return { directory, file };
}

function cleanEnv(extra = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HERDR_|FILE_PREVIEW_|VISUAL_PROOF_)/.test(key))), ...extra };
}

test("MP4 inspection validates media, dimensions and duration; shortcut discovers mixed media", { skip: !available }, (t) => {
  const { file, directory } = fixture(t);
  const artifact = inspectArtifact(loadArtifact(file));
  assert.equal(artifact.type, "video");
  assert.equal(artifact.duration, 2);
  assert.equal(artifact.fps, 10);
  assert.equal(artifact.width, 160);
  assert.equal(artifact.height, 90);
  const png = path.join(directory, "proof.png");
  writeFileSync(png, "png");
  assert.deepEqual(currentProofPaths(`Fresh proof\n${png}\n[Recording](${pathToFileURL(file).href})`), [png, file]);
  assert.deepEqual(currentProofPaths(`Recording: <${file}>`), [file]);
  writeFileSync(file, "not an mp4");
  assert.throws(() => loadArtifact(file), /Could not inspect MP4/);
});

test("decoder seeks, scales, plays changing frames, reaches end, restarts and stops its process", { skip: !available }, async (t) => {
  const { file } = fixture(t);
  const decoder = new VideoDecoder(file, loadArtifact(file).video);
  t.after(() => decoder.stop());
  const bounds = { width: 80, height: 80 };
  await decoder.start(0, false, bounds);
  assert.equal(decoder.error, "");
  assert.equal(decoder.playing, false);
  assert.equal(decodePng(decoder.frame).width, 80);
  const first = decoder.frame;
  await decoder.start(1, false, bounds);
  assert.equal(decoder.position, 1);
  assert.notDeepEqual(decoder.frame, first);
  await decoder.start(0, true, bounds);
  const started = performance.now();
  await decoder.finished;
  assert.ok(performance.now() - started >= 1900, "playback must run at media time rather than decoder speed");
  assert.equal(decoder.error, "");
  assert.equal(decoder.position, 2);
  assert.equal(decoder.playing, false);
  await decoder.start(decoder.position, false, { width: 90, height: 90 });
  assert.equal(decoder.position, 2, "resizing the last frame preserves completed state for replay");
  await decoder.start(0, true, bounds);
  const child = decoder.child;
  await delay(150);
  await decoder.stop();
  assert.ok(child.signalCode || child.exitCode !== null);
  assert.equal(decoder.child, undefined);
  await decoder.start(0, false, bounds);
  assert.deepEqual(decoder.frame, first);
});

test("anamorphic video is fitted using display aspect ratio", { skip: !available }, async (t) => {
  const { file } = fixture(t, ["-vf", "setsar=2"]);
  const video = loadArtifact(file).video;
  assert.equal(video.width / video.height, 32 / 9);
  const decoder = new VideoDecoder(file, video);
  t.after(() => decoder.stop());
  await decoder.start(0, false, { width: 320, height: 180 });
  const frame = decodePng(decoder.frame);
  assert.equal(frame.width, 320);
  assert.equal(frame.height, 90);
});

test("PNG frame parser handles split chunks, consecutive frames, truncation and oversized chunks", { skip: !available }, async (t) => {
  const { file } = fixture(t);
  const decoder = new VideoDecoder(file, loadArtifact(file).video);
  t.after(() => decoder.stop());
  await decoder.start(0, false, { width: 80, height: 80 });
  const frame = decoder.frame;
  const combined = Buffer.concat([frame, frame]);
  const pieces = Array.from({ length: Math.ceil(combined.length / 7) }, (_, i) => combined.subarray(i * 7, i * 7 + 7));
  const received = [];
  for await (const data of pngFrames(pieces)) received.push(data);
  assert.deepEqual(received, [frame, frame]);
  await assert.rejects(async () => { for await (const data of pngFrames([frame.subarray(0, -1)])) void data; }, /Truncated/);
  const oversized = Buffer.from(frame.subarray(0, 16));
  oversized.writeUInt32BE(17 * 1024 * 1024, 8);
  await assert.rejects(async () => { for await (const data of pngFrames([oversized])) void data; }, /too large/);
});

test("missing media tools give actionable diagnostics", { skip: !available }, (t) => {
  const { file } = fixture(t);
  const result = spawnSync(process.execPath, [viewer, "--inspect", file], { env: cleanEnv({ PATH: "" }), encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires ffmpeg and ffprobe on the viewer host/);
});

test("video fallback shows a still, supports seeking and gallery position, and restores terminal", { skip: !available || process.platform === "win32" }, async (t) => {
  const { file, directory } = fixture(t);
  const text = path.join(directory, "notes.txt");
  writeFileSync(text, "Recording notes");
  const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATHS: JSON.stringify([file, text]) }));
  await tty.waitFor("Playback requires native graphics");
  assert.match(tty.screen, /Paused.*00:00 \/ 00:02/);
  tty.clear();
  tty.send(" ");
  await tty.waitFor("o opens on viewer host");
  tty.clear();
  tty.send("\x1b[C");
  await tty.waitFor("00:02 / 00:02");
  assert.match(tty.screen, /1\/2/);
  tty.clear();
  tty.send("]");
  await tty.waitFor("Recording notes");
  tty.clear();
  tty.send("[");
  await tty.waitFor("00:02 / 00:02");
  tty.clear();
  tty.send("?");
  await tty.waitFor("Keyboard help");
  tty.send("q");
  assert.deepEqual(await tty.exit(), { exit: 0, canonical: true, echo: true });
});

test("native video playback streams changing frames and pauses for help and gallery navigation", { skip: !available || process.platform === "win32" }, async (t) => {
  const { file, directory } = fixture(t);
  const text = path.join(directory, "notes.txt");
  writeFileSync(text, "After video");
  const realFfmpeg = spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const pidLog = path.join(directory, "decoder-pids");
  const wrapper = path.join(directory, "ffmpeg");
  writeFileSync(wrapper, `#!/bin/sh\necho $$ >> ${JSON.stringify(pidLog)}\nexec ${JSON.stringify(realFfmpeg)} "$@"\n`);
  chmodSync(wrapper, 0o755);
  const pids = () => readFileSync(pidLog, "utf8").trim().split("\n").map(Number);
  const assertStopped = () => {
    for (const pid of pids()) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `decoder ${pid} should have exited`);
  };
  const socketPath = path.join(directory, "graphics.sock");
  const frames = [];
  const sockets = new Set();
  let clears = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let frame;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (frame) {
          if (buffer.length < frame.data_length) return;
          frames.push(Buffer.from(buffer.subarray(0, frame.data_length)));
          assert.ok(decodePng(frames.at(-1)).width <= 1280);
          buffer = buffer.subarray(frame.data_length);
          frame = undefined;
          continue;
        }
        const newline = buffer.indexOf(10);
        if (newline < 0) return;
        const request = JSON.parse(buffer.subarray(0, newline));
        buffer = buffer.subarray(newline + 1);
        if (request.format) { frame = request; continue; }
        if (request.method === "pane.graphics.clear") clears++;
        socket.write(`${JSON.stringify({ id: request.id, result: request.method === "pane.graphics.info" ? { cell_width_px: 9, cell_height_px: 18 } : {} })}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const tty = terminal(t, viewer, cleanEnv({ PATH: `${directory}${path.delimiter}${process.env.PATH}`, FILE_PREVIEW_PATHS: JSON.stringify([file, text]), HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "test:p1" }));
  await tty.waitFor("Paused");
  tty.clear();
  tty.send(" ");
  await tty.waitFor("Playing");
  await tty.waitFor("00:01 / 00:02");
  assert.ok(new Set(frames.map((frame) => frame.toString("base64"))).size > 2);
  tty.clear();
  tty.send("?");
  await tty.waitFor("Keyboard help");
  assertStopped();
  const beforeResize = pids().length;
  tty.clear();
  tty.resize(25, 90);
  await tty.waitFor("Keyboard help");
  assert.equal(pids().length, beforeResize, "help resize must not start an invisible decoder");
  tty.clear();
  tty.send("?");
  await tty.waitFor("Paused");
  assert.ok(clears >= 1);
  tty.clear();
  tty.send(".");
  await tty.waitFor("Paused");
  tty.clear();
  tty.resize(18, 65);
  await tty.waitFor("MP4");
  tty.clear();
  tty.send("]");
  await tty.waitFor("After video");
  assertStopped();
  tty.clear();
  tty.send("[");
  await tty.waitFor("Paused");
  tty.clear();
  tty.send(" ");
  await tty.waitFor("Playing");
  tty.send("q");
  assert.deepEqual(await tty.exit(), { exit: 0, canonical: true, echo: true });
  assertStopped();
  assert.ok(clears >= 2);
});
