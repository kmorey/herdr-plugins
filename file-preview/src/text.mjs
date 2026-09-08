import { stripVTControlCharacters } from "node:util";
import { marked } from "marked";
import wrapAnsi from "wrap-ansi";

export function safeText(value) {
  return value.replace(/\r\n|\r/g, "\n").replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export function textRows(text, width) {
  return wrapAnsi(text, width, { hard: true, trim: false, wordWrap: false }).split("\n");
}

export function layoutText(text, width) {
  let start = 0;
  const rows = text.split("\n").flatMap((line) => {
    const wrapped = textRows(line, width).map((ansi) => {
      const plain = stripVTControlCharacters(ansi);
      const row = { ansi, text: plain, start };
      start += plain.length;
      return row;
    });
    start++;
    return wrapped;
  });
  return { rows, text: stripVTControlCharacters(text) };
}

export function documentText(artifact, source = false) {
  if (artifact.type === "json") return safeText(artifact.formatted);
  const text = safeText(artifact.text);
  return artifact.type === "markdown" && !source ? blocks(marked.lexer(text)).trimEnd() : text;
}

const style = (code, text) => `\x1b[${code}m${text}\x1b[0m`;

function inline(tokens = []) {
  return tokens.map((token) => {
    const content = token.tokens ? inline(token.tokens) : token.text ?? "";
    switch (token.type) {
      case "strong": return style(1, content);
      case "em": return style(3, content);
      case "del": return style(9, content);
      case "codespan": return style(33, token.text);
      case "link": return `${style(4, content)} (${token.href})`;
      case "image": return `[Image: ${token.text}] (${token.href})`;
      case "br": return "\n";
      default: return content;
    }
  }).join("");
}

function blocks(tokens) {
  return tokens.map((token) => {
    switch (token.type) {
      case "space": return "\n";
      case "heading": return `${style("1;36", inline(token.tokens))}\n`;
      case "paragraph": case "text": return `${inline(token.tokens ?? [{ text: token.text }])}\n`;
      case "code": return `${token.text.split("\n").map((line) => `  ${style(33, line)}`).join("\n")}\n`;
      case "blockquote": return `${blocks(token.tokens).trimEnd().split("\n").map((line) => `│ ${line}`).join("\n")}\n`;
      case "list": return `${token.items.map((item, i) => {
        const prefix = token.ordered ? `${Number(token.start) + i}. ` : "• ";
        const content = blocks(item.tokens).trimEnd().split("\n");
        return `${prefix}${item.task ? (item.checked ? "[x] " : "[ ] ") : ""}${content.join(`\n${" ".repeat(prefix.length)}`)}`;
      }).join("\n")}\n`;
      case "table": return `${[token.header, ...token.rows].map((row) => row.map((cell) => inline(cell.tokens)).join(" │ ")).join("\n")}\n`;
      case "hr": return "────────────\n";
      case "def": case "checkbox": return "";
      default: return `${token.text ?? token.raw ?? ""}\n`;
    }
  }).join("");
}
