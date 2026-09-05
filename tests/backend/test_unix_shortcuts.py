import contextlib
import io
import os
from pathlib import Path
import plistlib
import shlex
import struct
import tempfile
import unittest
from unittest.mock import patch

from scripts import create_unix_shortcuts as shortcuts


ROOT = Path(__file__).resolve().parents[2]


class UnixShortcutTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        output = patch("sys.stdout", new=io.StringIO())
        output.start()
        self.addCleanup(output.stop)

    def test_linux_custom_locations_and_rerun(self):
        desktop = self.home / "Bureau"
        desktop.mkdir()
        data = self.home / "Application Data"
        with patch.dict(os.environ, {"XDG_DATA_HOME": str(data)}), \
                patch.object(shortcuts.shutil, "which", return_value="xdg-user-dir"), \
                patch.object(shortcuts.subprocess, "run") as run:
            run.return_value.stdout = str(desktop) + "\n"
            shortcuts.create_linux_shortcuts(ROOT, self.home)
            shortcuts.create_linux_shortcuts(ROOT, self.home)
        application = data / "applications/llama-gui.desktop"
        content = application.read_text(encoding="utf-8")
        self.assertEqual(content, (desktop / "llama-gui.desktop").read_text(encoding="utf-8"))
        self.assertIn("Terminal=false\n", content)
        self.assertIn("Exec=/bin/sh ", content)
        self.assertIn("mac_linux_silent_start.sh", content)
        self.assertNotIn("\r", content)
        run.assert_called_with(["xdg-user-dir", "DESKTOP"], capture_output=True,
                               text=True, check=True, timeout=10)
        if os.name != "nt":
            self.assertTrue((desktop / "llama-gui.desktop").stat().st_mode & 0o111)

    def test_linux_disabled_desktop_and_relative_data_home(self):
        with patch.dict(os.environ, {"XDG_DATA_HOME": "relative"}), \
                patch.object(shortcuts.shutil, "which", return_value="xdg-user-dir"), \
                patch.object(shortcuts.subprocess, "run") as run:
            run.return_value.stdout = str(self.home) + "\n"
            shortcuts.create_linux_shortcuts(ROOT, self.home)
        self.assertTrue((self.home / ".local/share/applications/llama-gui.desktop").is_file())
        self.assertFalse((self.home / "llama-gui.desktop").exists())

    def test_linux_without_xdg_tool_or_desktop(self):
        with patch.object(shortcuts.shutil, "which", return_value=None):
            self.assertIsNone(shortcuts.linux_desktop(self.home))
            (self.home / "Desktop").mkdir()
            self.assertEqual(shortcuts.linux_desktop(self.home), self.home / "Desktop")

    def test_desktop_escaping(self):
        self.assertEqual(shortcuts.desktop_argument('/tmp/My "GUI"/$x`x`\\100%/start.sh'),
                         '"/tmp/My \\\\"GUI\\\\"/\\\\$x\\\\`x\\\\`\\\\\\\\100%%/start.sh"')
        self.assertEqual(shortcuts.desktop_value("/tmp/a\nb\rc\td\\e"),
                         "/tmp/a\\nb\\rc\\td\\\\e")

    def test_macos_bundle_and_repeat_install(self):
        # No desktop needed for the Applications launcher (also works headlessly).
        shortcuts.create_macos_shortcuts(ROOT, self.home)
        shortcuts.create_macos_shortcuts(ROOT, self.home)
        contents = self.home / "Applications/Llama GUI.app/Contents"
        with (contents / "Info.plist").open("rb") as stream:
            info = plistlib.load(stream)
        executable = contents / "MacOS" / info["CFBundleExecutable"]
        self.assertEqual(info["CFBundleIdentifier"], shortcuts.BUNDLE_ID)
        self.assertEqual(info["CFBundlePackageType"], "APPL")
        self.assertEqual(shlex.split(executable.read_text(encoding="utf-8").splitlines()[1]),
                         ["exec", "/bin/sh", str(ROOT / "mac_linux_silent_start.sh")])
        self.assertEqual((contents / "Resources" / info["CFBundleIconFile"]).read_bytes(),
                         (ROOT / "assets/Llama-GUI.icns").read_bytes())
        self.assertNotIn(b"\r", executable.read_bytes())
        if os.name != "nt":
            self.assertTrue(executable.stat().st_mode & 0o111)

    @unittest.skipIf(os.name == "nt", "Windows may require privileges for directory symlinks")
    def test_macos_desktop_link_and_conflict(self):
        desktop = self.home / "Desktop"
        desktop.mkdir()
        shortcuts.create_macos_shortcuts(ROOT, self.home)
        shortcuts.create_macos_shortcuts(ROOT, self.home)
        shortcut = desktop / "Llama GUI.app"
        self.assertTrue(shortcut.is_symlink())
        self.assertEqual(shortcut.resolve(), self.home / "Applications/Llama GUI.app")
        shortcut.unlink()
        shortcut.write_text("personal item", encoding="utf-8")
        with self.assertRaises(FileExistsError):
            shortcuts.create_macos_shortcuts(ROOT, self.home)
        self.assertEqual(shortcut.read_text(encoding="utf-8"), "personal item")

    def test_macos_does_not_replace_unrelated_app(self):
        info = self.home / "Applications/Llama GUI.app/Contents/Info.plist"
        info.parent.mkdir(parents=True)
        original = plistlib.dumps({"CFBundleIdentifier": "another.app"})
        info.write_bytes(original)
        with self.assertRaises(ValueError):
            shortcuts.create_macos_shortcuts(ROOT, self.home)
        self.assertEqual(info.read_bytes(), original)

    def test_macos_rerun_repairs_incomplete_bundle(self):
        with patch.object(shortcuts.shutil, "copyfile", side_effect=OSError("interrupted")):
            with self.assertRaises(OSError):
                shortcuts.create_macos_shortcuts(ROOT, self.home)
        shortcuts.create_macos_shortcuts(ROOT, self.home)
        self.assertTrue((self.home / "Applications/Llama GUI.app/Contents/Resources/Llama-GUI.icns").is_file())

    def test_failure_is_reported(self):
        error = io.StringIO()
        with patch.object(shortcuts.sys, "platform", "linux"), \
                patch.object(shortcuts, "create_linux_shortcuts", side_effect=PermissionError("denied")), \
                contextlib.redirect_stderr(error):
            self.assertEqual(shortcuts.main(), 1)
        self.assertIn("denied", error.getvalue())

    def test_icons_share_the_existing_artwork(self):
        png = (ROOT / "assets/Llama-GUI.png").read_bytes()
        icns = (ROOT / "assets/Llama-GUI.icns").read_bytes()
        self.assertIn(png, (ROOT / "assets/Llama-GUI.ico").read_bytes())
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(struct.unpack_from(">II", png, 16), (256, 256))
        self.assertEqual(icns[:4], b"icns")
        self.assertEqual(struct.unpack_from(">I", icns, 4)[0], len(icns))
        self.assertEqual(icns[8:12], b"ic08")
        self.assertEqual(struct.unpack_from(">I", icns, 12)[0], len(icns) - 8)
        self.assertEqual(icns[16:], png)


if __name__ == "__main__":
    unittest.main()
