import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

import { openCurrentProof } from "../open-current.mjs";
import { currentProofPaths } from "../src/current-proof.mjs";
import { moveIndex, proofPaths } from "../src/gallery.mjs";
import { decodePng } from "../src/png.mjs";
import { imagePlacement, openPaneGraphics } from "../src/herdr-graphics.mjs";
import { loadProof } from "../src/proof.mjs";
import { renderPreview, targetSize, truncateMiddle } from "../src/render.mjs";

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

test("renders a true-color half-block preview", () => {
  const image = {
    width: 1,
    height: 2,
    rgba: Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]),
  };
  assert.equal(renderPreview(image, 20, 10), "\x1b[38;2;255;0;0m\x1b[48;2;0;0;255m▀\x1b[0m");
});

test("fits the preview within terminal columns and pixel rows", () => {
  assert.deepEqual(targetSize(1920, 1080, 82, 30), { width: 80, height: 45 });
  assert.deepEqual(targetSize(10, 10, 100, 100), { width: 10, height: 10 });
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

test("streams the original PNG through the Herdr pane graphics protocol", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "herdr-graphics-test-"));
  const socketPath = path.join(directory, "herdr.sock");
  const png = Buffer.from("png bytes");
  let connection = 0;
  let receivedFrame;
  const frameReceived = new Promise((resolve) => {
    receivedFrame = resolve;
  });
  const server = net.createServer((socket) => {
    connection += 1;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline === -1) return;
      const message = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      if (connection === 1) {
        assert.equal(message.method, "pane.graphics.info");
        socket.write(`${JSON.stringify({ id: message.id, result: {
          type: "pane_graphics_info",
          cell_width_px: 9,
          cell_height_px: 18,
          pane_visible: true,
        } })}\n`);
        return;
      }
      if (message.method === "pane.graphics.stream") {
        assert.equal(message.params.pane_id, "w1:p2");
        socket.write(`${JSON.stringify({ id: message.id, result: { type: "ok" } })}\n`);
        buffer = buffer.subarray(newline + 1);
        return;
      }
      const dataStart = newline + 1;
      if (buffer.length - dataStart < message.data_length) return;
      receivedFrame({ header: message, data: buffer.subarray(dataStart) });
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const graphics = await openPaneGraphics({ socketPath, paneId: "w1:p2" });
    assert.deepEqual(graphics.cell, { width: 9, height: 18 });
    graphics.renderPng(png, { width: 2, height: 1 }, {
      viewport_col: 1,
      viewport_row: 3,
      grid_cols: 2,
      grid_rows: 1,
    });
    const frame = await frameReceived;
    assert.equal(frame.header.format, "png");
    assert.equal(frame.header.image_width, 2);
    assert.deepEqual(frame.data, png);
    graphics.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("truncates long paths through the middle", () => {
  assert.equal(truncateMiddle("/a/very/long/path/proof.png", 15), "/a/very…oof.png");
});

test("accepts a JSON gallery while preserving single-path compatibility", () => {
  assert.deepEqual(
    proofPaths({ pathsJson: '["/tmp/one.png","/tmp/two.png"]' }),
    ["/tmp/one.png", "/tmp/two.png"],
  );
  assert.deepEqual(proofPaths({ singlePath: "/tmp/one.png" }), ["/tmp/one.png"]);
});

test("rejects malformed or empty galleries", () => {
  assert.throws(() => proofPaths({ pathsJson: "not-json" }), /JSON array/);
  assert.throws(() => proofPaths({ pathsJson: "[]" }), /no visual proof paths/);
  assert.throws(() => proofPaths({ pathsJson: '["/tmp/one.png",null]' }), /non-empty string/);
});

test("gallery navigation wraps in both directions", () => {
  assert.equal(moveIndex(0, 3, 1), 1);
  assert.equal(moveIndex(2, 3, 1), 0);
  assert.equal(moveIndex(0, 3, -1), 2);
});

test("finds the latest visual proof gallery in pane output", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "herdr-current-proof-test-"));
  const olderPath = path.join(directory, "older.png");
  const firstPath = path.join(directory, "proof one.png");
  const secondPath = path.join(directory, "proof-two.png");
  writeFileSync(olderPath, "older");
  writeFileSync(firstPath, "first");
  writeFileSync(secondPath, "second");

  try {
    const output = [
      "Visual Proof",
      olderPath,
      "Summary",
      "Visual Proof",
      `\x1b]8;;${pathToFileURL(firstPath).href}\x07First\x1b]8;;\x07`,
      `[Second](${secondPath})`,
    ].join("\n");
    assert.deepEqual(currentProofPaths(output), [firstPath, secondPath]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("finds galleries under common visual proof heading variants", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "herdr-current-proof-test-"));
  const firstPath = path.join(directory, "first.png");
  const secondPath = path.join(directory, "second.png");
  writeFileSync(firstPath, "first");
  writeFileSync(secondPath, "second");

  try {
    for (const heading of [
      "Visual Proof:",
      "### Visual Proof:",
      "Visual proof files",
      "**Visual proofs:**",
      "Visual proof — desktop and mobile",
    ]) {
      assert.deepEqual(
        currentProofPaths(`${heading}\n${firstPath}\n${secondPath}`),
        [firstPath, secondPath],
        heading,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("falls back to the most recent PNG when there is no proof heading", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "herdr-current-proof-test-"));
  const firstPath = path.join(directory, "first.png");
  const secondPath = path.join(directory, "second.png");
  writeFileSync(firstPath, "first");
  writeFileSync(secondPath, "second");

  try {
    assert.deepEqual(currentProofPaths(`${firstPath}\n${secondPath}`), [secondPath]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("opens the current proof beside the action pane", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "herdr-current-proof-test-"));
  const proofPath = path.join(directory, "proof.png");
  writeFileSync(proofPath, "proof");
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "pane" && args[1] === "read") {
      return { status: 0, stdout: `Visual Proof\n${proofPath}\n`, stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  try {
    assert.equal(openCurrentProof({
      environment: {
        HERDR_BIN_PATH: "/test/herdr",
        HERDR_PANE_ID: "w1:p2",
        HERDR_PLUGIN_ID: "kmorey.visual-proof",
      },
      spawn,
    }), 0);
    assert.deepEqual(calls[0].args, [
      "pane", "read", "w1:p2", "--source", "recent-unwrapped",
      "--lines", "500", "--format", "ansi",
    ]);
    assert.deepEqual(calls[1].args, [
      "plugin", "pane", "open",
      "--plugin", "kmorey.visual-proof",
      "--entrypoint", "viewer",
      "--placement", "split",
      "--target-pane", "w1:p2",
      "--direction", "right",
      "--env", `VISUAL_PROOF_PATHS=[${JSON.stringify(proofPath)}]`,
      "--focus",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("notifies instead of opening a viewer when no current proof exists", () => {
  const calls = [];
  let errorOutput = "";
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: "No proof here\n", stderr: "" };
  };

  assert.equal(openCurrentProof({
    environment: {
      HERDR_BIN_PATH: "/test/herdr",
      HERDR_PANE_ID: "w1:p2",
      HERDR_PLUGIN_ID: "kmorey.visual-proof",
    },
    spawn,
    stderr: { write: (value) => { errorOutput += value; } },
  }), 1);
  assert.deepEqual(calls[1].args, [
    "notification", "show", "Visual proof unavailable",
    "--body", "No current PNG visual proof was found in the focused pane.",
    "--sound", "none",
  ]);
  assert.match(errorOutput, /No current PNG visual proof/);
});

test("validates a real proof path", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "herdr-proof-test-"));
  const proofPath = path.join(directory, "proof.png");
  writeFileSync(proofPath, makePng(2, 1, Buffer.from([
    255, 128, 0, 255, 20, 30, 40, 255,
  ])));
  const proof = loadProof(proofPath);
  assert.equal(proof.path, proofPath);
  assert.equal(proof.image.width, 2);
  assert.equal(proof.image.height, 1);
  assert.equal(proof.data.length, proof.bytes);
  assert.deepEqual([...proof.image.rgba], [255, 128, 0, 255, 20, 30, 40, 255]);
});

test("rejects non-PNG input", () => {
  assert.throws(() => decodePng(Buffer.from("not a png")), /not a PNG|invalid PNG signature/);
});

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
