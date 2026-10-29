import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

import { moveIndex, filePaths } from "../src/gallery.mjs";
import { openCurrentFile } from "../open-current.mjs";
import { currentFilePaths } from "../src/current-file.mjs";
import { decodePng, encodePng } from "../src/png.mjs";
import { fittedImageFrame, imagePlacement, openPaneGraphics } from "../src/herdr-graphics.mjs";
import { loadArtifact } from "../src/artifact.mjs";
import { truncateMiddle } from "../src/render.mjs";
import { TerminalInput } from "../src/terminal-input.mjs";

test("decodes a small RGBA PNG", () => {
  const png = makePng(2, 2, Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 128,
  ]));
  const image = decodePng(png);
  assert.equal(image.width, 2);
  assert.equal(image.height, 2);
  assert.deepEqual([...image.rgba], [
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 128,
  ]);
});

test("fits native graphics to the pane using terminal cell dimensions", () => {
  assert.deepEqual(
    imagePlacement(
      { width: 864, height: 934 },
      { columns: 105, rows: 56 },
      { width: 9, height: 18 },
    ),
    { viewport_col: 5, viewport_row: 3, grid_cols: 94, grid_rows: 51 },
  );
});

test("rasterizes the complete source image into Herdr's clipping placement", () => {
  const width = 1_800;
  const height = 1_250;
  const rgba = Buffer.alloc(width * height * 4, 255);
  const colors = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 0, 255],
  ];
  const sourceOffsets = [
    0,
    (width - 1) * 4,
    (height - 1) * width * 4,
    (width * height - 1) * 4,
  ];
  for (let index = 0; index < colors.length; index += 1) {
    rgba.set(colors[index], sourceOffsets[index]);
  }

  const frame = fittedImageFrame(
    { width, height, rgba },
    { columns: 58, rows: 50 },
    { width: 12, height: 24 },
  );

  assert.equal(frame.width, frame.placement.grid_cols * 12);
  assert.equal(frame.height, frame.placement.grid_rows * 24);
  assert.equal(frame.rgba.length, frame.width * frame.height * 4);
  const rendered = decodePng(encodePng(frame));
  const { x, y, width: contentWidth, height: contentHeight } = frame.content;
  const pixel = (column, row) => [...rendered.rgba.subarray((row * rendered.width + column) * 4, (row * rendered.width + column) * 4 + 4)];
  assert.deepEqual(pixel(x, y), colors[0], "top-left source edge is visible");
  assert.deepEqual(pixel(x + contentWidth - 1, y), colors[1], "top-right source edge is visible");
  assert.deepEqual(pixel(x, y + contentHeight - 1), colors[2], "bottom-left source edge is visible");
  assert.deepEqual(pixel(x + contentWidth - 1, y + contentHeight - 1), colors[3], "bottom-right source edge is visible");
});

test("resizes translucent pixels in premultiplied alpha space", () => {
  const frame = fittedImageFrame(
    {
      width: 2,
      height: 1,
      rgba: Buffer.from([
        255, 0, 0, 0,
        0, 0, 255, 255,
      ]),
    },
    { columns: 5, rows: 2 },
    { width: 1, height: 1 },
    { top: 0, bottom: 0 },
  );

  assert.deepEqual(
    [...frame.rgba.subarray(4, 8)],
    [0, 0, 255, 128],
    "transparent RGB does not bleed into the interpolated visible color",
  );
});

