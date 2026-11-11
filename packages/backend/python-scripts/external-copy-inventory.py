"""Read-only bounded .girru inventory; no ownership or cleanup assertion."""
import hashlib
import json
import os
import stat
import sys


def main():
    if os.open not in os.supports_dir_fd or not hasattr(os, 'O_NOFOLLOW'):
        raise ValueError('unsupported')
    raw = sys.stdin.buffer.read(20001)
    if len(raw) > 20000:
        raise ValueError('bounds')
    data = json.loads(raw)
    root = data['root']
    budget = data['maxBytes']
    if type(budget) is not int or budget < 0 or budget > 8388608:
        raise ValueError('budget')
    if not isinstance(root, str) or root == '/' or not root.startswith('/'):
        raise ValueError('root')
    parts = root.split('/')[1:]
    if any(not part or part in ('.', '..') for part in parts):
        raise ValueError('root')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open('/', flags)
    directory = None
    try:
        for part in parts:
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        identity = os.fstat(fd)
        if str(identity.st_dev) != data['device'] or str(identity.st_ino) != data['inode']:
            raise ValueError('root changed')
        files = []
        total = 0

        def scan_leaf(parent, name, relative):
            nonlocal total
            leaf = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                before = os.fstat(leaf)
                if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 1048576 or total + before.st_size > budget:
                    raise ValueError('not a bounded regular file')
                digest = hashlib.sha256()
                length = 0
                while length < before.st_size:
                    chunk = os.read(leaf, min(65536, before.st_size - length))
                    if not chunk:
                        break
                    length += len(chunk)
                    total += len(chunk)
                    digest.update(chunk)
                after = os.fstat(leaf)
                named = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) or named.st_ino != after.st_ino or named.st_dev != after.st_dev or length != after.st_size or after.st_nlink != 1 or named.st_nlink != 1:
                    raise ValueError('file changed')
                files.append({'path': relative, 'bytes': length, 'sha256': digest.hexdigest()})
            finally:
                os.close(leaf)

        # Fixed current producers only. Hashing does not imply Girru owns these shared documents.
        for name in ('AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'DESIGN.md'):
            try:
                os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            scan_leaf(fd, name, name)
        try:
            directory = os.open('.girru', flags, dir_fd=fd)
        except FileNotFoundError:
            directory = None
        if directory is not None:
            count = 0
            with os.scandir(directory) as entries:
                for entry in entries:
                    count += 1
                    if count > 128 or len(entry.name.encode('utf-8')) > 255:
                        raise ValueError('bounds')
                    scan_leaf(directory, entry.name, '.girru/' + entry.name)
        sys.stdout.write(json.dumps({'files': sorted(files, key=lambda value: value['path'])}, separators=(',', ':')))
    finally:
        if directory is not None:
            os.close(directory)
        os.close(fd)


try:
    main()
except Exception:
    sys.stderr.write('External copy inventory refused\n')
    sys.exit(1)
