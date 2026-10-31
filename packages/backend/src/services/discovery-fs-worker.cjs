'use strict';
// No application modules, database, HTTP listener, shell, or credential environment.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const shape = stat => ({ size: stat.size, mode: stat.mode, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, mtime: stat.mtime.toISOString(), file: stat.isFile(), directory: stat.isDirectory(), symlink: stat.isSymbolicLink() });
const valid = file => typeof file === 'string' && path.isAbsolute(file) && file.length <= 8192 && !file.includes('\0');
async function read(file, limit, options = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 64 * 1024 * 1024 || /^(?:id_(?:rsa|dsa|ecdsa|ed25519|ecdsa_sk|ed25519_sk))$/.test(path.basename(file)) || /\.(?:pem|key)$/i.test(file)) throw Object.assign(Error(), { code: 'EACCES' });
  const root = options.root ? await fs.realpath(options.root) : null;
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const stat = await handle.stat(), entry = await fs.lstat(file);
    if (!stat.isFile() || entry.isSymbolicLink() || entry.dev !== stat.dev || entry.ino !== stat.ino) throw Object.assign(Error(), { code: 'EACCES' });
    if (root) { const relative = path.relative(root, await fs.realpath(file)); if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Object.assign(Error(), { code: 'EACCES' }); }
    if (stat.size > limit && !options.truncate) throw Object.assign(Error(), { code: 'EFBIG' });
    const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1)); let used = 0;
    while (used < bytes.length) { const chunk = await handle.read(bytes, used, bytes.length - used, used); if (!chunk.bytesRead) break; used += chunk.bytesRead; }
    if (used > limit && !options.truncate) throw Object.assign(Error(), { code: 'EFBIG' });
    return { data: bytes.subarray(0, Math.min(used, limit)).toString('base64'), stat: shape(stat), truncated: stat.size > limit || used > limit };
  } finally { await handle.close(); }
}
async function operation(message) {
  if (!valid(message.file)) throw Object.assign(Error(), { code: 'EINVAL' });
  switch (message.op) {
    case 'stat': return shape(await fs.stat(message.file));
    case 'lstat': return shape(await fs.lstat(message.file));
    case 'realpath': return fs.realpath(message.file);
    case 'readdir': { const entries = await fs.readdir(message.file, { withFileTypes: true }); if (entries.length > 100000) throw Object.assign(Error(), { code: 'EFBIG' }); return entries.map(entry => ({ name: entry.name, file: entry.isFile(), directory: entry.isDirectory(), symlink: entry.isSymbolicLink() })); }
    case 'read': return read(message.file, message.limit, message.options);
    case 'copyToTemp': {
      // A source is read-only. The only destination is an existing private throwaway SQLite folder.
      const target = message.target; if (!valid(target)) throw Object.assign(Error(), { code: 'EINVAL' });
      const directory = path.dirname(target), real = await fs.realpath(directory), temp = await fs.realpath(os.tmpdir()), stat = await fs.lstat(directory);
      if (!real.startsWith(temp + path.sep) || !/^dpro-(?:read|sqlite-copy)-/.test(path.basename(real)) || !['copy.db', 'copy.db-wal', 'copy.sqlite'].includes(path.basename(target)) || stat.isSymbolicLink() || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw Object.assign(Error(), { code: 'EACCES' });
      if (!/\.(?:db|sqlite|sqlite3)(?:-wal)?$/i.test(message.file)) throw Object.assign(Error(), { code: 'EACCES' });
      const source = await fs.open(message.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      let destination;
      try {
        const sourceStat = await source.stat(), sourceEntry = await fs.lstat(message.file);
        if (!sourceStat.isFile() || sourceEntry.isSymbolicLink() || sourceEntry.dev !== sourceStat.dev || sourceEntry.ino !== sourceStat.ino || sourceStat.size > 200 * 1024 * 1024) throw Object.assign(Error(), { code: 'EACCES' });
        const header = Buffer.alloc(16); if ((await source.read(header, 0, 16, 0)).bytesRead !== 16) throw Object.assign(Error(), { code: 'EINVAL' });
        const validHeader = message.file.endsWith('-wal') ? [0x377f0682, 0x377f0683].includes(header.readUInt32BE(0)) : header.toString('binary') === 'SQLite format 3\0';
        if (!validHeader) throw Object.assign(Error(), { code: 'EINVAL' });
        destination = await fs.open(path.join(real, path.basename(target)), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
        const bytes = Buffer.alloc(64 * 1024); let position = 0;
        while (position < sourceStat.size) {
          const chunk = await source.read(bytes, 0, Math.min(bytes.length, sourceStat.size - position), position); if (!chunk.bytesRead) break;
          let written = 0; while (written < chunk.bytesRead) { const out = await destination.write(bytes, written, chunk.bytesRead - written, position + written); if (!out.bytesWritten) throw Object.assign(Error(), { code: 'EIO' }); written += out.bytesWritten; }
          position += chunk.bytesRead;
        }
        if (position !== sourceStat.size) throw Object.assign(Error(), { code: 'EIO' });
        return null;
      } finally { await destination?.close(); await source.close(); }

    }
    default: throw Object.assign(Error(), { code: 'EINVAL' });
  }
}
process.on('message', async message => {
  if (!message || !Number.isSafeInteger(message.id)) return;
  try { process.send?.({ id: message.id, value: await operation(message) }); }
  catch (error) { process.send?.({ id: message.id, error: ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EFBIG', 'EINVAL', 'ELOOP'].includes(error?.code) ? error.code : 'EIO' }); }
});
process.on('disconnect', () => process.exit(0));
