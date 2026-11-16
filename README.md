# easyPTO

Desktop application for working with road pavement layer projects. The frontend is built with React and TypeScript; application data and calculations are handled by the Rust backend. SQLite files are stored in the operating system's application data directory.

## Local development

Requirements: Node.js 24+, Rust stable with the `x86_64-pc-windows-msvc` target, Microsoft C++ Build Tools, and WebView2 Runtime.

```powershell
npm ci
npm run tauri dev
```

Create a Windows installer locally:

```powershell
npm run tauri build -- --target x86_64-pc-windows-msvc --bundles nsis
```

Release publication and auto-update setup are described in [docs/release.md](docs/release.md). Tauri updater keys are required for releases; a Windows Authenticode certificate is optional, so unsigned installers may show a SmartScreen warning.

The Rust backend owns the SQLite connection. The web UI calls backend commands through Tauri and does not access the database directly. Schema migrations are applied transactionally at application startup; `PRAGMA user_version` records the current schema version.

The Windows CI workflow builds an x64 NSIS installer and stores it as a workflow artifact. It does not publish releases or send project data anywhere.