test("transmits PNG chunks, waits for the owned final ack, and deletes only the owned image", { timeout: 4000 }, async (t) => {
  const terminal = graphicsTerminal(t);
  const graphics = terminal.graphics = await openPaneGraphics(terminal);
  assert.deepEqual(graphics.cell, { width: 9, height: 18 });
  const query = terminal.commands.find((command) => command.a === "q");
  assert.ok(Number.isInteger(query.i) && query.i > 0);
  assert.equal(query.f, 32);
  assert.equal(query.s, 1);
  assert.equal(query.v, 1);
  assert.equal(Buffer.from(query.payload, "base64").length, 4, "query carries one RGBA pixel");
  assert.ok(terminal.cellQueries > 0, "requests cell metrics with CSI 16t");

  const png = makePng(64, 64, randomBytes(64 * 64 * 4));
  let settled = false;
  const rendered = graphics.renderPng(png, { width: 64, height: 64 }, {
    viewport_col: 1, viewport_row: 3, grid_cols: 7, grid_rows: 4,
  });
  rendered.then(() => { settled = true; }, () => { settled = true; });
  await waitUntil(() => terminal.frames.length === 1);
  const frame = terminal.frames[0];
  assert.ok(Number.isInteger(frame.command.i) && frame.command.i > 0);
  assert.equal(frame.command.a, "T");
  assert.equal(frame.command.f, 100);
  assert.equal(frame.command.p, 1);
  assert.equal(frame.command.C, 1);
  assert.equal(frame.command.q, 0);
  assert.equal(frame.command.c, 7);
  assert.equal(frame.command.r, 4);
  assert.deepEqual(frame.cursor, { row: 4, column: 2 });
  assert.ok(frame.chunks.length > 1, "large PNG is chunked");
  for (const [index, part] of frame.chunks.entries()) {
    assert.ok(part.payload.length > 0 && part.payload.length <= 4096);
    assert.match(part.payload, /^[A-Za-z0-9+/]*={0,2}$/);
    assert.equal(part.m, index === frame.chunks.length - 1 ? 0 : 1);
  }
  assert.deepEqual(Buffer.from(frame.chunks.map((part) => part.payload).join(""), "base64"), png);
  assert.equal(settled, false, "writing all chunks is not acknowledgment");
  terminal.reply(`\x1b_Gi=${frame.command.i + 1},p=1;OK\x1b\\`);
  await delay(20);
  assert.equal(settled, false, "another image's acknowledgment cannot finish this render");
  terminal.reply(`\x1b_Gi=${frame.command.i},p=1;OK\x1b\\`);
  await rendered;

  const deletionCount = terminal.commands.filter((command) => command.a === "d").length;
  await graphics.clear();
  await graphics.close();
  terminal.graphics = undefined;
  const deletions = terminal.commands.filter((command) => command.a === "d").slice(deletionCount);
  assert.ok(deletions.length >= 2, "clear and close each delete their owned image");
  for (const command of deletions) {
    assert.equal(command.d, "I");
    assert.equal(command.i, frame.command.i);
    assert.equal(command.q, 2);
  }
});

test("rejects persistently zero cell dimensions within the readiness deadline", { timeout: 3500 }, async (t) => {
  const terminal = graphicsTerminal(t, () => ({ width: 0, height: 0 }));
  await assert.rejects(openPaneGraphics(terminal), /cell|dimension|ready|timed? out/i);
  assert.ok(terminal.cellQueries >= 2, "zero sizes are retried, not accepted");
  assert.equal(terminal.commands.some((command) => command.a === "T"), false);
});

test("retries unanswered cell queries when Herdr metrics become ready", { timeout: 3500 }, async (t) => {
  const terminal = graphicsTerminal(t, (attempt) => attempt === 1 ? undefined : { width: 9, height: 18 });
  const graphics = terminal.graphics = await openPaneGraphics(terminal);
  assert.ok(terminal.cellQueries >= 2, "silence is retried rather than consuming the readiness deadline");
  assert.deepEqual(graphics.cell, { width: 9, height: 18 });
});

for (const failure of ["timeout", "abort", "rejection"]) {
  test(`a stalled PNG write stops its sender before cleanup after ${failure}`, { timeout: 4000 }, async (t) => {
    const terminal = graphicsTerminal(t);
    const graphics = terminal.graphics = await openPaneGraphics(terminal);
    let release;
    terminal.holdWrite = (bytes, callback) => {
      if (bytes.toString().startsWith("\x1b_Ga=T,")) { release = callback; return true; }
      return false;
    };
    const png = makePng(64, 64, randomBytes(64 * 64 * 4));
    const rendered = graphics.renderPng(png, { width: 64, height: 64 }, {
      viewport_col: 1, viewport_row: 3, grid_cols: 7, grid_rows: 4,
    });
    const rejected = assert.rejects(rendered, failure === "timeout" ? /timed out/ : failure === "abort" ? { code: "ABORT_ERR" } : /rejected/);
    await waitUntil(() => release !== undefined);
    const imageId = terminal.commands.find((command) => command.a === "T").i;
    if (failure === "abort") terminal.controller.abort();
    if (failure === "rejection") terminal.reply(`\x1b_Gi=${imageId},p=1;EINVAL: rejected\x1b\\`);
    await rejected;
    graphics.close();
    release();
    await delay(50);
    const chunks = terminal.commands.filter((command) => command.m !== undefined);
    assert.equal(chunks.length, 1, "a retired sender must not write continuation chunks");
    assert.equal(terminal.frames.length, 0, "never finish a retired image after cleanup");
    assert.equal(terminal.commands.at(-1).a, "d", "deletion is the last graphics command");
    assert.equal(terminal.commands.at(-1).i, imageId);
  });
}

test("retries zero cell sizes until usable metrics arrive", { timeout: 3500 }, async (t) => {
  const terminal = graphicsTerminal(t, (attempt) => attempt < 3
    ? { width: 0, height: 0 }
    : { width: 12, height: 24 });
  const graphics = terminal.graphics = await openPaneGraphics(terminal);
  assert.ok(terminal.cellQueries >= 3);
  assert.deepEqual(graphics.cell, { width: 12, height: 24 });
  assert.equal(terminal.commands.some((command) => command.a === "T"), false);
});

