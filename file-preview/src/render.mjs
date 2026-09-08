const BACKGROUND = [20, 22, 28];

export function targetSize(width, height, columns, rows) {
  const maxWidth = Math.max(1, columns - 2);
  const maxPixelHeight = Math.max(2, (rows - 6) * 2);
  const scale = Math.min(maxWidth / width, maxPixelHeight / height, 1);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

export function renderPreview(image, columns = 80, rows = 24) {
  const size = targetSize(image.width, image.height, columns, rows);
  const lines = [];
  for (let y = 0; y < size.height; y += 2) {
    let line = "";
    for (let x = 0; x < size.width; x += 1) {
      const top = sample(image, x, y, size);
      const bottom = y + 1 < size.height ? sample(image, x, y + 1, size) : BACKGROUND;
      line += `\x1b[38;2;${top.join(";")}m\x1b[48;2;${bottom.join(";")}m▀`;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join("\n");
}

function sample(image, x, y, target) {
  const sourceX = Math.min(image.width - 1, Math.floor(((x + 0.5) * image.width) / target.width));
  const sourceY = Math.min(image.height - 1, Math.floor(((y + 0.5) * image.height) / target.height));
  const offset = (sourceY * image.width + sourceX) * 4;
  const alpha = image.rgba[offset + 3] / 255;
  return [0, 1, 2].map((channel) =>
    Math.round(image.rgba[offset + channel] * alpha + BACKGROUND[channel] * (1 - alpha)),
  );
}

export function truncateMiddle(value, width) {
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  const available = width - 1;
  const start = Math.ceil(available / 2);
  const end = Math.floor(available / 2);
  return `${value.slice(0, start)}…${value.slice(value.length - end)}`;
}
