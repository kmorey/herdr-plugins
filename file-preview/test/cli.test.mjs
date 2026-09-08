import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { terminal } from "./support/terminal.mjs";

const viewer = fileURLToPath(new URL("../viewer.mjs", import.meta.url));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");

function fixtures(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "file-preview-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const image = path.join(directory, "proof.png");
  writeFileSync(image, png);
  return { directory, image };
}

function cleanEnv(env = {}) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (/^(FILE_PREVIEW_|VISUAL_PROOF_|HERDR_)/.test(key)) delete clean[key];
  }
  return { ...clean, ...env };
}

function run(env = {}, args = ["--inspect"]) {
  return spawnSync(process.execPath, [viewer, ...args], {
    env: cleanEnv(env), encoding: "utf8", timeout: 5000,
  });
}

test("inspect accepts new gallery inputs ahead of legacy values and identifies PNGs", (t) => {
  const { image } = fixtures(t);
  const result = run({ FILE_PREVIEW_PATHS: JSON.stringify([image, image]), VISUAL_PROOF_PATH: "/missing.png" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { path: image, type: "png", bytes: png.length, width: 1, height: 1 });
});

test("users scroll text, resize, navigate a mixed gallery, copy a path, and close cleanly", { skip: process.platform === "win32" }, async (t) => {
  const { image, directory } = fixtures(t);
  const text = path.join(directory, "notes.txt");
  writeFileSync(text, Array.from({ length: 60 }, (_, n) => `Report line ${n + 1}`).join("\n"));
  const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATHS: JSON.stringify([text, image]) }));
  await tty.waitFor("Report line 1");
  assert.doesNotMatch(tty.screen, /Report line 60/);
  tty.clear();
  tty.send("\x1b[F");
  await tty.waitFor("Report line 60");
  tty.clear();
  tty.resize(12, 60);
  await tty.waitFor("Report line 42");
  tty.clear();
  tty.send("l");
  await tty.waitFor("proof.png");
  assert.match(tty.screen, /2\/2/);
  assert.doesNotMatch(tty.screen, /Report line/);
  tty.clear();
  tty.send("y");
  await tty.waitFor(`\x1b]52;c;${Buffer.from(image).toString("base64")}\x07`);
  tty.send("q");
  assert.deepEqual(await tty.exit(), { exit: 0, canonical: true, echo: true });
  assert.match(tty.output, /\x1b\[\?25h/);
});

test("inspect reads mixed PNG and text galleries without a terminal", (t) => {
  const { image, directory } = fixtures(t);
  const text = path.join(directory, "notes.txt");
  writeFileSync(text, "First line\nSecond line\n");
  const result = run({ FILE_PREVIEW_PATHS: JSON.stringify([image, text]) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { files: [
    { path: image, type: "png", bytes: png.length, width: 1, height: 1 },
    { path: text, type: "text", bytes: 23, lines: 3 },
  ] });
});

test("Markdown reports render structure and toggle to original source", { skip: process.platform === "win32" }, async (t) => {
  const { directory } = fixtures(t);
  const file = path.join(directory, "REPORT.md");
  writeFileSync(file, "# Comparison results\n\n**All checks passed** with *emphasis*.\n\n- [Report](https://example.com/report)\n\n```js\nconst count = 98;\n```\n");
  const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATH: file }));
  await tty.waitFor("Comparison results");
  assert.doesNotMatch(tty.screen, /# Comparison results|\*\*All checks passed\*\*|```/);
  assert.match(tty.screen, /Report.*https:\/\/example.com\/report/);
  assert.match(tty.screen, /const count = 98;/);
  tty.clear();
  tty.send("s");
  await tty.waitFor("# Comparison results");
  assert.match(tty.screen, /\*\*All checks passed\*\*/);
  tty.send("q");
  assert.equal((await tty.exit()).exit, 0);
  assert.equal(JSON.parse(run({ FILE_PREVIEW_PATH: file }).stdout).type, "markdown");
});

