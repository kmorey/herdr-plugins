import net from "node:net";

const REQUEST_TIMEOUT_MS = 2_000;

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

export async function openPaneGraphics({ socketPath, paneId }) {
  if (!socketPath || !paneId) throw new Error("Herdr graphics context is missing");

  const info = await request(socketPath, "pane.graphics.info", { pane_id: paneId });
  let stream = await openStream(socketPath, paneId);
  return {
    cell: {
      width: info.cell_width_px,
      height: info.cell_height_px,
    },
    async renderPng(data, image, placement) {
      if (!stream || stream.destroyed) stream = await openStream(socketPath, paneId);
      const header = {
        format: "png",
        image_width: image.width,
        image_height: image.height,
        data_length: data.length,
        placement,
      };
      await new Promise((resolve, reject) => {
        const active = stream;
        const timer = setTimeout(() => {
          active.destroy();
          reject(new Error("Herdr graphics write timed out"));
        }, REQUEST_TIMEOUT_MS);
        active.write(`${JSON.stringify(header)}\n`);
        active.write(data, (error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        });
      });
    },
    close() {
      stream?.end();
    },
    async clear() {
      const active = stream;
      stream = undefined;
      // Herdr rejects clearing a layer until its streaming connection has ended.
      if (active && !active.closed) await endStream(active);
      return request(socketPath, "pane.graphics.clear", { pane_id: paneId, layer_id: "primary" });
    },
  };
}

function endStream(stream) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new Error("Herdr graphics stream did not close"));
    }, REQUEST_TIMEOUT_MS);
    stream.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    stream.end();
  });
}

function request(socketPath, method, params) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    readResponse(socket, method, resolve, reject);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: `file-preview:${method}`, method, params })}\n`);
    });
  });
}

function openStream(socketPath, paneId) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    readResponse(socket, "pane.graphics.stream", () => resolve(socket), reject, false);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        id: "file-preview:stream",
        method: "pane.graphics.stream",
        params: { pane_id: paneId, layer_id: "primary", z_index: 0 },
      })}\n`);
    });
  });
}

function readResponse(socket, method, resolve, reject, destroy = true) {
  let buffer = "";
  let settled = false;
  const timeout = setTimeout(() => settle(reject, new Error(`Herdr request timed out: ${method}`)), REQUEST_TIMEOUT_MS);
  const settle = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (destroy || callback === reject) socket.destroy();
    callback(value);
  };

  socket.setEncoding("utf8");
  socket.once("error", (error) => settle(reject, error));
  socket.once("close", () => settle(reject, new Error(`Herdr connection closed: ${method}`)));
  socket.on("data", (chunk) => {
    if (settled) return;
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    try {
      const response = JSON.parse(buffer.slice(0, newline));
      if (response.error) {
        settle(reject, new Error(response.error.message ?? `Herdr request failed: ${method}`));
      } else {
        settle(resolve, response.result);
      }
    } catch {
      settle(reject, new Error("Invalid Herdr API response"));
    }
  });
}
