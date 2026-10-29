import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadArtifact, inspectArtifact } from "../src/artifact.mjs";
import { currentFilePaths } from "../src/current-file.mjs";
import { decodePng } from "../src/png.mjs";
import { pngFrames, VideoDecoder } from "../src/video.mjs";
import { terminal } from "./support/terminal.mjs";

const available = ["ffmpeg", "ffprobe"].every((command) => spawnSync(command, ["-version"]).status === 0);
const viewer = fileURLToPath(new URL("../viewer.mjs", import.meta.url));

function fixture(t, filters = [], source = "testsrc2=size=160x90:rate=10:duration=2") {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "video-preview-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "sample video.MP4");
  const result = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", source, ...filters, "-c:v", "mpeg4", "-threads", "1", file]);
  assert.equal(result.status, 0, result.stderr.toString());
  return { directory, file };
}

function cleanEnv(extra = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HERDR_|FILE_PREVIEW_)/.test(key))), ...extra };
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
  assert.deepEqual(currentFilePaths(`Current files\n${png}\n[Recording](${pathToFileURL(file).href})`), [png, file]);
  assert.deepEqual(currentFilePaths(`Recording: <${file}>`), [file]);
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

test("video without graphics reports an unavailable preview, retains position, and restores terminal", { skip: !available || process.platform === "win32" }, async (t) => {
  const { file, directory } = fixture(t);
  const text = path.join(directory, "notes.txt");
  writeFileSync(text, "Recording notes");
  const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATHS: JSON.stringify([file, text]) }));
  await tty.waitFor("Playback requires native graphics");
  assert.match(tty.screen, /Preview unavailable/);
  assert.doesNotMatch(tty.screen, /▀|ANSI fallback/);
  assert.match(tty.screen, /Paused.*00:00 \/ 00:02/);
  tty.clear();
  tty.send(" ");
  await tty.waitFor("o opens on viewer host");
  tty.clear();
  tty.send("\x1b[C");
  await tty.waitFor("00:02 / 00:02");
  assert.doesNotMatch(tty.screen, /▀|ANSI fallback/);
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

for (const playing of [false, true]) {
  test(`native video resize renegotiates decode dimensions and preserves ${playing ? "playing" : "paused"} position`, { skip: !available || process.platform === "win32" }, async (t) => {
    const { file } = fixture(t, [], "testsrc2=size=640x360:rate=10:duration=12");
    const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATHS: JSON.stringify([file]) }), undefined, { kitty: {} });
    const { frames } = tty.graphics;
    const dimensions = (frame) => {
      const { width, height } = decodePng(frame.data);
      return { width, height };
    };
    await tty.waitForGraphics(() => frames.length > 0);
    await tty.waitFor("Paused");
    assert.deepEqual(dimensions(frames.at(-1)), { width: 608, height: 342 });
    tty.clear();
    tty.send("\x1b[C");
    await tty.waitFor("00:05 / 00:12");
    if (playing) {
      tty.clear();
      tty.send(" ");
      await tty.waitFor("Playing");
    }
    const beforeResize = frames.length;
    const beforeCells = tty.graphics.cellQueries;
    tty.clear();
    tty.resize(18, 65);
    await tty.waitFor(playing ? "Playing" : "Paused");
    // A playing restart can initially display its cached old-size frame. Wait
    // for a newly decoded size, then assert actual PNG pixels, not placement.
    const newlySized = () => frames.slice(beforeResize).find((frame) => dimensions(frame).height !== 342);
    await tty.waitForGraphics(() => newlySized());
    assert.deepEqual(dimensions(newlySized()), { width: 416, height: 234 }, "fit 16:9 video into 63×13 cells of 9×18 pixels");
    assert.ok(tty.graphics.cellQueries > beforeCells, "resize reacquires cell dimensions");
    assert.match(tty.screen, playing ? /Playing.*00:05 \/ 00:12/ : /Paused.*00:05 \/ 00:12/, "resize does not reset position or playback state");
    if (!playing) {
      await delay(150);
      const pausedFrames = frames.length;
      await delay(150);
      assert.equal(frames.length, pausedFrames, "resize must not start paused playback");
      const beforeHelp = frames.length;
      tty.clear();
      tty.send("?");
      await tty.waitFor("Keyboard help");
      tty.clear();
      tty.resize(20, 70);
      await tty.waitFor("Keyboard help");
      assert.equal(frames.length, beforeHelp, "help resize must not display an invisible video");
      tty.clear();
      tty.send("?");
      await tty.waitFor("Paused");
      await tty.waitForGraphics(() => frames.length > beforeHelp);
      // 15 body rows × 18 pixels = 270; 16:9 fits at 480×270.
      assert.deepEqual(dimensions(frames.at(-1)), { width: 480, height: 270 }, "help restoration negotiates before restarting the decoder");
      assert.match(tty.screen, /Paused.*00:05 \/ 00:12/);
    } else {
      const restartedFrames = frames.length;
      await tty.waitForGraphics(() => frames.length > restartedFrames + 1);
      assert.deepEqual(dimensions(frames.at(-1)), { width: 416, height: 234 }, "resized playback continues with full-resolution frames");
    }
    tty.send("q");
    assert.deepEqual(await tty.exit(), { exit: 0, canonical: true, echo: true });
  });
}

