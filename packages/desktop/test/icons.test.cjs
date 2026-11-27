const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const zlib = require('node:zlib');
const { main } = require('../scripts/make-icons.cjs');

// Compare pixels, not bytes: another zlib may pack the same pixels differently.
const pixels = buffer => { const parts = []; for (let at = 8; at < buffer.length;) { const len = buffer.readUInt32BE(at); if (buffer.subarray(at + 4, at + 8).toString('ascii') === 'IDAT') parts.push(buffer.subarray(at + 8, at + 8 + len)); at += 12 + len; } return zlib.inflateSync(Buffer.concat(parts)); };
const pngSize = buffer => { assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG'); return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)]; };

function icnsImages(file) {
  const images = {};
  for (let offset = 8; offset < file.length;) {
    const length = file.readUInt32BE(offset + 4);
    images[file.toString('ascii', offset, offset + 4)] = pixels(file.subarray(offset + 8, offset + length));
    offset += length;
  }
  return images;
}

function icoImages(file) {
  return Array.from({length: file.readUInt16LE(4)}, (_, index) => {
    const entry = 6 + 16 * index;
    const offset = file.readUInt32LE(entry + 12);
    const length = file.readUInt32LE(entry + 8);
    return pixels(file.subarray(offset, offset + length));
  });
}

test('writes png, icns and ico with every size, the same as the committed files', t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'girru-icons-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  main(['--out', out]);
  const png = fs.readFileSync(path.join(out, 'icon.png'));
  assert.deepEqual(pngSize(png), [1024, 1024]);
  assert.equal(png[25], 6, 'RGBA, so the edge stays transparent');

  const rows = pixels(png);
  const pixel = (x, y) => [...rows.subarray(y * 4097 + 1 + x * 4, y * 4097 + 5 + x * 4)];
  for (const [x, y] of [[0, 0], [1023, 0], [0, 1023], [1023, 1023], [32, 32]]) {
    assert.equal(pixel(x, y)[3], 0, 'Outside the rounded tile stays transparent');
  }
  assert.deepEqual(pixel(512, 64), [255, 255, 255, 255], 'The tile background is white');

  const icns = fs.readFileSync(path.join(out, 'icon.icns'));
  assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const entries = {};
  for (let at = 8; at < icns.length;) { const len = icns.readUInt32BE(at + 4); entries[icns.subarray(at, at + 4).toString('ascii')] = pngSize(icns.subarray(at + 8, at + len))[0]; at += len; }
  assert.deepEqual(entries, { icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512 });

  const ico = fs.readFileSync(path.join(out, 'icon.ico'));
  assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), 6);
  const sizes = [0, 1, 2, 3, 4, 5].map(i => pngSize(ico.subarray(ico.readUInt32LE(6 + 16 * i + 12)))[0]);
  assert.deepEqual(sizes, [16, 32, 48, 64, 128, 256]);

  const committed = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.png'));
  assert.ok(pixels(png).equals(pixels(committed)), 'build/icon.png is out of date: run node scripts/make-icons.cjs');
  for (const name of ['icon.icns', 'icon.ico']) {
    const generated = fs.readFileSync(path.join(out, name));
    const checkedIn = fs.readFileSync(path.join(__dirname, '..', 'build', name));
    const readImages = name.endsWith('.icns') ? icnsImages : icoImages;
    assert.deepEqual(readImages(generated), readImages(checkedIn), `build/${name} is out of date`);
  }
});
