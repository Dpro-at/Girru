"""Descriptor-relative deletion for the explicit encrypted-forget root; no profile discovery."""
import json
import os
import stat
import sys


def main():
    if os.open not in os.supports_dir_fd or os.unlink not in os.supports_dir_fd or not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY'):
        raise ValueError('unsupported')
    raw = sys.stdin.buffer.read(4194305)
    if len(raw) > 4194304:
        raise ValueError('bounds')
    data = json.loads(raw)
    root = data['root']
    files = data['files']
    if not isinstance(root, str) or not root.startswith('/') or not isinstance(files, list) or len(files) > 5000:
        raise ValueError('input')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    root_fd = os.open('/', flags)
    try:
        for part in root.split('/'):
            if not part:
                continue
            if part in ('.', '..'):
                raise ValueError('path')
            child = os.open(part, flags, dir_fd=root_fd)
            os.close(root_fd)
            root_fd = child
        identity = os.fstat(root_fd)
        if str(identity.st_dev) != data['device'] or str(identity.st_ino) != data['inode']:
            raise ValueError('root changed')
        for operation in files:
            # Shared owner documents have no exclusive writer contract. Refuse replacement
            # until one exists; hash checks followed by rename cannot provide content CAS.
            if isinstance(operation, dict):
                raise ValueError('replacement requires exclusive ownership')
            file = operation
            if not isinstance(file, str) or not file or file.startswith('/') or '\\' in file:
                raise ValueError('path')
            parts = file.split('/')
            if any(not p or p in ('.', '..') for p in parts):
                raise ValueError('path')
            parent = os.dup(root_fd)
            try:
                missing = False
                for part in parts[:-1]:
                    try:
                        child = os.open(part, flags, dir_fd=parent)
                    except FileNotFoundError:
                        missing = True
                        break
                    os.close(parent)
                    parent = child
                if missing:
                    os.fsync(parent)
                    continue
                try:
                    entry = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    os.fsync(parent)
                    continue
                if not stat.S_ISREG(entry.st_mode):
                    raise ValueError('not a regular file')
                # unlinkat is anchored to the already opened directory, even if its path is replaced.
                os.unlink(parts[-1], dir_fd=parent)
                try:
                    os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    os.fsync(parent)
                    continue
                raise ValueError('file recreated')
            finally:
                os.close(parent)
    finally:
        os.close(root_fd)
    sys.stdout.write('{"removed":true}')


try:
    main()
except Exception:
    sys.stderr.write('Scoped file cleanup refused\n')
    sys.exit(1)
