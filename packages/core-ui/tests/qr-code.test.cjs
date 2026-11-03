// MOB-PAIR-01: the own QR encoder. Checked against values from the standard
// (format and version bits, alignment table, capacities, a Reed-Solomon
// vector) and round-tripped through a decoder written only for this test.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../src/qr-code.ts');

// ISO/IEC 18004 Annex E: alignment pattern centres.
const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
  [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90], [6, 28, 50, 72, 94], [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170]];
// The standard's format information table, level M, masks 0-7.
const FORMAT_M = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];

// ---------- a decoder written only for this test ----------
const exp = [], log = [];
for (let i = 0, x = 1; i < 255; i++) { exp[i] = x; log[x] = i; x = x << 1 ^ (x & 0x80 ? 0x11d : 0); x &= 0xff; }
const mul = (a, b) => a && b ? exp[(log[a] + log[b]) % 255] : 0;
/** A block is a codeword when its polynomial is zero at α⁰…α^(ec−1). */
function syndromesZero(block, ec) {
  for (let i = 0; i < ec; i++) { let s = 0; for (const c of block) s = mul(s, exp[i]) ^ c; if (s) return false; }
  return true;
}
const MASK = [(i, j) => (i + j) % 2 === 0, i => i % 2 === 0, (i, j) => j % 3 === 0, (i, j) => (i + j) % 3 === 0, (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => i * j % 2 + i * j % 3 === 0, (i, j) => (i * j % 2 + i * j % 3) % 2 === 0, (i, j) => ((i + j) % 2 + i * j % 3) % 2 === 0];
function decode(modules) {
  const n = modules.length, v = (n - 17) / 4;
  assert.ok(Number.isInteger(v) && v >= 1 && v <= 40);
  const dark = (r, c) => modules[r][c];
  // Format: second copy, bit 14 first: column 8 from the bottom (7 bits), then row 8 from the right (8 bits).
  let fmt = '';
  for (let r = n - 1; r >= n - 7; r--) fmt += dark(r, 8) ? '1' : '0';
  for (let c = n - 8; c < n; c++) fmt += dark(8, c) ? '1' : '0';
  // First copy, bit 14 first: row 8 columns 0-5, 7, 8, then column 8 rows 7, 5…0.
  let fmt1 = '';
  for (const c of [0, 1, 2, 3, 4, 5, 7, 8]) fmt1 += dark(8, c) ? '1' : '0';
  for (const r of [7, 5, 4, 3, 2, 1, 0]) fmt1 += dark(r, 8) ? '1' : '0';
  assert.equal(fmt, fmt1, 'both format copies agree');
  const mask = FORMAT_M.indexOf(fmt);
  assert.ok(mask >= 0, `format ${fmt} is level M`);
  assert.equal(dark(n - 8, 8), true, 'dark module');
  const fn = Array.from({ length: n }, () => new Array(n).fill(false));
  const mark = (r0, c0, h, w) => { for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) if (r >= 0 && c >= 0 && r < n && c < n) fn[r][c] = true; };
  mark(0, 0, 9, 9); mark(0, n - 8, 9, 8); mark(n - 8, 0, 8, 9);
  // Alignment patterns except where a finder is (they may cross the timing lines).
  const al = ALIGN[v - 1];
  for (const r of al) for (const c of al) if (!fn[r][c]) mark(r - 2, c - 2, 5, 5);
  mark(6, 0, 1, n); mark(0, 6, n, 1);
  if (v >= 7) {
    mark(0, n - 11, 6, 3); mark(n - 11, 0, 3, 6);
    let bits = 0; for (let i = 17; i >= 0; i--) bits = bits << 1 | (dark(Math.floor(i / 3), n - 11 + i % 3) ? 1 : 0);
    assert.equal(bits >>> 12, v, 'version information');
  }
  const bits = [];
  for (let c = n - 1, up = true; c > 0; c -= 2, up = !up) {
    if (c === 6) c = 5;
    for (let k = 0; k < n; k++) {
      const r = up ? n - 1 - k : k;
      for (const cc of [c, c - 1]) if (!fn[r][cc]) bits.push(dark(r, cc) !== MASK[mask](r, cc) ? 1 : 0);
    }
  }
  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((a, b) => a << 1 | b, 0));
  const [ec, n1, d1, n2, d2] = Q.M_BLOCKS[v - 1];
  const lens = [...new Array(n1).fill(d1), ...new Array(n2).fill(d2)];
  const blocks = lens.map(() => []);
  let at = 0;
  for (let i = 0; i < Math.max(d1, d2); i++) lens.forEach((len, b) => { if (i < len) blocks[b].push(words[at++]); });
  const data = blocks.flatMap(b => b.slice());
  for (let i = 0; i < ec; i++) blocks.forEach(b => b.push(words[at++]));
  blocks.forEach(b => assert.ok(syndromesZero(b, ec), 'every block is a Reed-Solomon codeword'));
  let p = 0; const read = k => { let x = 0; for (let i = 0; i < k; i++) { x = x << 1 | (data[p >> 3] >> (7 - (p & 7)) & 1); p++; } return x; };
  assert.equal(read(4), 0b0100, 'byte mode');
  const count = read(v < 10 ? 8 : 16);
  const out = new Uint8Array(count); for (let i = 0; i < count; i++) out[i] = read(8);
  return { version: v, mask, text: new TextDecoder('utf-8', { fatal: true }).decode(out) };
}

