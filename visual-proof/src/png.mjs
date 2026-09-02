import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_DIMENSION = 8_192;
const MAX_PIXELS = 20_000_000;

export function decodePng(source) {
  if (!Buffer.isBuffer(source) || source.length < PNG_SIGNATURE.length) {
    throw new Error("the proof is not a PNG file");
  }
  if (!source.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("the proof has an invalid PNG signature");
  }

  let offset = PNG_SIGNATURE.length;
  let header;
  let palette;
  let transparency;
  const imageData = [];
  let reachedEnd = false;

  while (offset < source.length) {
    if (source.length - offset < 12) throw new Error("the PNG contains a truncated chunk");
    const length = source.readUInt32BE(offset);
    const type = source.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > source.length) {
      throw new Error(`the PNG contains a truncated ${type || "unknown"} chunk`);
    }
    const data = source.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      if (header || data.length !== 13) throw new Error("the PNG has an invalid IHDR chunk");
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") transparency = Buffer.from(data);
    else if (type === "IDAT") imageData.push(Buffer.from(data));
    else if (type === "IEND") {
      reachedEnd = true;
      break;
    }
    offset = chunkEnd;
  }

  validateHeader(header, imageData, reachedEnd, palette);
  const channels = channelsFor(header.colorType);
  const stride = header.width * channels;
  const expectedBytes = (stride + 1) * header.height;
  const inflated = inflateSync(Buffer.concat(imageData), { maxOutputLength: expectedBytes });
  if (inflated.length !== expectedBytes) {
    throw new Error("the PNG decompressed to an unexpected size");
  }

  const scanlines = unfilter(inflated, header.width, header.height, channels);
  return {
    width: header.width,
    height: header.height,
    rgba: toRgba(scanlines, header, palette, transparency),
  };
}

function validateHeader(header, imageData, reachedEnd, palette) {
  if (!header) throw new Error("the PNG has no IHDR chunk");
  if (!reachedEnd) throw new Error("the PNG has no IEND chunk");
  if (imageData.length === 0) throw new Error("the PNG has no image data");
  if (
    header.width < 1 ||
    header.height < 1 ||
    header.width > MAX_DIMENSION ||
    header.height > MAX_DIMENSION ||
    header.width * header.height > MAX_PIXELS
  ) throw new Error("the PNG dimensions exceed the viewer limit");
  if (header.bitDepth !== 8) throw new Error("the viewer supports only 8-bit PNG files");
  if (![0, 2, 3, 4, 6].includes(header.colorType)) {
    throw new Error(`the viewer does not support PNG color type ${header.colorType}`);
  }
  if (header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) {
    throw new Error("the viewer supports only standard non-interlaced PNG files");
  }
  if (header.colorType === 3 && (!palette || palette.length === 0 || palette.length % 3 !== 0)) {
    throw new Error("the indexed PNG has an invalid palette");
  }
}

function channelsFor(colorType) {
  return { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
}

function unfilter(source, width, height, channels) {
  const stride = width * channels;
  const output = Buffer.allocUnsafe(stride * height);
  let inputOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = source[inputOffset++];
    if (filter > 4) throw new Error(`the PNG uses invalid filter ${filter}`);
    const rowOffset = row * stride;
    const previousOffset = rowOffset - stride;
    for (let column = 0; column < stride; column += 1) {
      const raw = source[inputOffset + column];
      const left = column >= channels ? output[rowOffset + column - channels] : 0;
      const up = row > 0 ? output[previousOffset + column] : 0;
      const upLeft = row > 0 && column >= channels ? output[previousOffset + column - channels] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      else if (filter === 2) prediction = up;
      else if (filter === 3) prediction = Math.floor((left + up) / 2);
      else if (filter === 4) prediction = paeth(left, up, upLeft);
      output[rowOffset + column] = (raw + prediction) & 0xff;
    }
    inputOffset += stride;
  }
  return output;
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonalDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left;
  if (upDistance <= diagonalDistance) return up;
  return upLeft;
}

function toRgba(source, header, palette, transparency) {
  const pixels = header.width * header.height;
  const output = Buffer.allocUnsafe(pixels * 4);
  const channels = channelsFor(header.colorType);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const input = pixel * channels;
    const target = pixel * 4;
    if (header.colorType === 0) {
      output.fill(source[input], target, target + 3);
      output[target + 3] = 255;
    } else if (header.colorType === 2) {
      output[target] = source[input];
      output[target + 1] = source[input + 1];
      output[target + 2] = source[input + 2];
      output[target + 3] = 255;
    } else if (header.colorType === 3) {
      const index = source[input];
      const paletteOffset = index * 3;
      if (paletteOffset + 2 >= palette.length) {
        throw new Error("the PNG references a palette color that does not exist");
      }
      output[target] = palette[paletteOffset];
      output[target + 1] = palette[paletteOffset + 1];
      output[target + 2] = palette[paletteOffset + 2];
      output[target + 3] = transparency?.[index] ?? 255;
    } else if (header.colorType === 4) {
      output.fill(source[input], target, target + 3);
      output[target + 3] = source[input + 1];
    } else {
      output[target] = source[input];
      output[target + 1] = source[input + 1];
      output[target + 2] = source[input + 2];
      output[target + 3] = source[input + 3];
    }
  }
  return output;
}
