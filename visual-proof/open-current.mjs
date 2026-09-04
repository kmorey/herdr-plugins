#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { currentProofPaths } from "./src/current-proof.mjs";

export function openCurrentProof({
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
        "Visual proof unavailable",
        "--body",
        message,
        "--sound",
        "none",
      ],
      { stdio: "ignore" },
    );
    stderr.write(`Visual proof unavailable: ${message}\n`);
    return 1;
  };

  if (!activePane) return fail("No focused pane is available.");

  const read = spawn(
    herdr,
    [
      "pane",
      "read",
      activePane,
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

  const proofs = currentProofPaths(read.stdout);
  if (proofs.length === 0) {
    return fail("No current PNG visual proof was found in the focused pane.");
  }

  const opened = spawn(
    herdr,
    [
      "plugin",
      "pane",
      "open",
      "--plugin",
      environment.HERDR_PLUGIN_ID || "kmorey.visual-proof",
      "--entrypoint",
      "viewer",
      "--placement",
      "split",
      "--target-pane",
      activePane,
      "--direction",
      "right",
      "--env",
      `VISUAL_PROOF_PATHS=${JSON.stringify(proofs)}`,
      "--focus",
    ],
    { encoding: "utf8" },
  );

  if (opened.status !== 0) {
    return fail(
      opened.stderr?.trim() ||
        opened.error?.message ||
        "Could not open the Visual Proof pane.",
    );
  }

  return 0;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (import.meta.url === invokedPath) process.exitCode = openCurrentProof();
