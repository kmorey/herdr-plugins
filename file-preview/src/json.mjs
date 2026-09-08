export function formatJson(text) {
  try {
    // Validation only: serializing the parsed value would round large numbers.
    JSON.parse(text);
  } catch {
    return { formatted: text, diagnostic: "Invalid JSON — showing original source" };
  }
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g);
  const output = [];
  let depth = 0;
  // Cap visual indentation so deeply nested input cannot expand quadratically.
  const newline = () => `\n${"  ".repeat(Math.min(depth, 32))}`;
  tokens.forEach((token, index) => {
    if (token === "{" || token === "[") {
      output.push(token);
      depth++;
      if (tokens[index + 1] !== "}" && tokens[index + 1] !== "]") output.push(newline());
    } else if (token === "}" || token === "]") {
      depth--;
      if (tokens[index - 1] !== "{" && tokens[index - 1] !== "[") output.push(newline());
      output.push(token);
    } else if (token === ",") output.push(",", newline());
    else if (token === ":") output.push(": ");
    else output.push(token);
  });
  return { formatted: output.join("") };
}
