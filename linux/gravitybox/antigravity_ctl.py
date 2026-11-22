from __future__ import annotations

import os
import signal
import subprocess
import time
from pathlib import Path

from .paths import find_antigravity_install, xdg_config_home


def antigravity_executable() -> Path | None:
    install = find_antigravity_install()
    if not install:
        return None
    for name in ("antigravity", "Antigravity"):
        candidate = install / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None


def find_running_antigravity_pids() -> list[int]:
    install = find_antigravity_install()
    if not install:
        return []
    prefix = str(install.resolve()) + "/"
    pids: list[int] = []
    proc_root = Path("/proc")
    for entry in proc_root.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid == os.getpid():
            continue
        try:
            exe = os.readlink(entry / "exe")
            if exe.startswith(prefix):
                pids.append(pid)
        except OSError:
            continue
    return sorted(pids)


def is_antigravity_running() -> bool:
    return len(find_running_antigravity_pids()) > 0


def stop_antigravity_gracefully(timeout: float = 6.0) -> bool:
    pids = find_running_antigravity_pids()
    if not pids:
        return True
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except PermissionError:
            return False
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not find_running_antigravity_pids():
            return True
        time.sleep(0.15)
    return not find_running_antigravity_pids()


def launch_antigravity(with_debug_port: bool = True) -> tuple[bool, str]:
    exe = antigravity_executable()
    if not exe:
        return False, "Antigravity installation not found."
    args = [str(exe)]
    if with_debug_port:
        args.append("--remote-debugging-port=0")
    try:
        subprocess.Popen(
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
        return True, ""
    except Exception as exc:
        return False, str(exc)


def safe_relaunch_antigravity() -> tuple[bool, str]:
    if is_antigravity_running():
        if not stop_antigravity_gracefully(timeout=6.0):
            return False, "Antigravity is still running. Please close it manually first."
    return launch_antigravity(with_debug_port=True)


def autostart_desktop_path() -> Path:
    return xdg_config_home() / "autostart" / "gravitybox.desktop"


def is_autostart_enabled() -> bool:
    return autostart_desktop_path().is_file()


def set_autostart_enabled(enabled: bool, exec_cmd: str = "/usr/bin/gravitybox --minimized") -> None:
    path = autostart_desktop_path()
    if not enabled:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    content = (
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=GravityBox\n"
        "Comment=Antigravity Companion for Ubuntu\n"
        f"Exec={exec_cmd}\n"
        "Icon=gravitybox\n"
        "Terminal=false\n"
        "Categories=Development;Utility;\n"
        "X-GNOME-Autostart-enabled=true\n"
    )
    path.write_text(content, encoding="utf-8")


def open_path_or_url(target: str) -> None:
    try:
        subprocess.Popen(
            ["xdg-open", target],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception:
        pass
