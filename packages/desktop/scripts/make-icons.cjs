'use strict';
/**
 * Draw the Girru app icon and write every format the builder needs:
 *
 *   build/icon.png   1024 px (Linux, and the dock icon when run from source)
 *   build/icon.icns  macOS, 16–1024 px with the 2× sizes
 *   build/icon.ico   Windows, 16–256 px
 *
 * The icon is the logo on the rounded macOS tile: an 824 px tile on a 1024 px
 * picture (100 px clear edge), rounded-square corners, a soft shadow below and
 * the logo at about 74% of the tile. Plain Node only: the shapes are filled with
 * 4×4 samples per pixel and the files are written by hand, so nothing is installed.
 *
 * Usage: node scripts/make-icons.cjs [--out <dir>]
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 1024;
const TILE = { cx: 512, cy: 512, half: 412, exponent: 5 };
const TILE_COLOR = [255, 255, 255];
const SHADOW = { offsetY: 10, radius: 9, alpha: 0.3 };

/** The logo mark (dpro_logo/svg/logo2), in its 500×500 drawing units; the mark fills the 400-unit square at (48, 51). */
const LOGO_VIEW = { x: 48, y: 51, size: 400, share: 0.74 };
const LOGO = [
  { color: [0xa2, 0x86, 0xbe], points: [[246.73, 293.45], [176.85, 365.19], [249.91, 436.35], [319.79, 364.61]] },
  { color: [0x65, 0x2d, 0x91], points: [[432.85, 248.54], [319.79, 364.61], [246.73, 293.45], [289.62, 249.42], [246.99, 207.9], [317.8, 136.48]] },
  { color: [0xf7, 0x94, 0x1d], points: [[204.74, 252.56], [246.73, 293.45], [176.86, 365.19], [63.06, 254.35], [175.85, 138.55], [247.63, 208.53]] },
  { color: [0xa2, 0x86, 0xbe], points: [[317.8, 136.48], [247.63, 208.53], [175.85, 138.55], [245.99, 66.53]] },
];

const insideTile = (x, y) => (Math.abs(x - TILE.cx) / TILE.half) ** TILE.exponent + (Math.abs(y - TILE.cy) / TILE.half) ** TILE.exponent <= 1;

function insidePolygon(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]; const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Premultiplied RGBA floats (0–1) of the 1024 px icon. */
function draw() {
  const scale = (2 * TILE.half * LOGO_VIEW.share) / LOGO_VIEW.size;
  const shapes = LOGO.map(({ color, points }) => ({
    color: color.map(c => c / 255),
    points: points.map(([u, v]) => [TILE.cx + (u - LOGO_VIEW.x - LOGO_VIEW.size / 2) * scale, TILE.cy + (v - LOGO_VIEW.y - LOGO_VIEW.size / 2) * scale]),
  }));
  const tileColor = TILE_COLOR.map(c => c / 255);
  const pixels = new Float32Array(SIZE * SIZE * 4);
  const coverage = new Float32Array(SIZE * SIZE);
  const N = 4;
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const x = px + (sx + 0.5) / N; const y = py + (sy + 0.5) / N;
          if (!insideTile(x, y)) continue;
          const shape = shapes.find(s => insidePolygon(s.points, x, y));
          const c = shape ? shape.color : tileColor;
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const i = py * SIZE + px; const k = N * N;
      pixels.set([r / k, g / k, b / k, a / k], i * 4);
      coverage[i] = a / k;
    }
  }
  return addShadow(pixels, coverage);
}

/** Three box blurs approximate a Gaussian; the shadow goes under the tile. */
function addShadow(pixels, coverage) {
  let mask = coverage;
  for (let pass = 0; pass < 3; pass++) mask = blur(blur(mask, 1, 0), 0, 1);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const sy = y - SHADOW.offsetY;
      const shadow = sy >= 0 ? mask[sy * SIZE + x] * SHADOW.alpha : 0;
      const i = (y * SIZE + x) * 4;
      pixels[i + 3] += shadow * (1 - pixels[i + 3]); // black shadow: colour stays, only coverage grows
    }
  }
  return pixels;
}

function blur(src, dx, dy) {
  const out = new Float32Array(src.length); const r = SHADOW.radius; const w = 2 * r + 1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let sum = 0;
      for (let t = -r; t <= r; t++) {
        const xx = x + t * dx; const yy = y + t * dy;
        if (xx >= 0 && xx < SIZE && yy >= 0 && yy < SIZE) sum += src[yy * SIZE + xx];
      }
      out[y * SIZE + x] = sum / w;
    }
  }
  return out;
}

/** Halve a premultiplied picture (2×2 average). */
function halve(pixels, size) {
  const half = size / 2; const out = new Float32Array(half * half * 4);
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < half; x++) {
      for (let c = 0; c < 4; c++) {
        const at = (yy, xx) => pixels[(yy * size + xx) * 4 + c];
        out[(y * half + x) * 4 + c] = (at(2 * y, 2 * x) + at(2 * y, 2 * x + 1) + at(2 * y + 1, 2 * x) + at(2 * y + 1, 2 * x + 1)) / 4;
      }
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** PNG (8-bit RGBA, straight alpha) from premultiplied floats. */
function png(pixels, size) {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4; const a = pixels[i + 3];
      const o = y * (size * 4 + 1) + 1 + x * 4;
      for (let c = 0; c < 3; c++) rows[o + c] = a > 0 ? Math.round(Math.min(1, pixels[i + c] / a) * 255) : 0;
      rows[o + 3] = Math.round(a * 255);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** macOS icon types that hold a PNG, by pixel size. */
const ICNS_TYPES = [['icp4', 16], ['icp5', 32], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];

function icns(pngs) {
  const entries = ICNS_TYPES.map(([type, size]) => {
    const head = Buffer.alloc(8); head.write(type, 0, 'ascii'); head.writeUInt32BE(8 + pngs[size].length, 4);
    return Buffer.concat([head, pngs[size]]);
  });
  const head = Buffer.alloc(8); head.write('icns', 0, 'ascii'); head.writeUInt32BE(8 + entries.reduce((n, e) => n + e.length, 0), 4);
  return Buffer.concat([head, ...entries]);
}

function ico(pngs, sizes) {
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dir = sizes.map(size => {
    const e = Buffer.alloc(16);
    e[0] = size === 256 ? 0 : size; e[1] = size === 256 ? 0 : size;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(pngs[size].length, 8); e.writeUInt32LE(offset, 12);
    offset += pngs[size].length;
    return e;
  });
  return Buffer.concat([header, ...dir, ...sizes.map(s => pngs[s])]);
}

function main(argv) {
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? path.resolve(argv[outIndex + 1]) : path.join(__dirname, '..', 'build');
  fs.mkdirSync(out, { recursive: true });
  const pngs = {};
  let pixels = draw();
  for (let size = SIZE; size >= 16; size /= 2) {
    pngs[size] = png(pixels, size);
    if (size > 16) pixels = halve(pixels, size);
  }
  fs.writeFileSync(path.join(out, 'icon.png'), pngs[1024]);
  fs.writeFileSync(path.join(out, 'icon.icns'), icns(pngs));
  fs.writeFileSync(path.join(out, 'icon.ico'), ico(pngs, [16, 32, 64, 128, 256]));
  return out;
}

if (require.main === module) console.log(`Icons written to ${main(process.argv.slice(2))}`);

module.exports = { main, insideTile, png, icns, ico };
