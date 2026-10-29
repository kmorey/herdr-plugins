import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { TerminalInput } from "../src/terminal-input.mjs";

function capture(t) {
  const input = new TerminalInput();
  const bytes = [];
  input.on("data", (chunk) => bytes.push(Buffer.from(chunk)));
  t.after(() => input.destroy());
  return { input, bytes: () => Buffer.concat(bytes) };
}

// These tests catch protocol bytes reaching readline, lost keyboard bytes,
// premature flushing of split replies, and timers surviving stream destruction.
test("filters split APC and cell replies while emitting semantic events", async (t) => {
  const { input, bytes } = capture(t);
  const cells = [];
  const graphics = [];
  input.on("cell", (value) => cells.push(value));
  input.on("graphics", (value) => graphics.push(value));

  input.write(Buffer.from("find\x1b_"));
  input.write(Buffer.from("Gi=37,p=1;O"));
  input.write(Buffer.from("K\x1b"));
  input.write(Buffer.from("\\\x1b[6;18;"));
  input.write(Buffer.from("9t next"));
  input.end();
  await once(input, "end");

  assert.deepEqual(graphics, [{ id: 37, placementId: 1, message: "OK" }]);
  assert.deepEqual(cells, [{ width: 9, height: 18 }]);
  assert.equal(bytes().toString(), "find next");
});

test("preserves arrow and function key escape sequences byte for byte", async (t) => {
  const { input, bytes } = capture(t);
  const keys = Buffer.from("\x1b[A\x1b[B\x1b[C\x1b[D\x1bOP\x1b[15~\x1b[1;5D");
  for (const byte of keys) input.write(Buffer.from([byte]));
  input.end();
  await once(input, "end");
  assert.deepEqual(bytes(), keys);
});

test("preserves fragmented UTF-8 keyboard input without replacement characters", async (t) => {
  const { input, bytes } = capture(t);
  const keys = Buffer.from("café 日本 🐑");
  for (const byte of keys) input.write(Buffer.from([byte]));
  input.end();
  await once(input, "end");
  assert.deepEqual(bytes(), keys);
});

test("delivers standalone Escape before readline's escape-key delay", { timeout: 1000 }, async (t) => {
  const { input, bytes } = capture(t);
  const delivered = once(input, "data");
  input.write(Buffer.from("\x1b"));
  // A lost or indefinitely buffered ESC must fail rather than hang the runner.
  const result = await Promise.race([
    delivered.then(() => "delivered"),
    delay(180).then(() => "timeout"),
  ]);
  assert.equal(result, "delivered");
  assert.deepEqual(bytes(), Buffer.from("\x1b"));
});

test("retains recognized incomplete replies beyond the standalone Escape timeout", async (t) => {
  const { input, bytes } = capture(t);
  const graphics = [];
  input.on("graphics", (value) => graphics.push(value));
  input.write(Buffer.from("\x1b_Gi=91,p=1;late q"));
  await delay(100);
  assert.equal(bytes().length, 0, "reply payload must not become keyboard shortcuts");
  input.end(Buffer.from("\x1b\\search"));
  await once(input, "end");
  assert.deepEqual(graphics, [{ id: 91, placementId: 1, message: "late q" }]);
  assert.equal(bytes().toString(), "search");
});

for (const [name, prefix] of [
  ["APC payload", "\x1b_Gi=91,p=1;late qjkn"],
  ["APC escape", "\x1b_Gi=91;payload q\x1b"],
  ["oversized APC", "\x1b_Gi=91;" + "qjkn".repeat(2048)],
  ["cell CSI", "\x1b[6;18;"],
  ["attributes CSI", "\x1b[?1;"],
  ["oversized CSI", "\x1b[?" + "1;".repeat(4096)],
  ["keyboard CSI", "\x1b[1;"],
  ["Escape", "\x1b"],
]) {
  test(`Ctrl+C escapes an incomplete ${name} without replaying payload and restores keyboard input`, async (t) => {
    const { input, bytes } = capture(t);
    const graphics = [];
    input.on("graphics", (value) => graphics.push(value));
    input.write(Buffer.from(prefix));
    if (name.includes("APC")) {
      await delay(100);
      if (name !== "APC escape") input.write(Buffer.from("q"));
      assert.equal(bytes().length, 0, "an unterminated APC must not replay shortcut payload");
    }
    input.write(Buffer.from("\x03"));
    assert.deepEqual(bytes(), Buffer.from("\x03"), "deliver only the interrupt, not the partial reply");
    input.write(Buffer.from("q\x1b[A café"));
    await delay(100);
    input.end(Buffer.from("\x1b_Gi=92;OK\x1b\\"));
    await once(input, "end");
    assert.deepEqual(bytes(), Buffer.from("\x03q\x1b[A café"), "subsequent genuine keys survive, without a stale timer");
    assert.deepEqual(graphics, [{ id: 92, placementId: undefined, message: "OK" }]);
  });
}

test("filters unsolicited and late APC/DA replies interleaved with search text", async (t) => {
  const { input, bytes } = capture(t);
  const graphics = [];
  input.on("graphics", (value) => graphics.push(value));
  input.write(Buffer.from("/nee\x1b[?1;"));
  input.write(Buffer.from("2cdle\x1b_Gi=409,p=1;ENOENT:qjkn\x1b\\"));
  input.end(Buffer.from("\x1b_Gi=410;OK\x1b\\\r"));
  await once(input, "end");
  assert.equal(bytes().toString(), "/needle\r");
  assert.equal(graphics.length, 2);
  assert.deepEqual(graphics[0], { id: 409, placementId: 1, message: "ENOENT:qjkn" });
  assert.equal(graphics[1].id, 410);
  assert.equal(graphics[1].message, "OK");
});

test("discards oversized malformed protocol replies without injecting shortcuts", async (t) => {
  const { input, bytes } = capture(t);
  input.write(Buffer.from("before\x1b_Gi=not-an-id;"));
  const shortcuts = Buffer.from("qjkn".repeat(4096));
  for (let count = 0; count < 8; count++) input.write(shortcuts);
  input.write(Buffer.from("\x1b\\\x1b[?1;"));
  for (let count = 0; count < 8; count++) input.write(Buffer.from("2;".repeat(8192)));
  input.end(Buffer.from("2cafter"));
  await once(input, "end");
  assert.equal(bytes().toString(), "beforeafter");
});

test("flushes ordinary trailing bytes, including an unfinished keyboard escape prefix", async (t) => {
  const { input, bytes } = capture(t);
  input.end(Buffer.from("tail\x1b["));
  await once(input, "end");
  assert.deepEqual(bytes(), Buffer.from("tail\x1b["));
});

test("destroy clears pending Escape timers instead of leaving a delayed callback", (t) => {
  const active = new Set();
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds, ...args) => {
    const timer = schedule(() => {
      active.delete(timer);
      callback(...args);
    }, milliseconds);
    active.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    active.delete(timer);
    return cancel(timer);
  });
  // Ensure a failed assertion cannot leave a live timer in the test process.
  t.after(() => { for (const timer of active) cancel(timer); });
  const { input } = capture(t);
  input.write(Buffer.from("\x1b"));
  assert.ok(active.size > 0, "standalone Escape needs a delayed decision");
  input.destroy();
  assert.equal(active.size, 0, "destroy must cancel every pending Escape timer");
});
