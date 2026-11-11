"""Directory identity only; descriptor-relative traversal never follows symbolic links."""
import json
import os
import sys


def main():
    if os.open not in os.supports_dir_fd or not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY'):
        raise ValueError('unsupported')
    raw = sys.stdin.buffer.read(20001)
    if len(raw) > 20000:
        raise ValueError('bounds')
    data = json.loads(raw)
    if not isinstance(data, dict) or set(data) != {'root'}:
        raise ValueError('input')
    root = data['root']
    if not isinstance(root, str) or not root.startswith('/') or root == '/' or '\x00' in root:
        raise ValueError('root')
    parts = root.split('/')[1:]
    if any(not part or part in ('.', '..') for part in parts):
        raise ValueError('root')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open('/', flags)
    try:
        for part in parts:
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        identity = os.fstat(fd)
        result = {'device': str(identity.st_dev), 'inode': str(identity.st_ino)}
    finally:
        os.close(fd)
    sys.stdout.write(json.dumps(result, separators=(',', ':')))


try:
    main()
except Exception:
    sys.stderr.write('External root identity refused\n')
    sys.exit(1)
