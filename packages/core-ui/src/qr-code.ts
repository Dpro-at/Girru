// QR code encoder (ISO/IEC 18004): byte mode, error correction level M,
// versions 1-40, all 8 masks scored with the four penalty rules. Own code:
// the pairing screen draws the `girru://pair?...` text with it.

/** Error correction codewords per block and the two block groups (count × data codewords), level M, versions 1-40. */
export const M_BLOCKS: ReadonlyArray<readonly [ec: number, n1: number, d1: number, n2: number, d2: number]> = [
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51], [22, 6, 36, 2, 37], [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42],
  [28, 7, 45, 3, 46], [28, 10, 46, 1, 47], [26, 9, 43, 4, 44], [26, 3, 44, 11, 45], [26, 3, 41, 13, 42],
  [26, 17, 42, 0, 0], [28, 17, 46, 0, 0], [28, 4, 47, 14, 48], [28, 6, 45, 14, 46], [28, 8, 47, 13, 48],
  [28, 19, 46, 4, 47], [28, 22, 45, 3, 46], [28, 3, 45, 23, 46], [28, 21, 45, 7, 46], [28, 19, 47, 10, 48],
  [28, 2, 46, 29, 47], [28, 10, 46, 23, 47], [28, 14, 46, 21, 47], [28, 14, 46, 23, 47], [28, 12, 47, 26, 48],
  [28, 6, 47, 34, 48], [28, 29, 46, 14, 47], [28, 13, 46, 32, 47], [28, 40, 47, 7, 48], [28, 18, 47, 31, 48],
];

export type QrMatrix = { version: number; size: number; mask: number; modules: boolean[][] };

// ---------- GF(256) and Reed-Solomon ----------

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
export const gfMul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
export const gfPow2 = (i: number) => EXP[i % 255];

/** The generator polynomial (x − α⁰)…(x − α^(n−1)), highest term dropped, coefficients high to low. */
function divisor(n: number): number[] {
  const r = new Array<number>(n).fill(0); r[n - 1] = 1;
  let root = 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) { r[j] = gfMul(r[j], root); if (j + 1 < n) r[j] ^= r[j + 1]; }
    root = gfMul(root, 2);
  }
  return r;
}

/** The n error correction codewords of one block. */
export function reedSolomon(data: readonly number[], n: number): number[] {
  const d = divisor(n), r = new Array<number>(n).fill(0);
  for (const b of data) {
    const f = b ^ (r.shift() as number); r.push(0);
    for (let i = 0; i < n; i++) r[i] ^= gfMul(d[i], f);
  }
  return r;
}

// ---------- sizes ----------

export const sizeOf = (version: number) => version * 4 + 17;
/** Modules left for data and error correction after every function pattern. */
export function rawModules(v: number): number {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
  return r;
}
export const dataCodewords = (v: number) => { const [, n1, d1, n2, d2] = M_BLOCKS[v - 1]; return n1 * d1 + n2 * d2; };
/** The most bytes version v holds at level M. */
export const byteCapacity = (v: number) => Math.floor((dataCodewords(v) * 8 - 4 - (v < 10 ? 8 : 16)) / 8);

export function alignmentPositions(v: number): number[] {
  if (v === 1) return [];
  const n = Math.floor(v / 7) + 2, size = sizeOf(v);
  const step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6];
  for (let p = size - 7; r.length < n; p -= step) r.splice(1, 0, p);
  return r;
}

// ---------- BCH codes ----------

/** 15 format bits for level M (bits 00) and a mask, masked with 101010000010010. */
export function formatBits(mask: number): number {
  const data = (0 << 3) | mask;
  let r = data; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
  return ((data << 10) | r) ^ 0x5412;
}
/** 18 version bits (versions 7 and up). */
export function versionBits(v: number): number {
  let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
  return (v << 12) | r;
}

// ---------- encoding ----------

