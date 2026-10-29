import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { currentFilePaths } from "../src/current-file.mjs";

test("collects the latest three distinct parenthesized media paths in encounter order", (t) => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "herdr-current-file-test-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const stale = path.join(directory, "stale.png");
  const first = path.join(directory, "ios-iphone17-athens-acropolis-comparison-full-photo.png");
  const second = path.join(directory, "ios-iphone17-athens-acropolis-after-anchor.png");
  const third = path.join(directory, "ios-iphone17-athens-acropolis-baseline-replay.png");
  const empty = path.join(directory, "empty.png");
  for (const file of [stale, first, second, third]) writeFileSync(file, "media");
  writeFileSync(empty, "");

  const output = [
    "Earlier render:",
    `  (${stale})`,
    "Comparison full photo:",
    `  (${first})`,
    "Repeated reference:",
    `  (${first})`,
    "After anchor:",
    `  (${second})`,
    "Missing image:",
    `  (${path.join(directory, "missing.png")})`,
    "Empty image:",
    `  (${empty})`,
    "Baseline replay:",
    `  (${third})`,
  ].join("\n");

  assert.deepEqual(currentFilePaths(output), [first, second, third]);
});

test("keeps a single MP4 path available", (t) => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "herdr-current-file-test-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const recording = path.join(directory, "recording.mp4");
  writeFileSync(recording, "media");

  assert.deepEqual(currentFilePaths(`Recording:\n  (${recording})`), [recording]);
});
