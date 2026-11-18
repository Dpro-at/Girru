"""Deterministic ancestor-swap acceptance for the stdlib unlinkat helper."""
import io
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch


class ScopedDeleteTests(unittest.TestCase):
    @unittest.skipUnless(os.open in os.supports_dir_fd and os.unlink in os.supports_dir_fd, 'dir_fd required')
    def test_parent_swap_cannot_delete_outside_root(self):
        with tempfile.TemporaryDirectory(prefix='girru-unlinkat-') as temporary:
            base = Path(temporary).resolve()
            root = base / 'selected'
            owner = root / 'owner'
            outside = base / 'outside'
            owner.mkdir(parents=True)
            outside.mkdir()
            (owner / 'memory.md').write_text('REMOVE_SELECTED')
            (outside / 'memory.md').write_text('KEEP_OUTSIDE')
            identity = root.stat()
            payload = {'root': str(root), 'device': str(identity.st_dev), 'inode': str(identity.st_ino), 'files': ['owner/memory.md']}
            original = os.unlink
            swapped = False

            def swap_then_unlink(name, *args, **kwargs):
                nonlocal swapped
                if name == 'memory.md' and not swapped:
                    swapped = True
                    owner.rename(root / 'parked')
                    owner.symlink_to(outside, target_is_directory=True)
                return original(name, *args, **kwargs)

            helper = Path(__file__).resolve().parents[1] / 'python-scripts' / 'forget-files-native.py'
            capabilities = os.supports_dir_fd | {swap_then_unlink}
            with patch('sys.stdin', io.TextIOWrapper(io.BytesIO(json.dumps(payload).encode()))), patch('sys.stdout', io.StringIO()), patch.object(os, 'unlink', swap_then_unlink), patch.object(os, 'supports_dir_fd', capabilities):
                runpy.run_path(str(helper), run_name='__main__')
            self.assertTrue(swapped)
            self.assertEqual((outside / 'memory.md').read_text(), 'KEEP_OUTSIDE')
            self.assertFalse((root / 'parked' / 'memory.md').exists())

    def test_unlink_and_missing_retry_sync_parent_before_ack(self):
        with tempfile.TemporaryDirectory(prefix='girru-fsync-') as temporary:
            root = Path(temporary).resolve()
            file = root / 'memory.md'
            file.write_text('SYNTHETIC')
            identity = root.stat()
            payload = {'root': str(root), 'device': str(identity.st_dev), 'inode': str(identity.st_ino), 'files': ['memory.md']}
            helper = Path(__file__).resolve().parents[1] / 'python-scripts' / 'forget-files-native.py'
            for failing in (True, False):
                output = io.StringIO()
                with patch('sys.stdin', io.TextIOWrapper(io.BytesIO(json.dumps(payload).encode()))), patch('sys.stdout', output), patch('sys.stderr', io.StringIO()), patch.object(os, 'fsync', side_effect=OSError('synthetic fsync refusal') if failing else None) as sync:
                    if failing:
                        with self.assertRaises(SystemExit):
                            runpy.run_path(str(helper), run_name='__main__')
                        self.assertEqual(output.getvalue(), '')
                    else:
                        runpy.run_path(str(helper), run_name='__main__')
                        self.assertEqual(output.getvalue(), '{"removed":true}')
                    self.assertGreater(sync.call_count, 0)
                self.assertFalse(file.exists())

    def test_replacement_refuses_before_opening_shared_document(self):
        with tempfile.TemporaryDirectory(prefix='girru-no-replace-') as temporary:
            root = Path(temporary).resolve()
            file = root / 'owner.md'
            file.write_text('KEEP_OWNER_BYTES')
            identity = root.stat()
            payload = {'root': str(root), 'device': str(identity.st_dev), 'inode': str(identity.st_ino), 'files': [{'path': 'owner.md', 'beforeHash': 'synthetic', 'afterBase64': ''}]}
            helper = Path(__file__).resolve().parents[1] / 'python-scripts' / 'forget-files-native.py'
            output = io.StringIO()
            with patch('sys.stdin', io.TextIOWrapper(io.BytesIO(json.dumps(payload).encode()))), patch('sys.stdout', output), patch('sys.stderr', io.StringIO()):
                with self.assertRaises(SystemExit):
                    runpy.run_path(str(helper), run_name='__main__')
            self.assertEqual(output.getvalue(), '')
            self.assertEqual(file.read_text(), 'KEEP_OWNER_BYTES')


if __name__ == '__main__':
    unittest.main()
