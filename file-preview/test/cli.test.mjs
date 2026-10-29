import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { terminal } from "./support/terminal.mjs";
import { decodePng, encodePng } from "../src/png.mjs";

const viewer = fileURLToPath(new URL("../viewer.mjs", import.meta.url));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");

function fixtures(t) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "file-preview-test-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const image = path.join(directory, "proof.png");
  writeFileSync(image, png);
  return { directory, image };
}

function cleanEnv(env = {}) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (/^(FILE_PREVIEW_|HERDR_)/.test(key)) delete clean[key];
  }
  return { ...clean, ...env };
}

function run(env = {}, args = ["--inspect"]) {
  return spawnSync(process.execPath, [viewer, ...args], {
    env: cleanEnv(env), encoding: "utf8", timeout: 5000,
  });
}

test("inspect accepts gallery inputs and identifies PNGs", (t) => {
  const { image } = fixtures(t);
  const result = run({ FILE_PREVIEW_PATHS: JSON.stringify([image, image]) });
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

function assertOwnedDeletes(graphics) {
  const owned = new Set(graphics.frames.map((frame) => frame.command.i));
  assert.ok(graphics.deletions.length > 0, "the viewer must delete its native image");
  for (const command of graphics.deletions) {
    assert.equal(command.a, "d");
    assert.equal(command.d, "I", "never delete another application's images");
    assert.equal(command.q, 2);
    assert.ok(owned.has(command.i), `deleted unowned image ${command.i}`);
  }
}

const nativeGraphicsScenario = (rejectReopen, lateDimensions = false) => async (t) => {
  const { directory, image } = fixtures(t);
  const file = path.join(directory, "notes.txt");
  writeFileSync(file, "Text after native image");
  const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATHS: JSON.stringify([image, file]) }), undefined, { kitty: {
    cell: (attempt) => lateDimensions && attempt === 1 ? { width: 0, height: 0 } : { width: 9, height: 18 },
    render: (_frame, attempt) => rejectReopen && attempt === 2 ? "EINVAL: Graphics turned off q h l" : "OK",
  } });
  await tty.waitForGraphics(({ frames }) => frames.length === 1);
  await tty.waitFor("Native graphics\x1b[0m");
  assert.ok(tty.graphics.queries.length > 0, "negotiate Kitty support over the terminal");
  if (lateDimensions) assert.ok(tty.graphics.cellQueries >= 2, "retry unavailable initial cell dimensions without SIGWINCH");
  const firstId = tty.graphics.frames[0].command.i;
  const first = decodePng(tty.graphics.frames[0].data);
  assert.ok(first.width > 0 && first.height > 0);
  tty.clear();
  tty.send("l");
  await tty.waitFor("Text after native image");
  assertOwnedDeletes(tty.graphics);
  assert.equal(tty.graphics.deletions.at(-1).i, firstId);
  const deletion = [...tty.output.matchAll(/\x1b_G([^;\x1b]*)(?:;[^\x1b]*)?\x1b\\/g)]
    .find(([, header]) => header.split(",").includes("a=d"));
  assert.ok(deletion && deletion.index < tty.output.indexOf("Text after native image"), "delete before drawing text");
  tty.clear();
  tty.send("h");
  await tty.waitForGraphics(({ frames }) => frames.length === 2);
  await tty.waitFor(rejectReopen ? "Graphics turned off" : "Native graphics\x1b[0m");
  if (rejectReopen) assert.match(tty.screen, /Preview unavailable/);
  assert.doesNotMatch(tty.screen, /▀|ANSI fallback/);
  assert.deepEqual(tty.graphics.frames[1].data, tty.graphics.frames[0].data, "returning to the image re-transmits its PNG");
  tty.send("q");
  assert.deepEqual(await tty.exit(), { exit: 0, canonical: true, echo: true });
  assertOwnedDeletes(tty.graphics);
  if (!rejectReopen) {
    assert.equal(tty.graphics.deletions.at(-1).i, tty.graphics.frames.at(-1).command.i);
    const events = tty.graphics.events.map(({ type }) => type);
    const firstFrame = events.indexOf("frame");
    const lastFrame = events.lastIndexOf("frame");
    assert.ok(events.indexOf("delete", firstFrame + 1) < lastFrame, "delete the first image before restoring it");
    assert.ok(events.lastIndexOf("delete") > lastFrame, "delete the restored image on close");
  }
};