// ---------- tests ----------

test('block table matches the module count of every version, and the known byte capacities', () => {
  for (let v = 1; v <= 40; v++) {
    const [ec, n1, d1, n2, d2] = Q.M_BLOCKS[v - 1];
    assert.equal(n1 * (d1 + ec) + n2 * (d2 + ec), Math.floor(Q.rawModules(v) / 8), `version ${v}`);
    if (n2) assert.equal(d2, d1 + 1);
  }
  assert.equal(Q.rawModules(1), 208); assert.equal(Q.rawModules(7), 1568); assert.equal(Q.rawModules(40), 29648);
  const known = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122, 8: 152, 9: 180, 10: 213, 15: 412, 20: 666, 27: 1125, 30: 1370, 40: 2331 };
  for (const [v, bytes] of Object.entries(known)) assert.equal(Q.byteCapacity(Number(v)), bytes, `byte capacity of version ${v}`);
});

test('alignment positions match the table of the standard', () => {
  for (let v = 1; v <= 40; v++) assert.deepEqual(Q.alignmentPositions(v), ALIGN[v - 1], `version ${v}`);
});

test('format and version bits match the standard', () => {
  for (let m = 0; m < 8; m++) assert.equal(Q.formatBits(m).toString(2).padStart(15, '0'), FORMAT_M[m], `mask ${m}`);
  assert.equal(Q.versionBits(7).toString(2).padStart(18, '0'), '000111110010010100');
  assert.equal(Q.versionBits(40).toString(2).padStart(18, '0'), '101000110001101001');
});

test('Reed-Solomon codewords: the "HELLO WORLD" 1-M vector', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(Q.reedSolomon(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  assert.ok(syndromesZero([...data, ...Q.reedSolomon(data, 10)], 10));
});

test('byte-mode data codewords: mode, count, terminator and pad bytes', () => {
  // "hello" in version 1-M: 0100 00000101 then the bytes, 0000, pad EC 11 ...
  const words = Q.codewords(new TextEncoder().encode('hello'), 1);
  assert.deepEqual(words.slice(0, 16), [0x40, 0x56, 0x86, 0x56, 0xc6, 0xc6, 0xf0, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec]);
  assert.equal(words.length, 26);
});

test('round trip: every mask, small to the largest version', () => {
  const pairing = 'girru://pair?v=1&cid=' + 'A'.repeat(43) + '&ck=' + 'B'.repeat(44) + '&pid=pr_' + 'c'.repeat(22) + '&ps=' + 'D'.repeat(43) + '&exp=1793000000&relay=wss%3A%2F%2Frelay.girru.net%2Fv1&name=Mohamed%E2%80%99s+Mac';
  for (const text of ['a', 'x'.repeat(14), 'x'.repeat(15), pairing, pairing + '&lan=192.168.1.20%3A41520,10.0.0.5%3A41520', 'é'.repeat(300), 'z'.repeat(1024)]) {
    const q = Q.encodeQr(text);
    assert.equal(q.size, q.version * 4 + 17);
    assert.ok(Q.byteCapacity(q.version) >= new TextEncoder().encode(text).length);
    if (q.version > 1) assert.ok(Q.byteCapacity(q.version - 1) < new TextEncoder().encode(text).length, 'smallest version');
    const d = decode(q.modules);
    assert.equal(d.text, text); assert.equal(d.mask, q.mask);
    assert.equal(q.mask, [0, 1, 2, 3, 4, 5, 6, 7].reduce((best, m) => Q.penalty(Q.encodeQr(text, { mask: m }).modules) < Q.penalty(Q.encodeQr(text, { mask: best }).modules) ? m : best, 0), 'lowest penalty');
  }
  for (let m = 0; m < 8; m++) assert.equal(decode(Q.encodeQr(pairing, { mask: m }).modules).text, pairing);
  const big = Q.encodeQr('q'.repeat(2331));
  assert.equal(big.version, 40); assert.equal(decode(big.modules).text, 'q'.repeat(2331));
  assert.throws(() => Q.encodeQr('q'.repeat(2332)), /too_long/);
});

test('the SVG path draws exactly the dark modules inside the quiet zone', () => {
  const q = Q.encodeQr('girru://pair?v=1');
  const path = Q.qrPath(q);
  assert.match(path, /^(M\d+ \d+h\d+v1h-\d+z)+$/);
  const grid = Array.from({ length: q.size }, () => new Array(q.size).fill(false));
  for (const [, x, y, run] of path.matchAll(/M(\d+) (\d+)h(\d+)/g)) for (let i = 0; i < Number(run); i++) grid[Number(y) - 4][Number(x) - 4 + i] = true;
  assert.deepEqual(grid, q.modules);
});
