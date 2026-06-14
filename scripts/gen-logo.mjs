#!/usr/bin/env node
/**
 * scripts/gen-logo.mjs — ForgeDock PNG → half-block ANSI art converter
 *
 * Zero-dependency PNG parser that uses Node.js built-in zlib to decompress
 * PNG IDAT chunks and extract RGBA pixel data. Converts each pair of vertical
 * pixel rows into a Unicode ▀ (U+2580 UPPER HALF BLOCK) with 24-bit ANSI
 * color (fg = upper pixel, bg = lower pixel), producing embedded art suitable
 * for pasting into the LOGO_ART_TRUECOLOR constant in bin/tui.mjs.
 *
 * Usage:
 *   node scripts/gen-logo.mjs <input.png> [--width <cols>] [--brand-r R --brand-g G --brand-b B]
 *
 * Options:
 *   <input.png>            Path to source PNG (recommended: 40×40 or 80×80 px)
 *   --width <cols>         Output width in terminal columns (default: 20)
 *   --brand-r <0-255>      Override brand color red channel (default: 88)
 *   --brand-g <0-255>      Override brand color green channel (default: 166)
 *   --brand-b <0-255>      Override brand color blue channel (default: 255)
 *   --threshold <0-255>    Pixel brightness threshold for fg/bg (default: 128)
 *   --help                 Show this help
 *
 * Limitations:
 *   - Supports RGB and RGBA PNG files (bit depth 8). Interlaced PNGs are not supported.
 *   - Palette (indexed) PNGs are not supported.
 *   - Grayscale PNGs are supported (treated as single-channel brightness).
 *   - The script re-colorizes pixels: bright pixels → brand blue, dark pixels → background.
 *     For a multi-color logo, remove the re-colorize step and use original pixel RGB values.
 *
 * Output:
 *   Prints a JavaScript snippet with the LOGO_ART_TRUECOLOR array contents to stdout.
 *   Redirect to a file and paste into bin/tui.mjs to update the embedded art.
 *
 * Example:
 *   node scripts/gen-logo.mjs assets/logo.png --width 24 > /tmp/logo-art.js
 */

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  process.stdout.write(`
Usage: node scripts/gen-logo.mjs <input.png> [options]

Options:
  --width <cols>         Output width in terminal columns (default: 20)
  --brand-r <0-255>      Brand color red channel (default: 88)
  --brand-g <0-255>      Brand color green channel (default: 166)
  --brand-b <0-255>      Brand color blue channel (default: 255)
  --bg-r <0-255>         Background color red channel (default: 13)
  --bg-g <0-255>         Background color green channel (default: 17)
  --bg-b <0-255>         Background color blue channel (default: 23)
  --threshold <0-255>    Brightness cutoff fg/bg (default: 128)
  --help                 Show this help

Example:
  node scripts/gen-logo.mjs assets/logo.png --width 24
`);
  process.exit(0);
}

function getArg(name, defaultValue) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return defaultValue;
  return Number(args[idx + 1]);
}

const inputPath = args.find((a) => !a.startsWith("--"));
if (!inputPath) {
  process.stderr.write("Error: no input PNG path provided.\n");
  process.exit(1);
}

const outputWidth  = getArg("--width",     20);
const brandR       = getArg("--brand-r",   88);
const brandG       = getArg("--brand-g",  166);
const brandB       = getArg("--brand-b",  255);
const bgR          = getArg("--bg-r",      13);
const bgG          = getArg("--bg-g",      17);
const bgB          = getArg("--bg-b",      23);
const threshold    = getArg("--threshold", 128);

// ---------------------------------------------------------------------------
// PNG parser
// ---------------------------------------------------------------------------

/**
 * Read a 4-byte big-endian unsigned int from a Buffer at offset.
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {number}
 */
function readUint32BE(buf, offset) {
  return (
    ((buf[offset] & 0xff) << 24) |
    ((buf[offset + 1] & 0xff) << 16) |
    ((buf[offset + 2] & 0xff) << 8) |
    (buf[offset + 3] & 0xff)
  ) >>> 0;
}

/**
 * Parse a PNG file and return an object with { width, height, pixels }.
 * pixels is a Uint8Array of RGBA values (width * height * 4 bytes, row-major).
 *
 * @param {Buffer} data - Raw PNG file bytes
 * @returns {{ width: number, height: number, pixels: Uint8Array }}
 */