test("JSON formatting preserves exact numeric and string tokens; malformed JSON remains readable", (t) => {
  const { directory } = fixtures(t);
  const file = path.join(directory, "comparison.json");
  writeFileSync(file, '{"id":9007199254740993,"amount":0.1234567890123456789,"nested":[true,null,{"quote":"a\\\"b","empty":{}}]}');
  const result = run({ FILE_PREVIEW_PATH: file }, []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /  "id": 9007199254740993,\n  "amount": 0\.1234567890123456789,/);
  assert.match(result.stdout, /"quote": "a\\"b"/);
  assert.equal(JSON.parse(run({ FILE_PREVIEW_PATH: file }).stdout).type, "json");
  writeFileSync(file, '{"broken": }');
  const malformed = run({ FILE_PREVIEW_PATH: file }, []);
  assert.equal(malformed.status, 0, malformed.stderr);
  assert.match(malformed.stdout, /Invalid JSON/);
  assert.match(malformed.stdout, /\{"broken": \}/);
  assert.match(JSON.parse(run({ FILE_PREVIEW_PATH: file }).stdout).diagnostic, /Invalid JSON/);
});

test("search finds literal matches beyond the viewport and isolates query input from shortcuts", { skip: process.platform === "win32" }, async (t) => {
  const { directory, image } = fixtures(t);
  const file = path.join(directory, "search.txt");
  writeFileSync(file, `${"Ordinary line\n".repeat(40)}First qoy[.] result\nSecond qoy[.] result`);
  const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATHS: JSON.stringify([file, image]) }));
  await tty.waitFor("Ordinary line");
  tty.clear();
  tty.send("/qoy[.]\r");
  await tty.waitFor("Match 1/2");
  assert.match(tty.screen, /First qoy\[\.\] result/);
  assert.doesNotMatch(tty.output, /\x1b\]52;|Opening on viewer host/);
  tty.clear();
  tty.send("n");
  await tty.waitFor("Match 2/2");
  tty.clear();
  tty.send("N");
  await tty.waitFor("Match 1/2");
  tty.clear();
  tty.send("/missing\r");
  await tty.waitFor("No matches");
  tty.clear();
  tty.send("/cancel\x1b");
  await tty.waitFor("No matches");
  tty.clear();
  tty.send("l");
  await tty.waitFor("proof.png");
  assert.doesNotMatch(tty.screen, /No matches|Match /);
  tty.send("q");
  assert.equal((await tty.exit()).exit, 0);
});

test("native image graphics are cleared before text and restored when returning to the image", { skip: process.platform === "win32" }, async (t) => {
  const { directory, image } = fixtures(t);
  const file = path.join(directory, "notes.txt");
  writeFileSync(file, "Text after native image");
  const socketPath = path.join(directory, "herdr.sock");
  const events = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let frame;
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length) {
        if (frame) {
          if (buffer.length < frame.data_length) return;
          assert.deepEqual(buffer.subarray(0, frame.data_length), png);
          events.push("png");
          buffer = buffer.subarray(frame.data_length);
          frame = undefined;
          continue;
        }
        const newline = buffer.indexOf(10);
        if (newline === -1) return;
        const request = JSON.parse(buffer.subarray(0, newline).toString());
        buffer = buffer.subarray(newline + 1);
        if (request.format) { frame = request; continue; }
        events.push(request.method);
        assert.equal(request.params.pane_id, "test:p1");
        const result = request.method === "pane.graphics.info" ? { cell_width_px: 9, cell_height_px: 18 } : { type: "ok" };
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATHS: JSON.stringify([image, file]), HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "test:p1" }));
  await tty.waitFor("Native graphics");
  tty.clear();
  tty.send("l");
  await tty.waitFor("Text after native image");
  assert.ok(events.indexOf("png") < events.indexOf("pane.graphics.clear"));
  tty.clear();
  tty.send("h");
  await tty.waitFor("Native graphics");
  tty.send("q");
  assert.equal((await tty.exit()).exit, 0);
  assert.deepEqual(events.filter((event) => event === "png" || event === "pane.graphics.clear"), ["png", "pane.graphics.clear", "png", "pane.graphics.clear"]);
});