test("cancels readiness polling without transmitting or destroying the input stream", { timeout: 3500 }, async (t) => {
  const terminal = graphicsTerminal(t, () => ({ width: 0, height: 0 }));
  const pending = openPaneGraphics(terminal);
  // Attach the rejection assertion before aborting to avoid an unhandled rejection.
  const rejected = assert.rejects(pending, { code: "ABORT_ERR" });
  await waitUntil(() => terminal.cellQueries > 0);
  terminal.controller.abort();
  await rejected;
  const queries = terminal.cellQueries;
  await delay(120);
  assert.equal(terminal.cellQueries, queries, "abort stops retry timers");
  assert.equal(terminal.commands.some((command) => command.a === "T"), false);
  assert.equal(terminal.input.destroyed, false);
  assert.equal(terminal.output.destroyed, false);
  terminal.reply("\x1b[6;18;9t\x1b_Gi=999,p=1;OK\x1b\\still searching");
  assert.equal(Buffer.concat(terminal.keyboard).toString(), "still searching");
});

test("truncates long paths through the middle", () => {
  assert.equal(truncateMiddle("/a/very/long/path/proof.png", 15), "/a/very…oof.png");
});

test("accepts a JSON gallery while preserving single-path compatibility", () => {
  assert.deepEqual(
    filePaths({ pathsJson: JSON.stringify([path.resolve("one.png"), path.resolve("two.png")]) }),
    [path.resolve("one.png"), path.resolve("two.png")],
  );
  assert.deepEqual(filePaths({ singlePath: path.resolve("one.png") }), [path.resolve("one.png")]);
});

test("rejects malformed or empty galleries", () => {
  assert.throws(() => filePaths({ pathsJson: "not-json" }), /JSON array/);
  assert.throws(() => filePaths({ pathsJson: "[]" }), /no file paths/);
  assert.throws(() => filePaths({ pathsJson: '["/tmp/one.png",null]' }), /non-empty string/);
});

test("gallery navigation wraps in both directions", () => {
  assert.equal(moveIndex(0, 3, 1), 1);
  assert.equal(moveIndex(2, 3, 1), 0);
  assert.equal(moveIndex(0, 3, -1), 2);
});


test("selects current gallery media from pane output", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "herdr-current-file-test-"));
  const firstPath = path.join(directory, "first.png");
  const secondPath = path.join(directory, "second.png");
  writeFileSync(firstPath, "first");
  writeFileSync(secondPath, "second");

  try {
    assert.deepEqual(currentFilePaths(`${firstPath}\n${secondPath}`), [firstPath, secondPath]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("opens the current file beside the action pane", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "herdr-current-file-test-"));
  const proofPath = path.join(directory, "proof.png");
  writeFileSync(proofPath, "proof");
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "pane" && args[1] === "get") {
      return {
        status: 0,
        stdout: JSON.stringify({
          result: { pane: { pane_id: "w1:p2", cwd: "/worktree" } },
        }),
        stderr: "",
      };
    }
    if (args[0] === "pane" && args[1] === "read") {
      return { status: 0, stdout: `Current files\n${proofPath}\n`, stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  try {
    assert.equal(openCurrentFile({
      environment: {
        HERDR_BIN_PATH: "/test/herdr",
        HERDR_PANE_ID: "w1:p2",
        HERDR_PLUGIN_ID: "kmorey.file-preview",
      },
      spawn,
    }), 0);
    assert.deepEqual(calls[0].args, ["pane", "get", "w1:p2"]);
    assert.deepEqual(calls[1].args, [
      "pane", "read", "w1:p2", "--source", "recent-unwrapped",
      "--lines", "500", "--format", "ansi",
    ]);
    assert.deepEqual(calls[2].args, [
      "plugin", "pane", "open",
      "--plugin", "kmorey.file-preview",
      "--entrypoint", "viewer",
      "--placement", "split",
      "--target-pane", "w1:p2",
      "--direction", "right",
      "--env", `FILE_PREVIEW_PATHS=[${JSON.stringify(proofPath)}]`,
      "--focus",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("notifies instead of opening a viewer when no current file exists", () => {
  const calls = [];
  let errorOutput = "";
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "pane" && args[1] === "get") {
      return {
        status: 0,
        stdout: JSON.stringify({
          result: { pane: { pane_id: "w1:p2", cwd: "/worktree" } },
        }),
        stderr: "",
      };
    }
    return { status: 0, stdout: "No proof here\n", stderr: "" };
  };

  assert.equal(openCurrentFile({
    environment: {
      HERDR_BIN_PATH: "/test/herdr",
      HERDR_PANE_ID: "w1:p2",
      HERDR_PLUGIN_ID: "kmorey.file-preview",
    },
    spawn,
    stderr: { write: (value) => { errorOutput += value; } },
  }), 1);
  assert.deepEqual(calls[2].args, [
    "notification", "show", "File preview unavailable",
    "--body", "No current PNG or MP4 file was found in the focused pane.",
    "--sound", "none",
  ]);
  assert.match(errorOutput, /No current PNG or MP4 file/);
});

test("validates a real PNG artifact", () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "herdr-proof-test-")));
  const proofPath = path.join(directory, "proof.png");
  writeFileSync(proofPath, makePng(2, 1, Buffer.from([
    255, 128, 0, 255, 20, 30, 40, 255,
  ])));
  const proof = loadArtifact(proofPath);
  assert.equal(proof.path, proofPath);
  assert.equal(proof.image.width, 2);
  assert.equal(proof.image.height, 1);
  assert.equal(proof.data.length, proof.bytes);
  assert.deepEqual([...proof.image.rgba], [255, 128, 0, 255, 20, 30, 40, 255]);
});