test("native video transmits changing Kitty frames, pauses, seeks, and cleans up for help and gallery navigation", { skip: !available || process.platform === "win32" }, async (t) => {
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
  const tty = terminal(t, viewer, cleanEnv({ PATH: `${directory}${path.delimiter}${process.env.PATH}`, FILE_PREVIEW_PATHS: JSON.stringify([file, text]) }), undefined, { kitty: {} });
  const { frames, deletions } = tty.graphics;
  await tty.waitForGraphics(() => frames.length > 0);
  await tty.waitFor("Paused");
  assert.ok(tty.graphics.queries.length > 0);
  const initial = frames[0];
  // Captured CSI coordinates are 1-based; the final occupied cell is inclusive.
  assert.ok(initial.placement.column >= 2 && initial.placement.column + initial.command.c - 1 <= 99);
  assert.ok(initial.placement.row >= 4 && initial.placement.row + initial.command.r - 1 <= 22);
  const assertOwnedDelete = () => {
    assert.ok(deletions.length > 0, "delete the displayed video image");
    const owned = new Set(frames.map((frame) => frame.command.i));
    for (const command of deletions) {
      assert.equal(command.d, "I");
      assert.equal(command.q, 2);
      assert.ok(owned.has(command.i), "only the viewer's own images may be deleted");
    }
    assert.equal(deletions.at(-1).i, frames.at(-1).command.i);
  };
  tty.clear();
  tty.send(" ");
  await tty.waitFor("Playing");
  await tty.waitFor("00:01 / 00:02");
  assert.ok(new Set(frames.map((frame) => frame.data.toString("base64"))).size > 2);
  assert.ok(frames.some((frame) => frame.chunks.length > 1), "video PNGs exercise chunked transfer");
  tty.clear();
  tty.send(" ");
  await tty.waitFor("Paused");
  await delay(150);
  const pausedFrames = frames.length;
  await delay(150);
  assert.equal(frames.length, pausedFrames, "paused video must not keep transmitting frames");
  assertStopped();
  tty.clear();
  tty.send("\x1b[C");
  await tty.waitFor("00:02 / 00:02");
  assert.match(tty.screen, /Paused/);
  tty.clear();
  tty.send("\x1b[D");
  await tty.waitFor("00:00 / 00:02");
  const beforeHelp = deletions.length;
  tty.clear();
  tty.send("?");
  await tty.waitFor("Keyboard help");
  assertStopped();
  assert.ok(deletions.length > beforeHelp);
  assertOwnedDelete();
  const beforeHelpResize = pids().length;
  tty.clear();
  tty.resize(25, 90);
  await tty.waitFor("Keyboard help");
  assert.equal(pids().length, beforeHelpResize, "help resize must not start an invisible decoder");
  const beforeRestore = frames.length;
  tty.clear();
  tty.send("?");
  await tty.waitFor("Paused");
  await tty.waitForGraphics(() => frames.length > beforeRestore);
  const beforeStep = frames.length;
  const stepOrigin = frames.at(-1).data;
  tty.clear();
  tty.send(".");
  await tty.waitFor("Paused");
  await tty.waitForGraphics(() => frames.length > beforeStep);
  assert.notDeepEqual(frames.at(-1).data, stepOrigin, "single-frame step advances the decoded image");
  const beforeResize = frames.length;
  tty.clear();
  tty.resize(18, 65);
  await tty.waitFor("MP4");
  await tty.waitForGraphics(() => frames.length > beforeResize);
  const resized = frames.at(-1);
  const rendered = decodePng(resized.data);
  assert.ok(rendered.width <= 63 * 9 && rendered.height <= 13 * 18);
  assert.ok(resized.placement.column >= 2 && resized.placement.column + resized.command.c - 1 <= 64);
  assert.ok(resized.placement.row >= 4 && resized.placement.row + resized.command.r - 1 <= 16);
  const pausedPosition = /00:\d{2} \/ 00:02/.exec(tty.screen)[0];
  const beforeGallery = deletions.length;
  tty.clear();
  tty.send("]");
  await tty.waitFor("After video");
  assertStopped();
  assert.ok(deletions.length > beforeGallery);
  assertOwnedDelete();
  const beforeReturn = frames.length;
  tty.clear();
  tty.send("[");
  await tty.waitFor("Paused");
  await tty.waitForGraphics(() => frames.length > beforeReturn);
  assert.ok(decodePng(frames.at(-1).data).width > 0, "gallery return re-transmits a valid PNG");
  assert.ok(tty.screen.includes(pausedPosition), "gallery return preserves the paused playback position");
  tty.clear();
  tty.send(" ");
  await tty.waitFor("Playing");
  tty.send("q");
  assert.deepEqual(await tty.exit(), { exit: 0, canonical: true, echo: true });
  assertStopped();
  assertOwnedDelete();
  for (const frame of frames) {
    const image = decodePng(frame.data);
    assert.ok(image.width > 0 && image.width <= 1280 && image.height > 0);
    assert.ok(frame.placement.column >= 2 && frame.placement.column + frame.command.c - 1 <= 99);
    assert.ok(frame.placement.row >= 4 && frame.placement.row + frame.command.r - 1 <= 23);
    assert.equal(frame.command.p, 1);
    assert.equal(frame.command.C, 1);
  }
});