test("inspection honors compatibility inputs and rejects selected invalid inputs and unsupported files", (t) => {
  const { directory, image } = fixtures(t);
  for (const env of [
    { FILE_PREVIEW_PATH: image, VISUAL_PROOF_PATHS: "invalid" },
    { VISUAL_PROOF_PATHS: JSON.stringify([image]), VISUAL_PROOF_PATH: "/missing" },
    { VISUAL_PROOF_PATH: image },
  ]) assert.equal(run(env).status, 0);
  assert.equal(run({}, [image, "--inspect"]).status, 0);
  for (const input of ["", "not-json", "[]", "null", '["relative.txt"]', '[null]', JSON.stringify(Array(25).fill(image))]) {
    const result = run({ FILE_PREVIEW_PATHS: input, FILE_PREVIEW_PATH: image });
    assert.equal(result.status, 1, input);
    assert.match(result.stderr, /File preview unavailable:/);
  }
  for (const [name, data, expected] of [
    ["binary.bin", Buffer.from([0, 1, 2]), /binary/],
    ["utf16.txt", Buffer.from([255, 254, 65, 0]), /UTF-8/],
    ["large.txt", Buffer.alloc(1024 * 1024 + 1, 65), /1 MiB/],
    ["large.png", Buffer.alloc(10 * 1024 * 1024 + 1), /10 MiB/],
    ["corrupt.png", "not png", /PNG/],
  ]) {
    const file = path.join(directory, name);
    writeFileSync(file, data);
    const result = run({ FILE_PREVIEW_PATH: file });
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, expected);
  }
  assert.match(run({ FILE_PREVIEW_PATH: directory }).stderr, /directory browsing/);
  assert.match(run({ FILE_PREVIEW_PATH: path.join(directory, "missing") }).stderr, /ENOENT/);
  const empty = path.join(directory, "empty.txt");
  writeFileSync(empty, "");
  assert.equal(JSON.parse(run({ FILE_PREVIEW_PATH: empty }).stdout).lines, 1);
});

test("search remains visible when long text rewraps after resize", { skip: process.platform === "win32" }, async (t) => {
  const { directory } = fixtures(t);
  const file = path.join(directory, "long.txt");
  writeFileSync(file, `${"x".repeat(450)}needle\n${"tail\n".repeat(40)}`);
  const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATH: file }));
  await tty.waitFor("Lines");
  tty.clear();
  tty.send("/needle\r");
  await tty.waitFor("Match 1/1");
  tty.clear();
  tty.resize(12, 30);
  await tty.waitFor("Match 1/1");
  assert.match(tty.screen.split("\x1b[11;1H")[0], /needle/);
  tty.send("q");
  assert.equal((await tty.exit()).exit, 0);
});