test("rejects non-PNG input", () => {
  assert.throws(() => decodePng(Buffer.from("not a png")), /not a PNG|invalid PNG signature/);
});

// The terminal double lives below the real graphics code and TerminalInput:
// it consumes actual output bytes and replies through the real Transform.
// Render acknowledgments are deliberately held for the test to deliver.
function graphicsTerminal(t, cell = () => ({ width: 9, height: 18 })) {
  const input = new TerminalInput();
  const controller = new AbortController();
  const terminal = {
    input, controller, signal: controller.signal,
    commands: [], frames: [], cellQueries: 0, keyboard: [],
    reply(bytes) { if (!input.destroyed) input.write(Buffer.from(bytes)); },
  };
  input.on("data", (bytes) => terminal.keyboard.push(Buffer.from(bytes)));
  let pending = "";
  let cursor = { row: 1, column: 1 };
  let frame;
  const observe = (bytes) => {
    pending += bytes.toString("ascii");
    while (pending) {
      const escape = pending.indexOf("\x1b");
      if (escape < 0) { pending = ""; return; }
      pending = pending.slice(escape);
      if (pending.length < 2) return;
      if (pending.startsWith("\x1b_")) {
        const end = pending.indexOf("\x1b\\", 2);
        if (end < 0) return;
        const body = pending.slice(2, end);
        pending = pending.slice(end + 2);
        if (!body.startsWith("G")) continue;
        const separator = body.indexOf(";");
        const header = body.slice(1, separator < 0 ? undefined : separator);
        const command = Object.fromEntries(header.split(",").filter(Boolean).map((field) => {
          const [key, value] = field.split("=");
          return [key, /^\d+$/.test(value) ? Number(value) : value];
        }));
        command.payload = separator < 0 ? "" : body.slice(separator + 1);
        terminal.commands.push(command);
        if (command.a === "q") {
          queueMicrotask(() => terminal.reply(`\x1b_Gi=${command.i};OK\x1b\\`));
        } else if (command.a === "T" || (frame && command.a !== "d")) {
          if (!frame) frame = { command, cursor: { ...cursor }, chunks: [] };
          frame.chunks.push(command);
          if (command.m === 0) {
            terminal.frames.push(frame);
            frame = undefined;
          }
        }
      } else if (pending.startsWith("\x1b[")) {
        const match = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(pending);
        if (!match) return;
        const [, parameters, , final] = match;
        if (final === "H" || final === "f") {
          const [row, column] = parameters.split(";").map(Number);
          cursor = { row: row || 1, column: column || 1 };
        } else if (final === "t" && parameters === "16") {
          const dimensions = cell(++terminal.cellQueries);
          if (dimensions) queueMicrotask(() => terminal.reply(`\x1b[6;${dimensions.height};${dimensions.width}t`));
        }
        pending = pending.slice(match[0].length);
      } else pending = pending.slice(2);
    }
  };
  terminal.output = new Writable({
    write(bytes, encoding, callback) {
      try {
        observe(bytes);
        if (!terminal.holdWrite?.(bytes, callback)) callback();
      }
      catch (error) { callback(error); }
    },
  });
  t.after(async () => {
    try { await terminal.graphics?.close(); }
    finally {
      controller.abort();
      input.destroy();
      terminal.output.destroy();
    }
  });
  return terminal;
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "terminal did not receive expected protocol bytes");
    await delay(5);
  }
}

function makePng(width, height, rgba) {
  const rows = [];
  for (let row = 0; row < height; row += 1) {
    rows.push(Buffer.from([0]), rgba.subarray(row * width * 4, (row + 1) * width * 4));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
  return output;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
