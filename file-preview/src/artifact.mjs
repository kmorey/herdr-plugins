import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";

import { decodePng } from "./png.mjs";
import { formatJson } from "./json.mjs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;

export function loadArtifact(value) {
  try {
    return readArtifact(value);
  } catch (error) {
    throw new Error(`${JSON.stringify(value)}: ${error.message}`);
  }
}

function readArtifact(value) {
  if (!path.isAbsolute(value)) throw new Error("the file path must be absolute");
  const resolved = realpathSync(value);
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NONBLOCK);
  let data;
  let isPng;
  try {
    if (!fstatSync(fd).isFile()) throw new Error("only regular files are supported; directory browsing is not available");
    const signature = Buffer.alloc(8);
    const bytes = readSync(fd, signature, 0, 8, 0);
    isPng = signature.equals(PNG_SIGNATURE) || path.extname(value).toLowerCase() === ".png";
    const limit = isPng ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
    const limitMessage = isPng ? "PNG files must be at most 10 MiB" : "text files must be at most 1 MiB";
    if (fstatSync(fd).size > limit) throw new Error(limitMessage);
    // Read at most limit + 1 even if the file grows after stat.
    const buffer = Buffer.alloc(limit + 1);
    signature.copy(buffer, 0, 0, bytes);
    let offset = bytes;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset > limit) throw new Error(limitMessage);
    data = Buffer.from(buffer.subarray(0, offset));
  } finally {
    closeSync(fd);
  }
  const artifact = { path: resolved, bytes: data.length };
  if (isPng) return { ...artifact, type: "png", data, image: decodePng(data) };
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("unsupported binary file: text must be UTF-8");
  }
  if (/[\x00-\x08\x0e-\x1a\x1c-\x1f\x7f]/.test(text)) {
    throw new Error("unsupported binary file: unexpected control characters");
  }
  const extension = path.extname(value).toLowerCase();
  if (extension === ".json") return { ...artifact, type: "json", text, ...formatJson(text) };
  const type = [".md", ".markdown", ".mdown", ".mkd"].includes(extension) ? "markdown" : "text";
  return { ...artifact, type, text };
}

export function inspectArtifact(artifact) {
  const { path, type, bytes, image, text } = artifact;
  return { path, type, bytes, ...(image ? { width: image.width, height: image.height } : { lines: text.split(/\r\n|\r|\n/).length }), ...(artifact.diagnostic ? { diagnostic: artifact.diagnostic } : {}) };
}
