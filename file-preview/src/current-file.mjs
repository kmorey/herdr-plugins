import { existsSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function currentFilePaths(ansi) {
  const text = expandFileLinks(ansi)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
  const candidates = [];
  const absolutePath = String.raw`(?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])`;
  const patterns = [
    new RegExp(
      String.raw`\]\(\s*<?(${absolutePath}[^>\r\n]*?\.(?:png|mp4))(?::\d+)?(?:>\s*)?\)`,
      "gi",
    ),
    new RegExp(String.raw`<(${absolutePath}[^>\r\n]*?\.(?:png|mp4))>`, "gi"),
    new RegExp(
      String.raw`\(\s*(${absolutePath}[^)\r\n]*?\.(?:png|mp4))\s*\)`,
      "gi",
    ),
    new RegExp(
      String.raw`${absolutePath}(?:[^\s()[\]{}'\x22\x60<>]|\\ )+?\.(?:png|mp4)`,
      "gi",
    ),
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1] || match[0];
      const proofPath = usableMediaPath(value);
      if (proofPath) candidates.push({ index: match.index, path: proofPath });
    }
  }

  candidates.sort((left, right) => left.index - right.index);
  const latest = [];
  const seen = new Set();
  for (let index = candidates.length - 1; index >= 0 && latest.length < 3; index -= 1) {
    const candidate = candidates[index];
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    latest.push(candidate.path);
  }
  return latest.reverse();
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

function usableMediaPath(value) {
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

  const extension = /\.(png|mp4)$/i.exec(candidate)?.[1].toLowerCase();
  if (!extension) return undefined;

  try {
    if (!existsSync(candidate)) return undefined;
    const resolved = realpathSync(candidate);
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size < 1 || (extension === "png" && stat.size > 10 * 1024 * 1024)) {
      return undefined;
    }
    return resolved;
  } catch {
    return undefined;
  }
}
