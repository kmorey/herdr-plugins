import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// No responder by default: ordinary PTYs must exercise unavailable graphics naturally.
// options.kitty enables a test terminal, with query/render status strings (or functions
// returning a status/null), cell dimensions (or a function of the request count), and
// an optional reply({ kind, response, send }) hook for delayed/interleaved replies.
export function terminal(t, viewer, env, size = { rows: 24, columns: 100 }, options = {}) {
  const driver = fileURLToPath(new URL("./terminal.py", import.meta.url));
  const child = spawn("python3", [driver, process.execPath, viewer, String(size.rows), String(size.columns)], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let buffer = "";
  let stderr = "";
  let end;
  let silentResizeAcks = 0;
  const waiters = new Set();
  const timers = new Set();
  const send = (keys) => {
    if (!child.stdin.destroyed && !child.stdin.writableEnded && end === undefined) child.stdin.write(`${JSON.stringify({ keys })}\n`);
  };
  let replyReadyAt = 0;
  const sendReply = (reply, { delay = 0, fragments = [], interval = 10 } = {}) => {
    let offset = 0;
    const pieces = fragments.map((length) => {
      const piece = reply.slice(offset, offset + length);
      offset += length;
      return piece;
    });
    pieces.push(reply.slice(offset));
    const nonempty = pieces.filter(Boolean);
    // Fragment a reply without corrupting it if negotiation issues parallel queries.
    // Replies may be interleaved with other *complete* protocol messages, not bytes
    // from a second reply in the middle of an APC/CSI sequence.
    const start = Math.max(Date.now() + delay, replyReadyAt);
    replyReadyAt = start + Math.max(0, nonempty.length - 1) * interval + 1;
    nonempty.forEach((piece, index) => {
      const timer = setTimeout(() => { timers.delete(timer); send(piece); }, Math.max(0, start + index * interval - Date.now()));
      timers.add(timer);
    });
  };
  const graphics = kittyCapture(options.kitty, sendReply);
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const event = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (event.data) {
        const data = Buffer.from(event.data, "base64").toString("utf8");
        output += data;
        graphics.observe(data);
      } else if (event.ack === "resize_silently") silentResizeAcks++;
      else if (event.exit !== undefined) end = event;
    }
    for (const wake of waiters) wake();
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    child.stdin.end();
    await closed;
    if (stderr) throw new Error(stderr);
    assert.deepEqual(graphics.errors, [], "invalid outgoing Kitty protocol");
  });
  const wait = (predicate) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`Terminal timeout. Output (tail):\n${output.slice(-10000)}\n${stderr}`));
    }, 5000);
    function check() {
      if (!predicate()) return;
      clearTimeout(timer);
      waiters.delete(check);
      resolve();
    }
    waiters.add(check);
    check();
  });
  return {
    get output() { return output; },
    get screen() { return output.split("\x1b[2J\x1b[H").at(-1).replace(/\x1b_G[^]*?\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, ""); },
    graphics,
    clear() { output = ""; },
    send,
    sendReply,
    resize(rows, columns) { child.stdin.write(`${JSON.stringify({ resize: [rows, columns] })}\n`); },
    resizeSilently(rows, columns) {
      const expected = silentResizeAcks + 1;
      child.stdin.write(`${JSON.stringify({ resize_silently: [rows, columns] })}\n`);
      return wait(() => silentResizeAcks >= expected);
    },
    waitFor(text) { return wait(() => output.includes(text)); },
    waitForGraphics(predicate) { return wait(() => predicate(graphics)); },
    async exit() { await wait(() => end !== undefined); return end; },
  };
}

