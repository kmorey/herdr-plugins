#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { currentFilePaths } from "./src/current-file.mjs";

export function openCurrentFile({
  environment = process.env,
  spawn = spawnSync,
  stderr = process.stderr,
} = {}) {
  const herdr = environment.HERDR_BIN_PATH || "herdr";
  const activePane = environment.HERDR_PANE_ID;

  const fail = (message) => {
    spawn(
      herdr,
      [
        "notification",
        "show",
        "File preview unavailable",
        "--body",
        message,
        "--sound",
        "none",
      ],
      { stdio: "ignore" },
    );
    stderr.write(`File preview unavailable: ${message}\n`);
    return 1;
  };

  if (!activePane) return fail("No focused pane is available.");

  let sourcePane;
  let previewPanes;
  try {
    ({ sourcePane, previewPanes } = originatingPane(activePane, {
      herdr,
      pluginRoot: environment.HERDR_PLUGIN_ROOT || path.dirname(fileURLToPath(import.meta.url)),
      spawn,
    }));
  } catch (error) {
    return fail(error.message);
  }

  const read = spawn(
    herdr,
    [
      "pane",
      "read",
      sourcePane,
      "--source",
      "recent-unwrapped",
      "--lines",
      "500",
      "--format",
      "ansi",
    ],
    { encoding: "utf8" },
  );

  if (read.status !== 0) {
    const message =
      read.stderr?.trim() || read.error?.message || "Could not read the focused pane.";
    return fail(message);
  }

  const files = currentFilePaths(read.stdout);
  if (files.length === 0) {
    return fail("No current PNG or MP4 file was found in the focused pane.");
  }


  const opened = spawn(
    herdr,
    [
      "plugin",
      "pane",
      "open",
      "--plugin",
      environment.HERDR_PLUGIN_ID || "kmorey.file-preview",
      "--entrypoint",
      "viewer",
      "--placement",
      "split",
      "--target-pane",
      sourcePane,
      "--direction",
      "right",
      "--env",
      `FILE_PREVIEW_PATHS=${JSON.stringify(files)}`,
      "--focus",
    ],
    { encoding: "utf8" },
  );

  if (opened.status !== 0) {
    return fail(
      opened.stderr?.trim() ||
        opened.error?.message ||
        "Could not open the File Preview pane.",
    );
  }
  for (const previewPane of previewPanes) {
    const closed = spawn(
      herdr,
      ["plugin", "pane", "close", previewPane],
      { encoding: "utf8" },
    );
    if (closed.status !== 0) {
      return fail(
        closed.stderr?.trim() ||
          closed.error?.message ||
          "Could not replace the existing File Preview pane.",
      );
    }
  }

  return 0;
}

function originatingPane(activePane, { herdr, pluginRoot, spawn }) {
  const visited = new Set();
  let paneId = activePane;
  const previewPanes = [];
  while (!visited.has(paneId)) {
    visited.add(paneId);
    const pane = herdrJson(
      spawn(herdr, ["pane", "get", paneId], { encoding: "utf8" }),
      "Could not inspect the focused pane.",
    ).result?.pane;
    if (!pane) throw new Error("Could not inspect the focused pane.");

    const isPreview =
      pane.label === "File preview" &&
      path.resolve(pane.cwd || "") === path.resolve(pluginRoot);
    if (!isPreview) return { sourcePane: paneId, previewPanes };
    previewPanes.push(paneId);

    const neighbor = herdrJson(
      spawn(
        herdr,
        ["pane", "neighbor", "--direction", "left", "--pane", paneId],
        { encoding: "utf8" },
      ),
      "Could not find the agent pane that opened File Preview.",
    ).result?.neighbor?.neighbor_pane_id;
    if (!neighbor) {
      throw new Error("Could not find the agent pane that opened File Preview.");
    }
    paneId = neighbor;
  }

  throw new Error("Could not find the agent pane that opened File Preview.");
}

function herdrJson(result, fallback) {
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.error?.message || fallback);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(fallback);
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (import.meta.url === invokedPath) process.exitCode = openCurrentFile();
