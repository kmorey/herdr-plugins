import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function terminal(t, viewer, env) {
  const driver = fileURLToPath(new URL("./terminal.py", import.meta.url));
  const child = spawn("python3", [driver, process.execPath, viewer], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let buffer = "";
  let stderr = "";
  let end;
  const waiters = new Set();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const event = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (event.data) output += Buffer.from(event.data, "base64").toString("utf8");
      else end = event;
    }
    for (const wake of waiters) wake();
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => {
    child.stdin.end();
    await closed;
    if (stderr) throw new Error(stderr);
  });
  const wait = (predicate) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`Terminal timeout. Output:\n${output}\n${stderr}`));
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
    get screen() { return output.split("\x1b[2J\x1b[H").at(-1).replace(/\x1b\[[0-9;]*m/g, ""); },
    clear() { output = ""; },
    send(keys) { child.stdin.write(`${JSON.stringify({ keys })}\n`); },
    resize(rows, columns) { child.stdin.write(`${JSON.stringify({ resize: [rows, columns] })}\n`); },
    waitFor(text) { return wait(() => output.includes(text)); },
    async exit() { await wait(() => end !== undefined); return end; },
  };
}
