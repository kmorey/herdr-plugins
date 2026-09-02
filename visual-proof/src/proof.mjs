import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { decodePng } from "./png.mjs";

const MAX_PROOF_BYTES = 10 * 1024 * 1024;

export function loadProof(value) {
  if (!value) throw new Error("VISUAL_PROOF_PATH is not set");
  if (!path.isAbsolute(value)) throw new Error("the proof path must be absolute");
  const resolved = realpathSync(value);
  const stat = statSync(resolved);
  if (!stat.isFile()) throw new Error("the proof path is not a regular file");
  if (stat.size < 1 || stat.size > MAX_PROOF_BYTES) {
    throw new Error("the proof must contain between 1 byte and 10 MiB");
  }
  if (path.extname(resolved).toLowerCase() !== ".png") {
    throw new Error("version 0.1 supports PNG proof files only");
  }
  return {
    path: resolved,
    bytes: stat.size,
    image: decodePng(readFileSync(resolved)),
  };
}
