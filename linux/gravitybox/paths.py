from __future__ import annotations

import json
import os
import shutil
from pathlib import Path


def xdg_data_home() -> Path:
    raw = os.environ.get("XDG_DATA_HOME", "").strip()
    return Path(raw) if raw else Path.home() / ".local" / "share"


def xdg_config_home() -> Path:
    raw = os.environ.get("XDG_CONFIG_HOME", "").strip()
    return Path(raw) if raw else Path.home() / ".config"


def xdg_cache_home() -> Path:
    raw = os.environ.get("XDG_CACHE_HOME", "").strip()
    return Path(raw) if raw else Path.home() / ".cache"


def xdg_state_home() -> Path:
    raw = os.environ.get("XDG_STATE_HOME", "").strip()
    return Path(raw) if raw else Path.home() / ".local" / "state"


def default_state_dir() -> Path:
    return xdg_data_home() / "GravityBox"


def default_cache_dir() -> Path:
    return xdg_cache_home() / "GravityBox"


def default_log_dir() -> Path:
    return xdg_state_home() / "GravityBox" / "logs"


def resolve_resource_root() -> Path:
    """Resolve packaged `/usr/lib/gravitybox` or repository root in development."""
    env_root = os.environ.get("GRAVITYBOX_RESOURCE_ROOT", "").strip()
    if env_root and Path(env_root).is_dir():
        return Path(env_root)
    pkg_dir = Path(__file__).resolve().parent
    # Packaged layout: /usr/lib/gravitybox/linux/gravitybox -> /usr/lib/gravitybox
    candidate = pkg_dir.parent.parent
    if (candidate / "core" / "dist" / "main.js").is_file():
        return candidate
    if (candidate / "dist" / "main.js").is_file():
        return candidate
    return candidate


def resolve_backend_entry(resource_root: Path) -> Path:
    packaged = resource_root / "core" / "dist" / "main.js"
    if packaged.is_file():
        return packaged
    dev = resource_root / "dist" / "main.js"
    if dev.is_file():
        return dev
    return packaged


def resolve_node_binary(resource_root: Path) -> Path | None:
    env_node = os.environ.get("GRAVITYBOX_NODE_BIN", "").strip()
    if env_node and os.access(env_node, os.X_OK):
        return Path(env_node)
    bundled = resource_root / "runtime" / "node"
    if bundled.is_file() and os.access(bundled, os.X_OK):
        return bundled
    found = shutil.which("node")
    return Path(found) if found else None


def resolve_assets_dir(resource_root: Path) -> Path:
    packaged = resource_root / "assets"
    if packaged.is_dir():
        return packaged
    return resource_root


def resolve_i18n_dir(resource_root: Path) -> Path:
    for candidate in (
        resource_root / "i18n",
        resource_root / "assets" / "i18n",
    ):
        if candidate.is_dir():
            return candidate
    return resource_root / "assets" / "i18n"


def resolve_icons_dir(resource_root: Path) -> Path:
    for candidate in (
        resource_root / "icons",
        resource_root / "assets" / "icons",
    ):
        if candidate.is_dir():
            return candidate
    return resource_root / "assets" / "icons"


def resolve_model_icons_dir(resource_root: Path) -> Path:
    for candidate in (
        resource_root / "model-icons",
        resource_root / "assets" / "model-icons",
    ):
        if candidate.is_dir():
            return candidate
    return resource_root / "assets" / "model-icons"


def resolve_app_icon_path(resource_root: Path) -> Path | None:
    for candidate in (
        resource_root / "assets" / "master-1024.png",
        resource_root / "icons" / "gravitybox.png",
        Path("/usr/share/icons/hicolor/256x256/apps/gravitybox.png"),
        Path("/usr/share/icons/hicolor/128x128/apps/gravitybox.png"),
        resource_root / "icons" / "menu-connected.png",
        resource_root / "assets" / "icons" / "menu-connected.png",
    ):
        if candidate.is_file():
            return candidate
    return None


def read_app_version(resource_root: Path) -> str:
    for candidate in (
        resource_root / "build-info.json",
        resource_root / "core" / "package.json",
        resource_root / "package.json",
    ):
        try:
            data = json.loads(candidate.read_text("utf-8"))
            ver = str(data.get("version") or "").strip()
            if ver:
                return ver
        except Exception:
            continue
    return "1.1.3"


def read_build_info(resource_root: Path) -> dict:
    try:
        return json.loads((resource_root / "build-info.json").read_text("utf-8"))
    except Exception:
        return {}


def linux_antigravity_candidates() -> list[Path]:
    out: list[Path] = []
    env_path = os.environ.get("GRAVITYBOX_APP_PATH", "").strip()
    if env_path:
        out.append(Path(env_path))
    out.extend([
        Path.home() / ".local" / "share" / "antigravity",
        Path("/usr/share/antigravity"),
        Path("/opt/Antigravity"),
        Path("/opt/antigravity"),
        Path("/usr/lib/antigravity"),
    ])
    seen: set[str] = set()
    uniq: list[Path] = []
    for p in out:
        key = str(p)
        if key not in seen:
            seen.add(key)
            uniq.append(p)
    return uniq


def find_antigravity_install() -> Path | None:
    for candidate in linux_antigravity_candidates():
        if (candidate / "resources" / "app.asar").is_file():
            return candidate
    return None
