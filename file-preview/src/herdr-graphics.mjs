import { randomInt } from "node:crypto";

const REQUEST_TIMEOUT_MS = 2_000;
const READINESS_RETRY_MS = 50;
const READINESS_TIMEOUT_MS = 2_000;
export function imagePlacement(image, terminal, cell, chrome = { top: 3, bottom: 2 }) {
  const availableColumns = Math.max(1, terminal.columns - 2);
  const availableRows = Math.max(1, terminal.rows - chrome.top - chrome.bottom);
  const cellWidth = Math.max(1, cell.width);
  const cellHeight = Math.max(1, cell.height);
  const scale = Math.min(
    (availableColumns * cellWidth) / image.width,
    (availableRows * cellHeight) / image.height,
  );
  const gridColumns = Math.min(
    availableColumns,
    Math.max(1, Math.round((image.width * scale) / cellWidth)),
  );
  const gridRows = Math.min(
    availableRows,
    Math.max(1, Math.round((image.height * scale) / cellHeight)),
  );

  return {
    viewport_col: 1 + Math.floor((availableColumns - gridColumns) / 2),
    viewport_row: chrome.top + Math.floor((availableRows - gridRows) / 2),
    grid_cols: gridColumns,
    grid_rows: gridRows,
  };
}

export function fittedImageFrame(image, terminal, cell, chrome = { top: 3, bottom: 2 }) {
  const placement = imagePlacement(image, terminal, cell, chrome);
  const width = placement.grid_cols * Math.max(1, cell.width);
  const height = placement.grid_rows * Math.max(1, cell.height);
  const scale = Math.min(width / image.width, height / image.height);
  const contentWidth = Math.max(1, Math.floor(image.width * scale));
  const contentHeight = Math.max(1, Math.floor(image.height * scale));
  const content = {
    x: Math.floor((width - contentWidth) / 2),
    y: Math.floor((height - contentHeight) / 2),
    width: contentWidth,
    height: contentHeight,
  };
  const rgba = Buffer.alloc(width * height * 4);
  resizeRgba(
    image.rgba,
    image.width,
    image.height,
    rgba,
    width,
    content.x,
    content.y,
    contentWidth,
    contentHeight,
  );
  return { width, height, rgba, placement, content };
}

function resizeRgba(
  source,
  sourceWidth,
  sourceHeight,
  output,
  outputWidth,
  outputX,
  outputY,
  targetWidth,
  targetHeight,
) {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
    for (let row = 0; row < targetHeight; row += 1) {
      source.copy(
        output,
        ((outputY + row) * outputWidth + outputX) * 4,
        row * sourceWidth * 4,
        (row + 1) * sourceWidth * 4,
      );
    }
    return;
  }
  const xRatio = targetWidth === 1 ? 0 : (sourceWidth - 1) / (targetWidth - 1);
  const yRatio = targetHeight === 1 ? 0 : (sourceHeight - 1) / (targetHeight - 1);
  for (let targetY = 0; targetY < targetHeight; targetY += 1) {
    const sourceY = targetY * yRatio;
    const top = Math.floor(sourceY);
    const bottom = Math.min(sourceHeight - 1, top + 1);
    const yWeight = sourceY - top;
    for (let targetX = 0; targetX < targetWidth; targetX += 1) {
      const sourceX = targetX * xRatio;
      const left = Math.floor(sourceX);
      const right = Math.min(sourceWidth - 1, left + 1);
      const xWeight = sourceX - left;
      const target = ((outputY + targetY) * outputWidth + outputX + targetX) * 4;
      const topLeft = (top * sourceWidth + left) * 4;
      const topRight = (top * sourceWidth + right) * 4;
      const bottomLeft = (bottom * sourceWidth + left) * 4;
      const bottomRight = (bottom * sourceWidth + right) * 4;
      const topLeftWeight = (1 - xWeight) * (1 - yWeight);
      const topRightWeight = xWeight * (1 - yWeight);
      const bottomLeftWeight = (1 - xWeight) * yWeight;
      const bottomRightWeight = xWeight * yWeight;
      const alpha =
        source[topLeft + 3] * topLeftWeight +
        source[topRight + 3] * topRightWeight +
        source[bottomLeft + 3] * bottomLeftWeight +
        source[bottomRight + 3] * bottomRightWeight;
      output[target + 3] = Math.round(alpha);
      if (alpha === 0) continue;
      for (let channel = 0; channel < 3; channel += 1) {
        const premultiplied =
          source[topLeft + channel] * source[topLeft + 3] * topLeftWeight +
          source[topRight + channel] * source[topRight + 3] * topRightWeight +
          source[bottomLeft + channel] * source[bottomLeft + 3] * bottomLeftWeight +
          source[bottomRight + channel] * source[bottomRight + 3] * bottomRightWeight;
        output[target + channel] = Math.round(premultiplied / alpha);
      }
    }
  }
}