test("a rejected graphics stream falls back and does not keep the viewer alive", { skip: process.platform === "win32" }, async (t) => {
  const { directory, image } = fixtures(t);
  const socketPath = path.join(directory, "rejected.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (data) => {
      const request = JSON.parse(data.toString());
      const response = request.method === "pane.graphics.info"
        ? { result: { cell_width_px: 9, cell_height_px: 18 } }
        : { error: { message: "Graphics disabled" } };
      socket.write(`${JSON.stringify({ id: request.id, ...response })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATH: image, HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "test:p1" }));
  await tty.waitFor("ANSI fallback (Graphics disabled)");
  assert.match(tty.screen, /▀/);
  tty.send("q");
  assert.equal((await tty.exit()).exit, 0);
});

test("keyboard help exposes text controls in a narrow pane and returns to the document", { skip: process.platform === "win32" }, async (t) => {
  const { directory } = fixtures(t);
  const file = path.join(directory, "help.txt");
  writeFileSync(file, "A readable document");
  const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATH: file }));
  await tty.waitFor("A readable document");
  tty.clear();
  tty.resize(12, 40);
  await tty.waitFor("? help");
  tty.clear();
  tty.send("?");
  await tty.waitFor("Keyboard help");
  tty.clear();
  tty.send("\x1b[F");
  await tty.waitFor("Home/End");
  tty.clear();
  tty.send("\x1b");
  await tty.waitFor("A readable document");
  tty.send("q");
  assert.equal((await tty.exit()).exit, 0);
});

test("external opening passes the selected path as one argument and reports success or failure", { skip: process.platform === "win32" }, async (t) => {
  const { directory } = fixtures(t);
  const file = path.join(directory, "report with spaces;literal.txt");
  writeFileSync(file, "External opener test");
  const opener = path.join(directory, process.platform === "darwin" ? "open" : "xdg-open");
  writeFileSync(opener, `#!${process.execPath}\nprocess.exit(process.argv.length === 3 && process.argv[2] === process.env.EXPECTED_FILE ? Number(process.env.OPENER_EXIT) : 99);\n`, { mode: 0o755 });
  for (const [code, expected] of [[0, "Opened on viewer host"], [7, "Could not open: opener exited 7"]]) {
    const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATH: file, PATH: `${directory}${path.delimiter}${process.env.PATH}`, EXPECTED_FILE: file, OPENER_EXIT: String(code) }));
    await tty.waitFor("External opener test");
    tty.clear();
    tty.send("o");
    await tty.waitFor(expected);
    tty.send("q");
    assert.equal((await tty.exit()).exit, 0);
  }
});

test("search uses Markdown's active representation and formatted or malformed JSON text", { skip: process.platform === "win32" }, async (t) => {
  const { directory } = fixtures(t);
  const markdown = path.join(directory, "report.md");
  const json = path.join(directory, "data.json");
  const invalid = path.join(directory, "bad.json");
  writeFileSync(markdown, "# Target\n\n**result**\n");
  writeFileSync(json, '{"target":1}');
  writeFileSync(invalid, '{"target": }');
  const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATHS: JSON.stringify([markdown, json, invalid]) }));
  await tty.waitFor("Target");
  tty.clear();
  tty.send("/#\r");
  await tty.waitFor("No matches");
  tty.clear();
  tty.send("s/#\r");
  await tty.waitFor("Match 1/1");
  assert.match(tty.screen, /# Target/);
  tty.clear();
  tty.send("l/target\r");
  await tty.waitFor("Match 1/1");
  assert.match(tty.screen, /"target": 1/);
  tty.clear();
  tty.send("l/target\r");
  await tty.waitFor("Match 1/1");
  assert.match(tty.screen, /Invalid JSON/);
  tty.send("q");
  assert.equal((await tty.exit()).exit, 0);
});

test("file content cannot inject terminal commands into a preview", (t) => {
  const { directory } = fixtures(t);
  const file = path.join(directory, "escaped.md");
  writeFileSync(file, "# Visible\n\n\x1b[2Jhidden screen clear\n\x1b]52;c;c2VjcmV0\x1b\\\n");
  const result = run({ FILE_PREVIEW_PATH: file }, []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\\x1b\[2Jhidden screen clear/);
  assert.doesNotMatch(result.stdout, /\x1b\]52;/);
});

test("Markdown task lists show one checkbox on the same line as each item", (t) => {
  const { directory } = fixtures(t);
  const file = path.join(directory, "tasks.md");
  writeFileSync(file, "- [x] Read the report\n- [ ] Review differences\n");
  const result = run({ FILE_PREVIEW_PATH: file }, []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /• \[x\] Read the report\n• \[ \] Review differences/);
});
