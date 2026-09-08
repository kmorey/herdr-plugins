import path from "node:path";

const MAX_FILES = 24;

export function filePaths({ pathsJson, singlePath, arguments: arguments_ = [] }) {
  let values;
  if (pathsJson !== undefined) {
    try {
      values = JSON.parse(pathsJson);
    } catch {
      throw new Error("expected a JSON array of absolute file paths");
    }
    if (!Array.isArray(values)) {
      throw new Error("expected a JSON array of absolute file paths");
    }
  } else if (singlePath !== undefined) {
    values = [singlePath];
  } else {
    values = arguments_.filter((value) => value !== "--inspect");
  }

  if (values.length === 0) throw new Error("no file paths were provided");
  if (values.length > MAX_FILES) {
    throw new Error(`the viewer supports at most ${MAX_FILES} files`);
  }
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("every file path must be a non-empty string");
  }
  if (values.some((value) => !path.isAbsolute(value))) throw new Error("the gallery requires absolute file paths");
  return [...new Set(values)];
}

export function moveIndex(current, length, offset) {
  if (!Number.isInteger(current) || !Number.isInteger(length) || length < 1) {
    throw new Error("gallery position is invalid");
  }
  return (current + offset % length + length) % length;
}
