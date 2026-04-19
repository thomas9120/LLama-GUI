# TODO

## Cross-Platform Support (Linux/macOS)

- Add platform-aware binary naming (use `.exe` on Windows, no extension on Linux/macOS).
- Make release asset selection platform-aware (Windows/Linux/macOS, backend-specific asset patterns).
- Update install/status checks to use platform-specific binary names instead of hardcoded `.exe`.
- Use `os.pathsep` for PATH updates (`;` on Windows, `:` on Linux/macOS).
- Replace `os.startfile` with cross-platform folder open logic:
  - Windows: `os.startfile`
  - macOS: `open`
  - Linux: `xdg-open`
- Update UI/status text so it does not assume Windows executable naming.
