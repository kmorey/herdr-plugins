import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { openCurrentFile } from "../open-current.mjs";

test("reopens the affected pane's ANSI file-URI gallery instead of scraping the focused preview", (t) => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "herdr-open-current-test-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = [
    "01-pull-current-desktop.png",
    "02-review-current-mobile.png",
    "03-push-ready-desktop.png",
    "04-succeeded-collapsed-desktop.png",
    "05-history-expanded-mobile-dark.png",
  ].map((name) => path.join(directory, name));
  for (const file of files) writeFileSync(file, "media");
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "pane" && args[1] === "get") {
      const preview = args[2] === "w4S:p9";
      return {
        status: 0,
        stdout: JSON.stringify({
          result: {
            pane: preview
              ? { pane_id: "w4S:p9", tab_id: "w4S:t1", workspace_id: "w4S", label: "File preview", cwd: "/plugins/file-preview" }
              : { pane_id: "w4S:p1", tab_id: "w4S:t1", workspace_id: "w4S", label: "Build Pull Review Push Workflow", cwd: "/worktree" },
          },
        }),
        stderr: "",
      };
    }
    if (args[0] === "pane" && args[1] === "neighbor") {
      return {
        status: 0,
        stdout: JSON.stringify({
          result: { neighbor: { pane_id: "w4S:p9", neighbor_pane_id: "w4S:p1" } },
        }),
        stderr: "",
      };
    }
    if (args[0] === "pane" && args[1] === "read") {
      assert.equal(args[2], "w4S:p1");
      return {
        status: 0,
        stdout: [
          "\x1b[1mVisual proof\x1b[0m",
          ...files.flatMap((file, index) => [
            `\x1b[4;38;2;92;217;255m${index + 1}. Open full-size image\x1b[0m`,
            ` \x1b[38;2;122;184;204m(${pathToFileURL(file).href})\x1b[0m\r`,
          ]),
        ].join("\n"),
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  assert.equal(openCurrentFile({
    environment: {
      HERDR_BIN_PATH: "/test/herdr",
      HERDR_PANE_ID: "w4S:p9",
      HERDR_PLUGIN_ID: "kmorey.file-preview",
      HERDR_PLUGIN_ROOT: "/plugins/file-preview",
    },
    spawn,
  }), 0);
  assert.deepEqual(calls, [
    {
      command: "/test/herdr",
      args: ["pane", "get", "w4S:p9"],
      options: { encoding: "utf8" },
    },
    {
      command: "/test/herdr",
      args: ["pane", "neighbor", "--direction", "left", "--pane", "w4S:p9"],
      options: { encoding: "utf8" },
    },
    {
      command: "/test/herdr",
      args: ["pane", "get", "w4S:p1"],
      options: { encoding: "utf8" },
    },
    {
      command: "/test/herdr",
      args: ["pane", "read", "w4S:p1", "--source", "recent-unwrapped", "--lines", "500", "--format", "ansi"],
      options: { encoding: "utf8" },
    },
    {
      command: "/test/herdr",
      args: [
        "plugin", "pane", "open",
        "--plugin", "kmorey.file-preview",
        "--entrypoint", "viewer",
        "--placement", "split",
        "--target-pane", "w4S:p1",
        "--direction", "right",
        "--env", `FILE_PREVIEW_PATHS=${JSON.stringify(files.slice(-3))}`,
        "--focus",
      ],
      options: { encoding: "utf8" },
    },
    {
      command: "/test/herdr",
      args: ["plugin", "pane", "close", "w4S:p9"],
      options: { encoding: "utf8" },
    },
  ]);
});

test("keeps the focused preview open when its replacement cannot be opened", (t) => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "herdr-open-current-test-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "review-runtime-suggestion-result.png");
  writeFileSync(file, "media");
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "pane" && args[1] === "get") {
      const preview = args[2] === "w5V:p9";
      return {
        status: 0,
        stdout: JSON.stringify({
          result: {
            pane: preview
              ? { pane_id: "w5V:p9", label: "File preview", cwd: "/plugins/file-preview" }
              : { pane_id: "w5V:p1", cwd: "/worktree" },
          },
        }),
        stderr: "",
      };
    }
    if (args[0] === "pane" && args[1] === "neighbor") {
      return {
        status: 0,
        stdout: JSON.stringify({
          result: { neighbor: { pane_id: "w5V:p9", neighbor_pane_id: "w5V:p1" } },
        }),
        stderr: "",
      };
    }
    if (args[0] === "pane" && args[1] === "read") {
      return { status: 0, stdout: `Current evidence (${pathToFileURL(file).href})`, stderr: "" };
    }
    if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
      return { status: 1, stdout: "", stderr: "replacement failed" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  assert.equal(openCurrentFile({
    environment: {
      HERDR_BIN_PATH: "/test/herdr",
      HERDR_PANE_ID: "w5V:p9",
      HERDR_PLUGIN_ID: "kmorey.file-preview",
      HERDR_PLUGIN_ROOT: "/plugins/file-preview",
    },
    spawn,
    stderr: { write() {} },
  }), 1);
  assert.ok(calls.some(({ args }) =>
    args[0] === "plugin" && args[1] === "pane" && args[2] === "open"
  ));
  assert.equal(calls.some(({ args }) =>
    args[0] === "plugin" && args[1] === "pane" && args[2] === "close"
  ), false);
});

