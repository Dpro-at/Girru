'use strict';
/**
 * Generate the macOS and Windows icons from the approved desktop PNG.
 * The same rounded white icon is used by Linux and the development dock.
 * Usage: node scripts/make-icons.cjs [--out <dir>]
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 1024;
const SOURCE = path.join(__dirname, '..', 'build', 'icon.png');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Read the checked-in 1024 px, unfiltered RGBA master into premultiplied pixels. */
function readMaster(source) {
  if (!source.subarray(0, 8).equals(PNG_SIGNATURE) ||
      source.readUInt32BE(16) !== SIZE || source.readUInt32BE(20) !== SIZE ||
      !source.subarray(24, 29).equals(Buffer.from([8, 6, 0, 0, 0]))) {
    throw new Error('The desktop icon master must be a 1024 px, non-interlaced RGBA PNG.');
  }
  const chunks = [];
  for (let offset = 8; offset < source.length;) {
    const length = source.readUInt32BE(offset);
    if (source.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      chunks.push(source.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const stride = SIZE * 4 + 1;
  const rows = zlib.inflateSync(Buffer.concat(chunks));
  if (rows.length !== SIZE * stride) throw new Error('Invalid desktop icon pixel data.');
  const pixels = new Float32Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    const row = y * stride;
    if (rows[row] !== 0) throw new Error('The desktop icon master must use unfiltered PNG rows.');
    for (let x = 0; x < SIZE; x++) {
      const input = row + 1 + x * 4;
      const output = (y * SIZE + x) * 4;
      const alpha = rows[input + 3] / 255;
      for (let channel = 0; channel < 3; channel++) {
        pixels[output + channel] = rows[input + channel] / 255 * alpha;
      }
      pixels[output + 3] = alpha;
    }
  }
  return pixels;
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
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** macOS icon types that hold a PNG, by pixel size. */
const ICNS_TYPES = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];

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

/** Area-average the master for sizes outside the power-of-two series. */
function shrink(pixels, size) {
  const out = new Float32Array(size * size * 4); const step = SIZE / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = x * step, x1 = (x + 1) * step, y0 = y * step, y1 = (y + 1) * step; const sum = [0, 0, 0, 0]; let area = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const w = wy * (Math.min(x1, xx + 1) - Math.max(x0, xx)); area += w;
          for (let c = 0; c < 4; c++) sum[c] += pixels[(yy * SIZE + xx) * 4 + c] * w;
        }
      }
      for (let c = 0; c < 4; c++) out[(y * size + x) * 4 + c] = sum[c] / area;
    }
  }
  return out;
}

function main(argv) {
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? path.resolve(argv[outIndex + 1]) : path.join(__dirname, '..', 'build');
  fs.mkdirSync(out, { recursive: true });
  const pngs = {};
  const master = fs.readFileSync(SOURCE);
  const full = readMaster(master);
  let pixels = full;
  for (let size = SIZE; size >= 16; size /= 2) {
    pngs[size] = size === SIZE ? master : png(pixels, size);
    if (size > 16) pixels = halve(pixels, size);
  }
  if (path.join(out, 'icon.png') !== SOURCE) fs.writeFileSync(path.join(out, 'icon.png'), master);
  fs.writeFileSync(path.join(out, 'icon.icns'), icns(pngs));
  pngs[48] = png(shrink(full, 48), 48);
  fs.writeFileSync(path.join(out, 'icon.ico'), ico(pngs, [16, 32, 48, 64, 128, 256]));
  return out;
}

if (require.main === module) console.log(`Icons written to ${main(process.argv.slice(2))}`);

module.exports = { main, png, icns, ico };
