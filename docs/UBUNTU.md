# GravityBox for Ubuntu / Debian (`.deb`)

GravityBox now supports Ubuntu / Debian desktop (`amd64` / `arm64`) as a native `.deb` package built on the same Node 22 core backend, zero-intrusion CDP localization/HUD runtime, and bilingual i18n assets as the macOS release.

## Architecture Overview

- **Shared Core Backend (`src/`, `runtime/`, `dict/`, `assets/`)**:
  - Cross-platform path & bundle abstraction in `src/platform.ts` (XDG directories on Linux; macOS `.app` / `~/Library` paths preserved identically on `darwin`).
  - Linux Antigravity installation detection (`~/.local/share/antigravity`, `/usr/share/antigravity`, `/opt/antigravity`, or `GRAVITYBOX_APP_PATH`).
  - Loopback CDP discovery with Linux socket-inode owner verification (handles inherited socket FDs without weakening loopback / `SO_REUSEPORT` checks).
  - Live `language_server` CSRF token extraction from both legacy `--csrf_token` and `>= 2.34.0` `/proc/<pid>/environ` (`ANTIGRAVITY_SERVER_CSRF_TOKEN`).
  - Freedesktop Secret Service (`org.freedesktop.Secret.Generic`, `service="gemini"`, `username="antigravity"`) keyring adapter compatible with `zalando/go-keyring` (secrets passed strictly via stdin/stdout, never in `argv`).
  - Built-in Node 22 `node:sqlite` (`DatabaseSync`) transaction fallback for `DatabaseTransaction` when `/usr/bin/sqlite3` is not installed.
- **Native Ubuntu Desktop UI (`linux/gravitybox/`)**:
  - PyQt5 desktop console with all 5 pages (`Overview / Accounts / Usage / Settings / About`), native `QSystemTrayIcon`, auto-detected light/dark theme, bilingual live hot-switching (`system` / `zh-Hans` / `en`), and interactive dialogs (`Manage Accounts`, `Auto-Switch Policy`, `Non-Destructive Cache Maintenance`, `Pricing Feed Sync`).
- **Self-Contained `.deb` Package (`tools/package-deb.mjs`)**:
  - Bundles a stripped Linux Node 22 runtime under `/usr/lib/gravitybox/runtime/node`, compiled backend scripts, dictionaries, i18n assets, hicolor icons, `.desktop` launcher, `DEBIAN/md5sums`, and SHA-256 sidecar.

## Installation (Ubuntu 22.04 / 24.04)

```bash
sudo apt install ./gravitybox_1.1.3_amd64.deb
```

Launch from the Ubuntu application launcher (**GravityBox**) or terminal:

```bash
gravitybox
```

Useful CLI flags:
- `gravitybox --minimized`: start minimized in the system tray
- `gravitybox --diagnose`: check live Antigravity CDP connection
- `gravitybox --version`: print version
- `gravitybox --check`: verify bundled Node 22 runtime and backend files

## Building & Testing Locally on Ubuntu

Requirements:
- Node.js `>=22.15.0 <23`
- `python3`, `python3-pyqt5`, `python3-pyqt5.qtsvg`, `python3-gi`, `gir1.2-secret-1`, `lsof`, `dpkg-dev`, `fakeroot`, `desktop-file-utils`

```bash
npm ci
npm run verify:linux
npm run package:deb
```

Artifacts are written to:
- `成品/gravitybox_<version>_<arch>.deb`
- `成品/gravitybox_<version>_<arch>.deb.sha256`
