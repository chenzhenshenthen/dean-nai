from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import launcher


class BackendCommandTest(unittest.TestCase):
    def test_release_package_prefers_bundled_backend(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            backend_dir = root / "nai-artist-library"
            backend_dir.mkdir()
            bundled = backend_dir / "dean-nai-backend.exe"
            bundled.touch()

            with patch("launcher.shutil.which", return_value=None):
                command, cwd = launcher.backend_command(root)

            self.assertEqual(command, [str(bundled)])
            self.assertEqual(cwd, backend_dir)

    def test_source_checkout_uses_python(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            backend_dir = root / "nai-artist-library"
            backend_dir.mkdir()

            with patch("launcher.shutil.which", return_value=r"C:\Python311\python.exe"):
                command, cwd = launcher.backend_command(root)

            self.assertEqual(command, [r"C:\Python311\python.exe", "app.py"])
            self.assertEqual(cwd, backend_dir)

    def test_missing_backend_explains_release_requirement(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "nai-artist-library").mkdir()

            with patch("launcher.shutil.which", return_value=None):
                with self.assertRaisesRegex(RuntimeError, "完整解压 Windows 发布包"):
                    launcher.backend_command(root)


if __name__ == "__main__":
    unittest.main()