test("native image graphics are deleted before text and re-transmitted when returning to the image", { skip: process.platform === "win32" }, nativeGraphicsScenario(false));
test("a rejected restored image reports the error without pixelating or invoking q/h/l shortcuts", { skip: process.platform === "win32" }, nativeGraphicsScenario(true));
test("native graphics wait for usable cell dimensions without a resize", { skip: process.platform === "win32" }, nativeGraphicsScenario(false, true));

test("native image fits the initial pane and every resize", { skip: process.platform === "win32" }, async (t) => {
  const { directory, image } = fixtures(t);
  const sourceWidth = 8;
  const sourceHeight = 6;
  const sourceRgba = Buffer.alloc(sourceWidth * sourceHeight * 4, 255);
  const edgeColors = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 0, 255],
  ];
  const edgeOffsets = [
    0,
    (sourceWidth - 1) * 4,
    (sourceHeight - 1) * sourceWidth * 4,
    (sourceWidth * sourceHeight - 1) * 4,
  ];
  for (let index = 0; index < edgeColors.length; index += 1) {
    sourceRgba.set(edgeColors[index], edgeOffsets[index]);
  }
  writeFileSync(image, encodePng({ width: sourceWidth, height: sourceHeight, rgba: sourceRgba }));
  let releaseInitialCell;
  const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATH: image }), { rows: 24, columns: 100 }, { kitty: {
    reply({ kind, response, send }) {
      if (kind === "cell" && !releaseInitialCell) releaseInitialCell = () => send(response);
      else send(response);
    },
  } });
  const { frames } = tty.graphics;
  const fits = (frame, rows, columns) => {
    const { column, row } = frame.placement;
    const { c: width, r: height } = frame.command;
    // Captured CSI coordinates are 1-based; the final occupied cell is inclusive.
    return column >= 2 && column + width - 1 <= columns - 1 && row >= 4 && row + height - 1 <= rows - 2;
  };
  const assertFits = (frame, rows, columns) => {
    assert.ok(fits(frame, rows, columns), `${JSON.stringify(frame.placement)} exceeds ${columns}x${rows}`);
    const rendered = decodePng(frame.data);
    assert.equal(rendered.width, frame.command.c * 9);
    assert.equal(rendered.height, frame.command.r * 18);
    assert.equal(frame.command.C, 1, "image placement must not move the text cursor");
    const pixels = new Set();
    for (let offset = 0; offset < rendered.rgba.length; offset += 4) {
      pixels.add(rendered.rgba.subarray(offset, offset + 4).toString("hex"));
    }
    for (const color of edgeColors) {
      assert.ok(pixels.has(Buffer.from(color).toString("hex")), `source edge ${color} is missing`);
    }
    return rendered;
  };

  await tty.waitForGraphics(({ cellQueries }) => cellQueries > 0);
  // Change the PTY size before graphics initialization completes, without SIGWINCH.
  await tty.resizeSilently(24, 30);
  releaseInitialCell();
  const sizes = [30, 20, 100, 25, 30];
  const widths = [];
  for (let index = 0; index < sizes.length; index += 1) {
    const columns = sizes[index];
    const start = frames.length;
    if (index > 0) tty.resize(24, columns);
    await tty.waitForGraphics(() => frames.slice(start).some((frame) => fits(frame, 24, columns)));
    const frame = frames.slice(start).find((candidate) => fits(candidate, 24, columns));
    widths.push(assertFits(frame, 24, columns).width);
  }
  assert.ok(widths[1] < widths[0] && widths[2] > widths[1] && widths[3] < widths[2], "resizes must re-fit, not merely reuse a small frame");
  assert.equal(widths[4], widths[0]);
  assert.ok(frames.some((frame) => frame.chunks.length > 1), "exercise chunked PNG transmission");
  tty.send("q");
  assert.deepEqual(await tty.exit(), { exit: 0, canonical: true, echo: true });
  assertOwnedDeletes(tty.graphics);
});