export async function openPaneGraphics({ input, output, signal }) {
  if (!input || !output) throw new Error("Native graphics requires terminal input and output");
  const imageId = randomInt(1, 0x7fffffff);
  const probeId = randomInt(0x80000000, 0xffffffff);
  await exchange(input, output, "graphics", (reply) => reply.id === probeId,
    () => output.write(`\x1b_Ga=q,f=32,s=1,v=1,i=${probeId};AAAAAA==\x1b\\`), signal, "Kitty graphics query");
  const cell = await waitForReadyCell(input, output, signal);
  let closed = false;
  const clear = () => {
    // Uppercase I releases both this image's placements and its stored pixels.
    // Never delete all images: the terminal may contain another app's graphics.
    output.write(`\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`);
  };
  return {
    cell,
    async renderPng(data, _image, placement) {
      if (closed) throw new Error("Native graphics is closed");
      const encoded = data.toString("base64");
      await exchange(input, output, "graphics", (reply) => reply.id === imageId && reply.placementId === 1,
        async (sendSignal) => {
          output.write(`\x1b7\x1b[${placement.viewport_row + 1};${placement.viewport_col + 1}H`);
          try {
            for (let offset = 0; offset < encoded.length; offset += 4096) {
              if (sendSignal.aborted || closed) throw abortError();
              const more = offset + 4096 < encoded.length ? 1 : 0;
              const header = offset === 0
                ? `a=T,f=100,t=d,i=${imageId},p=1,c=${placement.grid_cols},r=${placement.grid_rows},C=1,q=0,m=${more}`
                : `m=${more},q=0`;
              await write(output, `\x1b_G${header};${encoded.slice(offset, offset + 4096)}\x1b\\`, sendSignal);
            }
          } finally {
            output.write("\x1b8");
          }
        }, signal, "Kitty image acknowledgment");
    },
    clear,
    close() {
      if (closed) return;
      clear();
      closed = true;
    },
  };
}

async function waitForReadyCell(input, output, signal) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let cell;
    try {
      // Herdr suppresses replies until metrics exist, rather than reporting zero.
      // Give each attempt a short budget, retaining one overall readiness deadline.
      cell = await exchange(input, output, "cell", () => true,
        () => output.write("\x1b[16t"), signal, "Terminal cell dimensions", Math.min(150, deadline - Date.now()));
    } catch (error) {
      if (error.code !== "GRAPHICS_TIMEOUT") throw error;
    }
    if (cell && Number.isSafeInteger(cell.width) && cell.width > 0 && Number.isSafeInteger(cell.height) && cell.height > 0) return cell;
    await delay(Math.min(READINESS_RETRY_MS, Math.max(0, deadline - Date.now())), signal);
  }
  throw new Error("Native graphics are not ready: terminal cell dimensions are unavailable");
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(abortError());
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function abortError() {
  const error = new Error("Native graphics request cancelled");
  error.code = "ABORT_ERR";
  return error;
}

function write(output, data, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => finish(abortError());
    const finish = (error) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    try { output.write(data, finish); }
    catch (error) { finish(error); }
  });
}

function exchange(input, output, event, accepts, send, signal, description, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const sender = new AbortController();
    let settled = false;
    let sent = false;
    let received = false;
    let value;
    let failure;
    const finish = () => {
      // Stop the sender and restore its cursor before callers can delete images
      // or draw an error screen. A stalled write callback must not revive it.
      if (settled || !sent || (!failure && !received)) return;
      settled = true;
      clearTimeout(timer);
      input.off(event, response);
      input.off("close", closed);
      output.off("error", failed);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve(value);
    };
    const failed = (error) => {
      if (settled || failure) return;
      failure = error;
      sender.abort();
      finish();
    };
    const response = (reply) => {
      if (!accepts(reply)) return;
      if (event === "graphics" && reply.message !== "OK") failed(new Error(`Native graphics: ${reply.message}`));
      else { received = true; value = reply; finish(); }
    };
    const abort = () => failed(abortError());
    const closed = () => failed(new Error("Terminal input closed during graphics request"));
    const timer = setTimeout(() => {
      const error = new Error(`${description} timed out`);
      error.code = "GRAPHICS_TIMEOUT";
      failed(error);
    }, Math.max(1, timeoutMs));
    input.on(event, response);
    input.once("close", closed);
    output.once("error", failed);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    // Listeners must exist before writing: terminal replies can arrive immediately.
    Promise.resolve().then(() => {
      if (sender.signal.aborted) throw abortError();
      return send(sender.signal);
    }).catch(failed).finally(() => { sent = true; finish(); });
  });
}
