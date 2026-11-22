from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

from PyQt5.QtCore import QObject, pyqtSignal

from .paths import (
    default_log_dir,
    resolve_backend_entry,
    resolve_node_binary,
)


class BackendError(RuntimeError):
    def __init__(self, message: str, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


class _CallbackRelay(QObject):
    done = pyqtSignal(object, object, object)

    def __init__(self) -> None:
        super().__init__()
        self.done.connect(self._dispatch)

    def _dispatch(self, cb: Any, result: Any, error: Any) -> None:
        if callable(cb):
            cb(result, error)


class BackendBridge(QObject):
    """Supervises the bundled Node 22 GravityBox core and communicates over `control.sock`."""

    backend_ready = pyqtSignal()
    backend_exited = pyqtSignal(str)
    MAX_REPLY_BYTES = 4_000_000

    def __init__(
        self,
        resource_root: Path,
        state_dir: Path,
        preferred_locale: str | None = None,
        parent: QObject | None = None,
    ) -> None:
        super().__init__(parent)
        self.resource_root = resource_root
        self.state_dir = state_dir
        self.preferred_locale = preferred_locale
        self.log_dir = default_log_dir()
        self._lock = threading.Lock()
        self._proc: subprocess.Popen[bytes] | None = None
        self._log_file: Any = None
        self._stopping = False
        self._generation = 0
        self._pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="gb-ipc")
        self._relay = _CallbackRelay()

    @property
    def socket_path(self) -> Path:
        return self.state_dir / "control.sock"

    @property
    def lock_path(self) -> Path:
        return self.state_dir / "backend.lock"

    @property
    def is_running(self) -> bool:
        with self._lock:
            return self._proc is not None and self._proc.poll() is None

    @staticmethod
    def _proc_cmdline(pid: int) -> list[str]:
        try:
            raw = Path(f"/proc/{pid}/cmdline").read_bytes()
            return [part.decode("utf-8", errors="replace") for part in raw.split(b"\0") if part]
        except Exception:
            return []

    def _cleanup_stale_backend(self) -> None:
        if self.socket_path.exists():
            try:
                self.send_sync({"command": "stop"}, timeout=1.2)
                deadline = time.monotonic() + 0.8
                while self.socket_path.exists() and time.monotonic() < deadline:
                    time.sleep(0.04)
            except Exception:
                pass
        if self.lock_path.is_file():
            try:
                lock_data = json.loads(self.lock_path.read_text("utf-8"))
                stale_pid = int(lock_data.get("pid") or 0)
            except Exception:
                stale_pid = 0
            if stale_pid > 0 and stale_pid != os.getpid():
                args = self._proc_cmdline(stale_pid)
                if any(a.endswith("/core/dist/main.js") or a.endswith("/dist/main.js") for a in args):
                    try:
                        os.kill(stale_pid, signal.SIGTERM)
                        deadline = time.monotonic() + 0.5
                        while time.monotonic() < deadline:
                            try:
                                os.kill(stale_pid, 0)
                            except ProcessLookupError:
                                break
                            time.sleep(0.03)
                        else:
                            os.kill(stale_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    except Exception:
                        pass

    def _open_log(self) -> Any:
        self.log_dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.log_dir, 0o700)
        except OSError:
            pass
        log_path = self.log_dir / "backend.log"
        if log_path.is_file() and log_path.stat().st_size > 1_048_576:
            archive_dir = self.log_dir / "archive"
            archive_dir.mkdir(parents=True, exist_ok=True)
            try:
                os.chmod(archive_dir, 0o700)
            except OSError:
                pass
            archive_name = f"backend-{int(time.time())}-{uuid.uuid4().hex[:8]}.log"
            log_path.rename(archive_dir / archive_name)
            archived = sorted(archive_dir.glob("backend-*.log"), key=lambda p: p.stat().st_mtime)
            for stale in archived[:-10]:
                stale.unlink(missing_ok=True)
        fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.chmod(log_path, 0o600)
        except OSError:
            pass
        return os.fdopen(fd, "ab")

    def start(self) -> None:
        self._stopping = False
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                return
        node_bin = resolve_node_binary(self.resource_root)
        entry = resolve_backend_entry(self.resource_root)
        if not node_bin or not node_bin.is_file():
            raise BackendError("Node 22 runtime binary is missing. Reinstall GravityBox.")
        if not entry.is_file():
            raise BackendError(f"GravityBox backend entry not found: {entry}")

        self.state_dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.state_dir, 0o700)
        except OSError:
            pass
        self._cleanup_stale_backend()

        log_handle = self._open_log()
        args = [str(node_bin), "--max-old-space-size=256", str(entry), "--state-dir", str(self.state_dir)]
        if self.preferred_locale and self.preferred_locale.strip():
            args.extend(["--locale", self.preferred_locale.strip()])

        env = os.environ.copy()
        proc = subprocess.Popen(
            args,
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=log_handle,
            cwd=str(self.resource_root),
            env=env,
            close_fds=True,
        )
        with self._lock:
            self._proc = proc
            self._log_file = log_handle
            self._generation += 1
            gen = self._generation

        threading.Thread(target=self._watch_process, args=(proc, gen), daemon=True).start()
        threading.Thread(target=self._wait_ready, args=(gen,), daemon=True).start()

    def _wait_ready(self, gen: int) -> None:
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            with self._lock:
                if self._generation != gen or self._stopping:
                    return
            try:
                res = self.send_sync({"command": "ping"}, timeout=1.0)
                if res.get("ok"):
                    self.backend_ready.emit()
                    return
            except Exception:
                time.sleep(0.12)

    def _watch_process(self, proc: subprocess.Popen[bytes], gen: int) -> None:
        code = proc.wait()
        with self._lock:
            stopping = self._stopping or self._generation != gen
            if self._proc is proc:
                self._proc = None
            if self._log_file is not None:
                try:
                    self._log_file.close()
                except Exception:
                    pass
                self._log_file = None
        if not stopping:
            self.backend_exited.emit(f"exit code {code}")

    def restart(self) -> None:
        self.stop()
        self.start()

    def stop(self) -> None:
        self._stopping = True
        try:
            if self.socket_path.exists():
                self.send_sync({"command": "stop"}, timeout=1.5)
        except Exception:
            pass
        with self._lock:
            proc = self._proc
            self._proc = None
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=1.0)
            except Exception:
                pass
        with self._lock:
            if self._log_file is not None:
                try:
                    self._log_file.close()
                except Exception:
                    pass
                self._log_file = None

    def send_sync(self, payload: dict[str, Any], timeout: float = 15.0) -> dict[str, Any]:
        sock_path = str(self.socket_path)
        if not os.path.exists(sock_path):
            raise BackendError("Backend is starting...", retryable=True)
        raw_req = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        try:
            try:
                sock.connect(sock_path)
            except OSError as exc:
                raise BackendError(f"Cannot connect to GravityBox backend: {exc}", retryable=True) from exc
            sock.sendall(raw_req)
            chunks: list[bytes] = []
            total = 0
            while True:
                data = sock.recv(65536)
                if not data:
                    break
                total += len(data)
                if total > self.MAX_REPLY_BYTES:
                    raise BackendError("Backend response exceeded size limit.")
                nl = data.find(b"\n")
                if nl != -1:
                    chunks.append(data[:nl])
                    break
                chunks.append(data)
            line = b"".join(chunks).decode("utf-8", errors="replace").strip()
            if not line:
                raise BackendError("Empty response from GravityBox backend.", retryable=True)
            return json.loads(line)
        except socket.timeout as exc:
            raise BackendError("Backend request timed out.", retryable=True) from exc
        finally:
            try:
                sock.close()
            except Exception:
                pass

    def call_async(
        self,
        payload: dict[str, Any],
        callback: Callable[[dict[str, Any] | None, Exception | None], None],
        timeout: float = 20.0,
    ) -> None:
        def _run() -> None:
            try:
                res = self.send_sync(payload, timeout=timeout)
                self._relay.done.emit(callback, res, None)
            except Exception as exc:
                self._relay.done.emit(callback, None, exc)

        self._pool.submit(_run)

    def shutdown(self) -> None:
        self.stop()
        self._pool.shutdown(wait=False, cancel_futures=True)