test("inspection validates file-preview inputs and rejects selected invalid inputs and unsupported files", (t) => {
  const { directory, image } = fixtures(t);
  assert.equal(run({ FILE_PREVIEW_PATH: image }).status, 0);
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
    assert.ok(result.stderr.includes(JSON.stringify(file)), result.stderr);
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

for (const phase of ["query", "render"]) {
  test(`a rejected Kitty ${phase} reports unavailable graphics without pixelating or invoking shortcuts`, { skip: process.platform === "win32" }, async (t) => {
    const { directory, image } = fixtures(t);
    const text = path.join(directory, "notes.txt");
    writeFileSync(text, "Must not navigate here on a protocol reply");
    const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATHS: JSON.stringify([image, text]) }), undefined, { kitty: {
      [phase]: "ENOTSUP: Graphics disabled q h l y o",
    } });
    await tty.waitFor("Graphics disabled");
    assert.doesNotMatch(tty.screen, /▀|ANSI fallback|Must not navigate here|2\/2/);
    assert.doesNotMatch(tty.output, /\x1b\]52;|Opening on viewer host|\x1b\[\?25h/);
    assert.match(tty.screen, /Preview unavailable/);
    assert.match(tty.screen, /1\/2/);
    assert.ok(tty.graphics.queries.length > 0);
    assert.equal(tty.graphics.frames.length, phase === "query" ? 0 : 1);
    if (phase === "render") decodePng(tty.graphics.frames[0].data);
    tty.send("q");
    assert.deepEqual(await tty.exit(), { exit: 0, canonical: true, echo: true });
  });
}

test("fragmented and interleaved Kitty, cell-size, and DA replies do not become keyboard shortcuts", { skip: process.platform === "win32" }, async (t) => {
  const { directory, image } = fixtures(t);
  const text = path.join(directory, "notes.txt");
  writeFileSync(text, "No reply-driven navigation");
  const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATHS: JSON.stringify([image, text]) }), undefined, { kitty: {
    reply({ kind, response, command, send }) {
      const foreign = kind === "cell" ? "" : `\x1b_Gi=${command.i + 1},p=1;EINVAL: q h l y o\x1b\\`;
      send(`${foreign}\x1b[?1;2c${response}`, { fragments: [1, 2, 5, 9, 11], interval: 10 });
    },
  } });
  await tty.waitForGraphics(({ frames }) => frames.length > 0);
  await tty.waitFor("Native graphics\x1b[0m");
  // A real shortcut after the fragmented acknowledgment must still work.
  tty.clear();
  tty.send("y");
  await tty.waitFor(`\x1b]52;c;${Buffer.from(image).toString("base64")}\x07`);
  await tty.waitFor("File preview  1/2  proof.png");
  assert.match(tty.screen, /1\/2.*proof\.png/);
  assert.doesNotMatch(tty.screen, /No reply-driven navigation|Preview unavailable/);
  tty.send("q");
  assert.deepEqual(await tty.exit(), { exit: 0, canonical: true, echo: true });
  assertOwnedDeletes(tty.graphics);
});

test("unsolicited and late protocol replies leave an active search draft and subsequent shortcuts intact", { skip: process.platform === "win32" }, async (t) => {
  const { directory, image } = fixtures(t);
  const text = path.join(directory, "search.txt");
  writeFileSync(text, "A unique needle result");
  const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATHS: JSON.stringify([image, text]) }), undefined, { kitty: {} });
  await tty.waitForGraphics(({ frames }) => frames.length > 0);
  const lateId = tty.graphics.frames[0].command.i;
  tty.send("l");
  await tty.waitFor("A unique needle result");
  tty.clear();
  tty.send("/nee");
  await tty.waitFor("/nee  (Enter search");
  // Feed unsolicited APC (including ESC_), a late frame acknowledgment, cell size,
  // and device attributes through the real stdin while a search is being edited.
  tty.sendReply(`\x1b_Gi=2147483647,p=1;EINVAL: q h l / y o\x1b\\\x1b_Gi=${lateId},p=1;OK\x1b\\\x1b[6;18;9t\x1b[?1;2c`, { fragments: [1, 1, 3, 8, 15], interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  tty.send("dle\r");
  await tty.waitFor("Match 1/1");
  assert.match(tty.screen, /\/needle/);
  assert.match(tty.screen, /2\/2/);
  assert.doesNotMatch(tty.output, /\x1b\]52;|Opening on viewer host|\x1b\[\?25h/);
  tty.clear();
  tty.send("h");
  await tty.waitForGraphics(({ frames }) => frames.length === 2);
  await tty.waitFor("proof.png");
  tty.send("q");
  assert.deepEqual(await tty.exit(), { exit: 0, canonical: true, echo: true });
  assertOwnedDeletes(tty.graphics);
});

