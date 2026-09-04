import { existsSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function currentProofPaths(ansi) {
  const text = expandFileLinks(ansi)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
  const candidates = [];
  const absolutePath = String.raw`(?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])`;
  const patterns = [
    new RegExp(
      String.raw`\]\(\s*<?(${absolutePath}[^>\r\n]*?\.png)(?::\d+)?(?:>\s*)?\)`,
      "gi",
    ),
    new RegExp(String.raw`<(${absolutePath}[^>\r\n]*?\.png)>`, "gi"),
    new RegExp(
      String.raw`${absolutePath}(?:[^\s()[\]{}'\x22\x60<>]|\\ )+?\.png`,
      "gi",
    ),
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1] || match[0];
      const proofPath = usablePngPath(value);
      if (proofPath) candidates.push({ index: match.index, path: proofPath });
    }
  }

  candidates.sort((left, right) => left.index - right.index);
  const headings = [...text.matchAll(/^\s*(?:#{1,6}\s*)?Visual Proof\s*$/gim)];
  let selected = [];

  for (let index = headings.length - 1; index >= 0; index -= 1) {
    const afterHeading = candidates.filter(
      (candidate) => candidate.index > headings[index].index,
    );
    if (afterHeading.length > 0) {
      selected = afterHeading;
      break;
    }
  }

  if (selected.length === 0 && candidates.length > 0) {
    selected = [candidates.at(-1)];
  }

  return [...new Set(selected.map(({ path }) => path))].slice(0, 24);
}

function expandFileLinks(value) {
  return value.replace(
    /(?:\x1b\]|\x9d)8;[^;]*;([^\x07\x1b\x9c]*)(?:\x07|\x1b\\|\x9c)/g,
    (_sequence, uri) => {
      const proofPath = pathFromUri(uri);
      return proofPath ? ` <${proofPath}> ` : "";
    },
  );
}

function pathFromUri(value) {
  if (!value) return undefined;

  try {
    if (value.startsWith("file://")) return fileURLToPath(value);
    if (value.startsWith("/")) return decodeURIComponent(value);

    const url = new URL(value);
    return decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
}

function usablePngPath(value) {
  let candidate = value.trim().replace(/^<|>$/g, "").replace(/\\ /g, " ");

  try {
    if (candidate.startsWith("file://")) candidate = fileURLToPath(candidate);
    else {
      try {
        candidate = decodeURIComponent(candidate);
      } catch {
        // A literal percent sign is valid in a local filename.
      }
    }
  } catch {
    return undefined;
  }

  const pngEnd = candidate.toLowerCase().lastIndexOf(".png");
  if (pngEnd === -1) return undefined;
  candidate = candidate.slice(0, pngEnd + 4);

  try {
    if (!existsSync(candidate)) return undefined;
    const resolved = realpathSync(candidate);
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size < 1 || stat.size > 10 * 1024 * 1024) {
      return undefined;
    }
    return resolved;
  } catch {
    return undefined;
  }
}
