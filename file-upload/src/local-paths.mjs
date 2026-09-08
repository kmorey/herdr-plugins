import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Parse terminal-drop quoting as data. Never evaluate expansions or run a shell.
export function parsePaths(text) {
  if (Buffer.byteLength(text) > 16 * 1024 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(text)) {
    throw new Error('The dropped paths contain unsupported control characters or are too long.');
  }
  const words = [];
  let word = '';
  let quote = '';
  let escaped = false;
  for (const character of text.trim()) {
    if (escaped) {
      if (quote === '"' && !['"', '\\', '$', '`'].includes(character)) word += '\\';
      word += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = '';
      else word += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (word) words.push(word);
      word = '';
    } else {
      word += character;
    }
  }
  if (quote || escaped) throw new Error('The dropped paths have incomplete quoting.');
  if (word) words.push(word);
  if (!words.length || words.length > 32) throw new Error('Drop between 1 and 32 individual files.');
  return words.map((value) => {
    const path = value.startsWith('file:') ? fileURLToPath(value)
      : value.startsWith('~/') ? `${homedir()}/${value.slice(2)}` : value;
    if (!isAbsolute(path) || /[\x00-\x1f\x7f-\x9f]/u.test(path)) {
      throw new Error('Drop absolute local paths or local file:// URLs.');
    }
    return path;
  });
}

export function readDroppedPaths(input = process.stdin, output = process.stdout) {
  if (!input.isTTY) throw new Error('The local helper needs a Kitty terminal.');
  return new Promise((resolve, reject) => {
    let text = '';
    let paste = false;
    let pending = '';
    const wasRaw = input.isRaw;
    const finish = (value, error) => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write('\x1b[?2004l\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onEnd = () => finish(null);
    const onError = (error) => finish(null, error);
    const onData = (chunk) => {
      pending += chunk;
      while (pending) {
        if (pending.startsWith('\x1b[200~')) {
          paste = true;
          pending = pending.slice(6);
          continue;
        }
        if (pending.startsWith('\x1b[201~')) {
          if (paste) return finish(text);
          pending = pending.slice(6);
          continue;
        }
        if ('\x1b[200~'.startsWith(pending) || '\x1b[201~'.startsWith(pending)) return;
        const character = String.fromCodePoint(pending.codePointAt(0));
        pending = pending.slice(character.length);
        if (!paste) {
          if (character === '\x03' || (character === 'q' && !text)) return finish(null);
          if (character === 'b' && !text) return finish('');
          if (character === '\r' || character === '\n') return finish(text);
          if (character === '\x7f' || character === '\b') {
            text = Array.from(text).slice(0, -1).join('');
            output.write('\b \b');
            continue;
          }
        }
        text += character;
        if (!paste && character >= ' ' && character !== '\x7f') output.write(character);
        if (Buffer.byteLength(text) > 16 * 1024) return finish(null, new Error('The dropped path list is too long.'));
      }
    };
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    output.write('\x1b[?2004h');
    input.resume();
  });
}