for (const phase of ["query", "cell", "render"]) {
  test(`a missing Kitty ${phase} reply times out, keeps navigation usable, and restores the terminal`, { skip: process.platform === "win32" }, async (t) => {
    const { directory, image } = fixtures(t);
    const text = path.join(directory, "notes.txt");
    writeFileSync(text, "Navigation after protocol timeout");
    const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATHS: JSON.stringify([image, text]) }), undefined, { kitty: { [phase]: null } });
    await tty.waitForGraphics((graphics) => phase === "query" ? graphics.queries.length > 0 : phase === "cell" ? graphics.cellQueries > 0 : graphics.frames.length > 0);
    tty.clear();
    await tty.waitFor("Preview unavailable");
    assert.match(tty.screen, /timed? ?out|timeout|not ready/i);
    assert.doesNotMatch(tty.screen, /▀|ANSI fallback/);
    assert.equal(tty.graphics.frames.length, phase === "render" ? 1 : 0);
    tty.clear();
    tty.send("l");
    await tty.waitFor("Navigation after protocol timeout");
    tty.send("q");
    assert.deepEqual(await tty.exit(), { exit: 0, canonical: true, echo: true });
    if (phase === "render") assertOwnedDeletes(tty.graphics);
  });
}

test("non-interactive image output never substitutes terminal blocks", (t) => {
  const { image } = fixtures(t);
  const result = run({ FILE_PREVIEW_PATH: image }, []);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /▀|ANSI fallback/);
  assert.match(result.stdout, /Preview unavailable/);
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

for (const phase of ["query", "cell"]) {
  test(`closing while Kitty ${phase} initializes restores the terminal without a late image`, { skip: process.platform === "win32" }, async (t) => {
    const { image } = fixtures(t);
    const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATH: image }), undefined, { kitty: {
      reply({ kind, response, send }) { send(response, { delay: kind === phase ? 300 : 0 }); },
    } });
    await tty.waitForGraphics((graphics) => phase === "query" ? graphics.queries.length > 0 : graphics.cellQueries > 0);
    tty.send("q");
    assert.deepEqual(await tty.exit(), { exit: 0, canonical: true, echo: true });
    assert.equal(tty.graphics.frames.length, 0);
    assert.doesNotMatch(tty.output.split("\x1b[?25h").at(-1), /Native graphics|File preview|\x1b_G/);
  });
}

test("search highlights the complete match after decomposed Unicode is displayed", { skip: process.platform === "win32" }, async (t) => {
  const { directory } = fixtures(t);
  const file = path.join(directory, "unicode.txt");
  writeFileSync(file, "a\u0301needle\n");
  const tty = terminal(t, viewer, cleanEnv({ FILE_PREVIEW_PATH: file }));
  await tty.waitFor("needle");
  tty.clear();
  tty.send("/needle\r");
  await tty.waitFor("Match 1/1");
  assert.match(tty.output, /\x1b\[7mneedle\x1b\[0m/);
  tty.clear();
  tty.send("/a\u0301\r");
  await tty.waitFor("Match 1/1");
  assert.match(tty.output, /\x1b\[7má\x1b\[0m/);
  tty.send("q");
  assert.equal((await tty.exit()).exit, 0);
});

test("all gallery paths are validated before previewing and errors describe mixed files", (t) => {
  const { directory } = fixtures(t);
  const file = path.join(directory, "valid.txt");
  writeFileSync(file, "Should not render an invalid gallery");
  const result = run({ FILE_PREVIEW_PATHS: JSON.stringify([file, "relative.txt"]) }, []);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /Should not render/);
  assert.match(result.stderr, /absolute file paths/);
  const invalid = run({ FILE_PREVIEW_PATHS: "not-json" });
  assert.match(invalid.stderr, /JSON array of absolute file paths/);
  assert.doesNotMatch(invalid.stderr, /PNG/);
});
