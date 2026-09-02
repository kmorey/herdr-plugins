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
  const stream = await openStream(socketPath, paneId);
  return {
    cell: {
      width: info.cell_width_px,
      height: info.cell_height_px,
    },
    renderPng(data, image, placement) {
      const header = {
        format: "png",
        image_width: image.width,
        image_height: image.height,
        data_length: data.length,
        placement,
      };
      stream.write(`${JSON.stringify(header)}\n`);
      stream.write(data);
    },
    close() {
      stream.end();
    },
  };
}

function request(socketPath, method, params) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    readResponse(socket, method, resolve, reject);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: `visual-proof:${method}`, method, params })}\n`);
    });
  });
}

function openStream(socketPath, paneId) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    readResponse(socket, "pane.graphics.stream", () => resolve(socket), reject, false);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        id: "visual-proof:stream",
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
    if (destroy) socket.destroy();
    callback(value);
  };

  socket.setEncoding("utf8");
  socket.once("error", (error) => settle(reject, error));
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
