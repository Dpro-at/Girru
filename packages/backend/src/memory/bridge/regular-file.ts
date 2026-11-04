import fs from 'node:fs';
import path from 'node:path';

const notRegular = (message: string) => Object.assign(new Error(message), { code: 'ENOTREG' });

/**
 * `relative` resolved inside `root`: no `..` or absolute part may leave it, and
 * the real path of the file's folder must stay under the real path of `root`
 * (a linked folder on the way cannot lead outside). The file itself is not
 * followed; `readRegularFile` opens it without following links. A folder that
 * is not there throws ENOENT like a missing file.
 */
export function confinedPath(root: string, relative: string): string {
  const base = path.resolve(root);
  const file = path.resolve(base, relative);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (!file.startsWith(prefix)) throw notRegular('File is outside its folder');
  const realBase = fs.realpathSync.native(base);
  const realDir = fs.realpathSync.native(path.dirname(file));
  const realPrefix = realBase.endsWith(path.sep) ? realBase : realBase + path.sep;
  if (realDir !== realBase && !realDir.startsWith(realPrefix)) throw notRegular('File is outside its folder');
  return file;
}

/** Validate and read one descriptor of `relative` inside `root`, refusing symlink swaps and bounding allocation/read size. */
export function readRegularFile(root: string, relative: string, limit: number): { bytes: Buffer; mode: number } {
  const file = confinedPath(root, relative);
  let fd:number;
  try{fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ELOOP')throw notRegular('Not a regular file');throw error;}
  try {
    const opened=fs.fstatSync(fd),entry=fs.lstatSync(file);
    if(!opened.isFile()||!entry.isFile()||entry.isSymbolicLink()||entry.dev!==opened.dev||entry.ino!==opened.ino)throw notRegular('File changed during open');
    if (opened.size > limit) throw Object.assign(new Error('File is too large'), { code: 'EFBIG' });
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit) throw Object.assign(new Error('File is too large'), { code: 'EFBIG' });
    return { bytes: bytes.subarray(0, length), mode: opened.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}