function parsePng(data) {
  // Verify PNG signature: 8 bytes
  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (data[i] !== PNG_SIG[i]) throw new Error("Not a valid PNG file.");
  }

  let width = 0, height = 0;
  let bitDepth = 0, colorType = 0;
  const idatChunks = [];
  let pos = 8; // after signature

  // Parse chunks
  while (pos < data.length) {
    const length = readUint32BE(data, pos);
    const type = data.slice(pos + 4, pos + 8).toString("ascii");
    const chunkData = data.slice(pos + 8, pos + 8 + length);
    pos += 12 + length; // 4 (length) + 4 (type) + length + 4 (crc)

    if (type === "IHDR") {
      width     = readUint32BE(chunkData, 0);
      height    = readUint32BE(chunkData, 4);
      bitDepth  = chunkData[8];
      colorType = chunkData[9];
      const interlace = chunkData[12];

      if (bitDepth !== 8) {
        throw new Error(`Unsupported PNG bit depth: ${bitDepth}. Only 8-bit PNGs are supported.`);
      }
      if (interlace !== 0) {
        throw new Error("Interlaced PNGs are not supported. Save as non-interlaced.");
      }
      // colorType: 0=grayscale, 2=RGB, 3=palette, 4=grayscale+alpha, 6=RGBA
      if (colorType === 3) {
        throw new Error("Palette (indexed) PNGs are not supported. Convert to RGB or RGBA.");
      }
    } else if (type === "IDAT") {
      idatChunks.push(chunkData);
    } else if (type === "IEND") {
      break;
    }
  }

  if (!width || !height) throw new Error("PNG IHDR chunk not found or invalid.");
  if (idatChunks.length === 0) throw new Error("No IDAT chunks found in PNG.");

  // Decompress all IDAT chunks concatenated
  const compressed = Buffer.concat(idatChunks);
  const raw = inflateSync(compressed);

  // Channels per pixel
  let channels;
  switch (colorType) {
    case 0: channels = 1; break; // grayscale
    case 2: channels = 3; break; // RGB
    case 4: channels = 2; break; // grayscale+alpha
    case 6: channels = 4; break; // RGBA
    default: throw new Error(`Unsupported PNG color type: ${colorType}`);
  }

  const bytesPerRow = 1 + width * channels; // 1 filter byte + pixel data
  const pixels = new Uint8Array(width * height * 4); // output is always RGBA

  // PNG filter reconstruction (method 0 only — per-row adaptive filtering)
  // Prior row for Up/Average/Paeth filters
  const prevRow = new Uint8Array(width * channels);

  for (let y = 0; y < height; y++) {
    const rowStart = y * bytesPerRow;
    const filterType = raw[rowStart];
    const scanline = raw.slice(rowStart + 1, rowStart + 1 + width * channels);
    const recon = new Uint8Array(width * channels);

    for (let i = 0; i < scanline.length; i++) {
      const a = i >= channels ? recon[i - channels] : 0; // left
      const b = prevRow[i];                               // above
      const c = i >= channels ? prevRow[i - channels] : 0; // above-left

      let val;
      switch (filterType) {
        case 0: // None
          val = scanline[i];
          break;
        case 1: // Sub
          val = (scanline[i] + a) & 0xff;
          break;
        case 2: // Up
          val = (scanline[i] + b) & 0xff;
          break;
        case 3: // Average
          val = (scanline[i] + Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4: // Paeth
          val = (scanline[i] + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`Unknown PNG filter type: ${filterType} at row ${y}`);
      }
      recon[i] = val;
    }

    prevRow.set(recon);

    // Convert to RGBA
    for (let x = 0; x < width; x++) {
      const srcIdx = x * channels;
      const dstIdx = (y * width + x) * 4;

      switch (colorType) {
        case 0: // grayscale
          pixels[dstIdx]     = recon[srcIdx];
          pixels[dstIdx + 1] = recon[srcIdx];
          pixels[dstIdx + 2] = recon[srcIdx];
          pixels[dstIdx + 3] = 255;
          break;
        case 2: // RGB
          pixels[dstIdx]     = recon[srcIdx];
          pixels[dstIdx + 1] = recon[srcIdx + 1];
          pixels[dstIdx + 2] = recon[srcIdx + 2];
          pixels[dstIdx + 3] = 255;
          break;
        case 4: // grayscale+alpha
          pixels[dstIdx]     = recon[srcIdx];
          pixels[dstIdx + 1] = recon[srcIdx];
          pixels[dstIdx + 2] = recon[srcIdx];
          pixels[dstIdx + 3] = recon[srcIdx + 1];
          break;
        case 6: // RGBA
          pixels[dstIdx]     = recon[srcIdx];
          pixels[dstIdx + 1] = recon[srcIdx + 1];
          pixels[dstIdx + 2] = recon[srcIdx + 2];
          pixels[dstIdx + 3] = recon[srcIdx + 3];
          break;
      }
    }
  }

  return { width, height, pixels };
}