/** The final codeword sequence (data and error correction, interleaved) for these bytes in version v. */
export function codewords(bytes: Uint8Array, v: number): number[] {
  const cap = dataCodewords(v), bits: number[] = [];
  const put = (value: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4); put(bytes.length, v < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);
  const [ec, n1, d1, n2, d2] = M_BLOCKS[v - 1];
  const blocks: number[][] = [];
  let at = 0;
  for (let i = 0; i < n1 + n2; i++) { const len = i < n1 ? d1 : d2; blocks.push(data.slice(at, at + len)); at += len; }
  const ecs = blocks.map(b => reedSolomon(b, ec));
  const out: number[] = [];
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ec; i++) for (const e of ecs) out.push(e[i]);
  return out;
}

export function masked(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** Function patterns and reserved areas; modules[y][x], x = column. */
function base(v: number) {
  const size = sizeOf(v);
  const m = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const f = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => { m[y][x] = dark; f[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  const al = alignmentPositions(v), last = al.length - 1;
  for (let i = 0; i <= last; i++) for (let j = 0; j <= last; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  drawFormat(set, size, 0);
  if (v >= 7) {
    const bits = versionBits(v);
    for (let i = 0; i < 18; i++) { const dark = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3); set(a, b, dark); set(b, a, dark); }
  }
  return { size, m, f, set };
}

function drawFormat(set: (x: number, y: number, dark: boolean) => void, size: number, mask: number) {
  const bits = formatBits(mask), bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

/** Lower is easier to scan (the four penalty rules of the standard). */
export function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0, dark = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) run++;
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    // 1:1:3:1:1 with four light modules on one side; outside the code counts as light.
    const at = (i: number) => (i >= 0 && i < size ? get(i) : false);
    for (let i = -4; i < size; i++) {
      if (at(i) && !at(i + 1) && at(i + 2) && at(i + 3) && at(i + 4) && !at(i + 5) && at(i + 6)
        && ((!at(i - 1) && !at(i - 2) && !at(i - 3) && !at(i - 4)) || (!at(i + 7) && !at(i + 8) && !at(i + 9) && !at(i + 10)))) score += 40;
    }
  };
  for (let y = 0; y < size; y++) line(x => m[y][x]);
  for (let x = 0; x < size; x++) line(y => m[y][x]);
  for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
  }
  for (const row of m) for (const c of row) if (c) dark++;
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** Encodes text (UTF-8 bytes) in the smallest version that holds it; mask fixed or chosen by penalty. */
export function encodeQr(text: string, opts: { mask?: number; minVersion?: number } = {}): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let v = Math.max(1, opts.minVersion ?? 1);
  while (v <= 40 && byteCapacity(v) < bytes.length) v++;
  if (v > 40) throw new RangeError('too_long');
  const words = codewords(bytes, v);
  const { size, m, f } = base(v);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!f[y][x] && i < words.length * 8) { m[y][x] = ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
    }
  }
  const make = (mask: number) => {
    const out = m.map((row, y) => row.map((c, x) => (f[y][x] ? c : c !== masked(mask, x, y))));
    drawFormat((x, y, dark) => { out[y][x] = dark; }, size, mask);
    return out;
  };
  if (opts.mask !== undefined) return { version: v, size, mask: opts.mask, modules: make(opts.mask) };
  let best = 0, bestScore = Infinity, bestModules = m;
  for (let mask = 0; mask < 8; mask++) {
    const out = make(mask), s = penalty(out);
    if (s < bestScore) { best = mask; bestScore = s; bestModules = out; }
  }
  return { version: v, size, mask: best, modules: bestModules };
}

/** One SVG path for every dark module (rows merged into runs), offset by the quiet zone. */
export function qrPath(q: QrMatrix, quiet = 4): string {
  const parts: string[] = [];
  q.modules.forEach((row, y) => {
    for (let x = 0; x < q.size; x++) {
      if (!row[x]) continue;
      let run = 1; while (x + run < q.size && row[x + run]) run++;
      parts.push(`M${x + quiet} ${y + quiet}h${run}v1h-${run}z`);
      x += run - 1;
    }
  });
  return parts.join('');
}
