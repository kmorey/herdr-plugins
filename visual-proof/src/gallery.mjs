const MAX_PROOFS = 24;

export function proofPaths({ pathsJson, singlePath, arguments: arguments_ = [] }) {
  let values;
  if (pathsJson) {
    try {
      values = JSON.parse(pathsJson);
    } catch {
      throw new Error("VISUAL_PROOF_PATHS must be a JSON array of absolute PNG paths");
    }
    if (!Array.isArray(values)) {
      throw new Error("VISUAL_PROOF_PATHS must be a JSON array of absolute PNG paths");
    }
  } else if (singlePath) {
    values = [singlePath];
  } else {
    values = arguments_.filter((value) => value !== "--inspect");
  }

  if (values.length === 0) throw new Error("no visual proof paths were provided");
  if (values.length > MAX_PROOFS) {
    throw new Error(`the viewer supports at most ${MAX_PROOFS} proof files`);
  }
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("every visual proof path must be a non-empty string");
  }
  return [...new Set(values)];
}

export function moveIndex(current, length, offset) {
  if (!Number.isInteger(current) || !Number.isInteger(length) || length < 1) {
    throw new Error("gallery position is invalid");
  }
  return (current + offset % length + length) % length;
}
