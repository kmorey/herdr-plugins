import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { decodePng } from "../src/png.mjs";
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

test("truncates long paths through the middle", () => {
  assert.equal(truncateMiddle("/a/very/long/path/proof.png", 15), "/a/very…oof.png");
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