function kittyCapture(config, send) {
  const capture = { commands: [], queries: [], cellQueries: 0, frames: [], deletions: [], events: [], errors: [] };
  let pending = "";
  let cursor = { row: 1, column: 1 };
  let transmission;
  const check = (condition, message) => { if (!condition) capture.errors.push(message); };
  const reply = (kind, response, command) => {
    if (response === null) return;
    if (config.reply) config.reply({ kind, response, command, send });
    else send(response);
  };
  const status = (setting, value, count) => typeof setting === "function" ? setting(value, count) : setting === undefined ? "OK" : setting;
  const apc = (body) => {
    if (!body.startsWith("G")) return;
    const separator = body.indexOf(";");
    const header = body.slice(1, separator < 0 ? undefined : separator);
    const payload = separator < 0 ? "" : body.slice(separator + 1);
    const command = Object.fromEntries(header.split(",").filter(Boolean).map((field) => {
      const [key, value] = field.split("=");
      return [key, /^\d+$/.test(value) ? Number(value) : value];
    }));
    capture.commands.push({ ...command, payload });
    if (command.a === "q") {
      capture.queries.push(command);
      capture.events.push({ type: "query", command });
      check(Number.isInteger(command.i) && command.i > 0, "capability query needs a positive image id");
      const result = status(config.query, command, capture.queries.length);
      reply("query", result === null ? null : `\x1b_Gi=${command.i};${result}\x1b\\`, command);
    } else if (command.a === "d") {
      capture.deletions.push(command);
      capture.events.push({ type: "delete", command });
      check(command.d === "I" && Number.isInteger(command.i) && command.i > 0 && command.q === 2, "delete must target an owned image with a=d,d=I,i=<id>,q=2");
    } else if (command.a === "T" || transmission) {
      if (!transmission) {
        check(command.a === "T" && command.f === 100 && command.p === 1 && command.C === 1 && command.q === 0, "PNG transmit-display requires a=T,f=100,p=1,C=1,q=0");
        check(Number.isInteger(command.i) && command.i > 0 && Number.isInteger(command.c) && command.c > 0 && Number.isInteger(command.r) && command.r > 0, "transmit-display needs an image id and positive cell grid");
        transmission = { command, placement: { ...cursor }, chunks: [] };
      }
      check(payload.length > 0 && payload.length <= 4096 && /^[A-Za-z0-9+/]*={0,2}$/.test(payload), "PNG chunks must be nonempty base64 with at most 4096 characters");
      check(command.m === 0 || command.m === 1, "chunks need explicit m=1 (intermediate) or m=0 (final)");
      for (const key of ["i", "p", "f", "c", "r", "C", "q"]) {
        check(command[key] === undefined || command[key] === transmission.command[key], `continuation changed ${key}`);
      }
      transmission.chunks.push({ ...command, payload });
      if (command.m === 0) {
        const frame = { ...transmission, data: Buffer.from(transmission.chunks.map((chunk) => chunk.payload).join(""), "base64") };
        capture.frames.push(frame);
        capture.events.push({ type: "frame", frame });
        transmission = undefined;
        const result = status(config.render, frame, capture.frames.length);
        // Acknowledgment is only sent once the complete image has arrived.
        reply("render", result === null ? null : `\x1b_Gi=${frame.command.i},p=1;${result}\x1b\\`, frame.command);
      }
    } else {
      check(false, `unexpected graphics command: ${header}`);
    }
  };
  capture.observe = (data) => {
    if (!config) return;
    pending += data;
    while (pending) {
      const escape = pending.indexOf("\x1b");
      if (escape < 0) { pending = ""; return; }
      pending = pending.slice(escape);
      if (pending.length < 2) return;
      if (pending[1] === "_" || pending[1] === "]") {
        const st = pending.indexOf("\x1b\\", 2);
        const bell = pending[1] === "]" ? pending.indexOf("\x07", 2) : -1;
        const end = st < 0 ? bell : bell < 0 ? st : Math.min(st, bell);
        if (end < 0) return;
        if (pending[1] === "_") apc(pending.slice(2, end));
        pending = pending.slice(end + (end === bell ? 1 : 2));
      } else if (pending[1] === "[") {
        const match = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(pending);
        if (!match) return;
        const [, parameters, , final] = match;
        if (final === "H") {
          const [row, column] = parameters.split(";").map(Number);
          cursor = { row: row || 1, column: column || 1 };
        } else if (final === "t" && parameters === "16") {
          capture.cellQueries++;
          capture.events.push({ type: "cell" });
          const cell = typeof config.cell === "function" ? config.cell(capture.cellQueries) : config.cell === undefined ? { width: 9, height: 18 } : config.cell;
          reply("cell", cell === null ? null : `\x1b[6;${cell.height};${cell.width}t`);
        }
        pending = pending.slice(match[0].length);
      } else pending = pending.slice(2);
    }
  };
  return capture;
}
