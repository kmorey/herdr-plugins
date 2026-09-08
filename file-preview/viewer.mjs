#!/usr/bin/env node

import process from "node:process";

import { proofPaths } from "./src/gallery.mjs";
import { inspectArtifact, loadArtifact } from "./src/artifact.mjs";
import { runViewer } from "./src/viewer.mjs";

try {
  const paths = proofPaths({
    pathsJson: process.env.FILE_PREVIEW_PATHS ?? (process.env.FILE_PREVIEW_PATH === undefined ? process.env.VISUAL_PROOF_PATHS : undefined),
    singlePath: process.env.FILE_PREVIEW_PATH ?? process.env.VISUAL_PROOF_PATH,
    arguments: process.argv.slice(2),
  });
  if (process.argv.includes("--inspect")) {
    const files = paths.map((file) => inspectArtifact(loadArtifact(file)));
    process.stdout.write(`${JSON.stringify(files.length === 1 ? files[0] : { files })}\n`);
  } else {
    await runViewer(paths);
  }
} catch (error) {
  process.stderr.write(`File preview unavailable: ${error.message}\n`);
  process.exitCode = 1;
}