/**
 * Paeth predictor for PNG filter type 4.
 */
function paethPredictor(a, b, c) {
  const p  = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ---------------------------------------------------------------------------
// Image → half-block ANSI art
// ---------------------------------------------------------------------------

/**
 * Sample RGBA pixels from a source image at a given (x, y) in [0..1] space,
 * using nearest-neighbor sampling.
 *
 * @param {Uint8Array} pixels - RGBA pixel data
 * @param {number} srcW - Source image width
 * @param {number} srcH - Source image height
 * @param {number} u - Normalized x in [0..1]
 * @param {number} v - Normalized y in [0..1]
 * @returns {{ r: number, g: number, b: number, a: number }}
 */
function samplePixel(pixels, srcW, srcH, u, v) {
  const x = Math.min(Math.floor(u * srcW), srcW - 1);
  const y = Math.min(Math.floor(v * srcH), srcH - 1);
  const idx = (y * srcW + x) * 4;
  return {
    r: pixels[idx],
    g: pixels[idx + 1],
    b: pixels[idx + 2],
    a: pixels[idx + 3],
  };
}

/**
 * Compute perceptual brightness of an RGB pixel (ITU-R BT.601 luma).
 */
function brightness({ r, g, b, a }) {
  // Transparent pixels count as background
  if (a < 32) return 0;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Convert a parsed PNG to half-block ANSI art lines.
 *
 * The source image is scaled to outputWidth × (outputWidth * aspect) using
 * nearest-neighbor sampling. Each pair of vertical pixel rows maps to one
 * terminal row via ▀ (upper pixel = fg, lower pixel = bg).
 *
 * Pixels brighter than `threshold` are re-colorized to brand blue;
 * darker pixels become the background color.
 *
 * @param {{ width: number, height: number, pixels: Uint8Array }} png
 * @returns {string[]} Array of ANSI-decorated terminal lines
 */
function pngToHalfBlockLines(png) {
  const { width: srcW, height: srcH, pixels } = png;

  // Terminal cells are roughly 2:1 height:width in most fonts, so
  // each half-block row represents 2 pixel rows. The output height
  // (in half-block rows) maintains the aspect ratio.
  const outputHeight = Math.round((outputWidth * srcH) / srcW);
  // Round up to even so every row has a lower partner
  const pixelRows = outputHeight % 2 === 0 ? outputHeight : outputHeight + 1;

  const lines = [];

  for (let row = 0; row < pixelRows; row += 2) {
    let line = "";
    for (let col = 0; col < outputWidth; col++) {
      const u = (col + 0.5) / outputWidth;
      const vUpper = (row + 0.5) / pixelRows;
      const vLower = (row + 1.5) / pixelRows;

      const upper = samplePixel(pixels, srcW, srcH, u, vUpper);
      const lower = samplePixel(pixels, srcW, srcH, u, vLower);

      const upperBright = brightness(upper) >= threshold;
      const lowerBright = brightness(lower) >= threshold;

      const [fgR, fgG, fgB] = upperBright
        ? [brandR, brandG, brandB]
        : [bgR, bgG, bgB];
      const [bgRc, bgGc, bgBc] = lowerBright
        ? [brandR, brandG, brandB]
        : [bgR, bgG, bgB];

      line += `\x1b[38;2;${fgR};${fgG};${fgB}m\x1b[48;2;${bgRc};${bgGc};${bgBc}m▀\x1b[0m`;
    }
    lines.push(line);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let pngData;
try {
  pngData = readFileSync(inputPath);
} catch (err) {
  process.stderr.write(`Error reading file "${inputPath}": ${err.message}\n`);
  process.exit(1);
}

let png;
try {
  png = parsePng(pngData);
} catch (err) {
  process.stderr.write(`PNG parse error: ${err.message}\n`);
  process.exit(1);
}

process.stderr.write(
  `Input: ${png.width}×${png.height} px → Output: ${outputWidth} cols × ~${Math.round((outputWidth * png.height) / png.width)} rows\n`,
);

const artLines = pngToHalfBlockLines(png);

// Output as a JavaScript string literal fragment ready for LOGO_ART_TRUECOLOR
process.stdout.write("// paste into LOGO_ART_TRUECOLOR in bin/tui.mjs:\n");
process.stdout.write("const artLines = [\n");
for (const line of artLines) {
  // Escape the string for embedding in JS source
  const escaped = JSON.stringify(line);
  process.stdout.write(`  ${escaped},\n`);
}
process.stdout.write("];\n");
