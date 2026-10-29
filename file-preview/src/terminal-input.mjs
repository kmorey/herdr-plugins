import { Transform } from "node:stream";

const ESCAPE_DELAY_MS = 40;
const MAX_REPLY_BYTES = 4096;

// Consume terminal replies before readline sees them. In particular, an APC's
// ESC prefix or its error text must never close the viewer or invoke shortcuts.
export class TerminalInput extends Transform {
  #state = "text";
  #sequence = [];
  #oversized = false;
  #timer;

  _transform(chunk, _encoding, callback) {
    clearTimeout(this.#timer);
    const text = [];
    const flushText = () => {
      if (text.length) this.push(Buffer.from(text.splice(0)));
    };
    for (const byte of chunk) {
      // Ctrl+C is an out-of-band escape hatch even for unterminated or
      // oversized replies. Discard the partial sequence; never replay payload.
      if (byte === 0x03) {
        this.#reset();
        text.push(byte);
      } else if (this.#state === "text") {
        if (byte === 0x1b) {
          flushText();
          this.#state = "escape";
          this.#sequence = [byte];
        } else text.push(byte);
      } else if (this.#state === "escape") {
        this.#sequence.push(byte);
        if (byte === 0x5f) this.#state = "apc";
        else if (byte === 0x5b) this.#state = "csi";
        else {
          text.push(...this.#sequence);
          this.#reset();
        }
      } else if (this.#state === "apc" || this.#state === "apc-escape") {
        const ended = this.#state === "apc-escape" && byte === 0x5c;
        this.#append(byte);
        if (ended) {
          if (!this.#oversized) {
            const reply = Buffer.from(this.#sequence).toString("ascii");
            const match = /^\x1b_Gi=(\d+)(?:,p=(\d+))?;([^\x00-\x1f\x7f]*)\x1b\\$/.exec(reply);
            if (match) this.emit("graphics", { id: Number(match[1]), placementId: match[2] === undefined ? undefined : Number(match[2]), message: match[3] });
          }
          this.#reset();
        } else this.#state = byte === 0x1b ? "apc-escape" : "apc";
      } else if (this.#state === "csi") {
        this.#append(byte);
        if (byte >= 0x40 && byte <= 0x7e) {
          if (!this.#oversized) {
            const reply = Buffer.from(this.#sequence).toString("ascii");
            const cell = /^\x1b\[6;(\d+);(\d+)t$/.exec(reply);
            if (cell) this.emit("cell", { width: Number(cell[2]), height: Number(cell[1]) });
            else if (/^\x1b\[[?>][\d;]*c$/.test(reply)) this.emit("attributes");
            else text.push(...this.#sequence);
          }
          this.#reset();
        }
      }
    }
    flushText();
    // Only an ambiguous keyboard escape prefix gets a short deadline. Known
    // replies may be split across reads or delayed well beyond that deadline.
    if (this.#state === "escape" || (this.#state === "csi" && !this.#isReplyPrefix())) {
      this.#timer = setTimeout(() => {
        this.push(Buffer.from(this.#sequence));
        this.#reset();
      }, ESCAPE_DELAY_MS);
    }
    callback();
  }

  #append(byte) {
    if (this.#sequence.length < MAX_REPLY_BYTES) this.#sequence.push(byte);
    else this.#oversized = true;
  }

  #isReplyPrefix() {
    const prefix = Buffer.from(this.#sequence).toString("ascii");
    return /^\x1b\[(?:[?>]|6;)/.test(prefix) || this.#oversized;
  }

  #reset() {
    this.#state = "text";
    this.#sequence = [];
    this.#oversized = false;
  }

  _flush(callback) {
    clearTimeout(this.#timer);
    if (this.#state === "escape" || (this.#state === "csi" && !this.#isReplyPrefix())) this.push(Buffer.from(this.#sequence));
    this.#reset();
    callback();
  }

  _destroy(error, callback) {
    clearTimeout(this.#timer);
    this.#reset();
    callback(error);
  }
}
